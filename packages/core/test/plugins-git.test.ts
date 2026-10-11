import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@godmode/shared";
import { modUpdateAvailable } from "@godmode/shared";
import { invocations, makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { startGitServer, type GitServer } from "./fixtures/git-server";
import { getConversation, startChat } from "../src/services/conversations";
import { listNotifications } from "../src/services/notifications";
import { waitForRun } from "../src/runner/runner";
import { callTool } from "../src/mcp/tools";
import { checkoutPath, checkoutsRoot, gitTarget } from "../src/mods/git";
import { checkModUpdates, deleteMod, getMod, installMod, listModCatalog, listMods, updateGitMod, updateMod } from "../src/mods/service";
import { HttpError } from "../src/util";
import type { RunContext } from "../src/types";

let env: TestEnv;
let agent: Agent;
let manager: Agent;
const servers: GitServer[] = [];

const manifest = (version: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "demo-plugin", version, description: "A plugin from a repository", author: { name: "Test" }, ...extra });

const PLUGIN = {
  ".claude-plugin/plugin.json": manifest("1.0.0", { userConfig: { greeting: { type: "string", title: "Greeting", description: "What it says", default: "hi" } } }),
  "skills/summarize/SKILL.md": "---\nname: summarize\ndescription: Sum things up\n---\nSum it up.\n",
  "skills/translate/SKILL.md": "---\nname: translate\ndescription: Translate\n---\nTranslate it.\n",
  "agents/reviewer.md": "---\nname: reviewer\ndescription: Reviews\n---\nReview.\n",
  "commands/hello.md": "Say hello.\n",
  "hooks/hooks.json": JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }),
  ".mcp.json": JSON.stringify({ mcpServers: { demo: { command: "node", args: ["server.js"] } } }),
};

function repo(files: Record<string, string>): GitServer {
  const server = startGitServer();
  server.commitFiles(files);
  servers.push(server);
  return server;
}

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return (err as HttpError).status;
  }
  throw new Error("expected it to fail");
}

async function chat(agentId: string) {
  const started = await startChat({ agentId, content: "hello" });
  const finished = await waitForRun(started.run.id, 20_000);
  const blocks = getConversation(started.conversation.id).messages.flatMap((m) => m.blocks);
  return { run: finished, blocks, invocation: invocations(env).at(-1)! };
}

function pluginDirs(args: string[]): string[] {
  return args.flatMap((arg, i) => (arg === "--plugin-dir" ? [args[i + 1]!] : []));
}

beforeAll(async () => {
  env = await setupEnv("godmode-plugins-git-");
  agent = await makeAgent({ name: "Coder" });
  manager = await makeAgent({ name: "Boss", permissions: { canManageAgents: true, allowDelegation: true } });
});

afterAll(async () => {
  for (const server of servers) server.close();
  await env.close();
});

describe("sources", () => {
  test("owner/repo, GitHub links and clone URLs", () => {
    expect(gitTarget("bradautomates/claude-video")).toEqual({
      url: "https://github.com/bradautomates/claude-video.git",
      repo: "bradautomates/claude-video",
      web: "https://github.com/bradautomates/claude-video",
      ref: null,
      path: "",
    });
    expect(gitTarget("https://github.com/Yeachan-Heo/oh-my-claudecode.git")).toMatchObject({ repo: "Yeachan-Heo/oh-my-claudecode", ref: null, path: "" });
    expect(gitTarget("https://github.com/acme/plugins/tree/main/plugins/lint")).toMatchObject({ repo: "acme/plugins", ref: "main", path: "plugins/lint" });
    expect(gitTarget("acme/plugins", "v2")).toMatchObject({ ref: "v2" });
    expect(gitTarget("https://gitlab.com/group/tools.git")).toMatchObject({ url: "https://gitlab.com/group/tools.git", repo: "tools", web: "https://gitlab.com/group/tools" });
    for (const bad of ["", "not a repo", "https://user:token@github.com/a/b.git", "file:///etc"]) expect(() => gitTarget(bad)).toThrow();
    expect(() => gitTarget("https://github.com/acme/plugins/tree/main/../../etc")).toThrow();
    expect(() => gitTarget("acme/plugins", "--upload-pack=x")).toThrow();
  });

  test("the catalog lists Claude Video and oh-my-claudecode", () => {
    expect(listModCatalog().map((e) => e.repo)).toEqual(["bradautomates/claude-video", "Yeachan-Heo/oh-my-claudecode"]);
  });
});

describe("installing from a repository", () => {
  test("a plugin is cloned at a commit, checked, inventoried and switched on", async () => {
    const server = repo(PLUGIN);
    const mod = await installMod({ source: server.url });
    expect(mod).toMatchObject({ name: "demo-plugin", title: "Demo plugin", origin: "git", enabled: true, needsReview: false, scope: "all" });
    expect(mod.source).toMatchObject({ url: server.url, repo: "app", ref: null, path: "", version: "1.0.0", checkError: null });
    expect(mod.source!.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(mod.source!.latestCommit).toBe(mod.source!.commit);
    expect(mod.digest).toBe(`git:${mod.source!.commit}`);
    expect(modUpdateAvailable(mod)).toBe(false);
    expect(mod.contents).toMatchObject({ skills: ["summarize", "translate"], agents: ["reviewer"], commands: ["hello"], hooks: ["SessionStart"], mcpServers: ["demo"], alwaysOnTokens: 1234 });
    expect(mod.check).toMatchObject({ ok: true, startsPrograms: true });
    // Its manifest and hooks are kept for reading and for its options; the code lies in the checkout.
    expect(Object.keys(mod.files).sort()).toEqual([".claude-plugin/plugin.json", ".mcp.json", "hooks/hooks.json"]);
    expect(mod.options.map((o) => o.key)).toEqual(["greeting"]);
    expect(existsSync(join(checkoutPath(mod.id, mod.source!.commit), "skills", "summarize", "SKILL.md"))).toBe(true);
    expect(readdirSync(join(checkoutsRoot(), mod.id))).toEqual([mod.source!.commit.slice(0, 12)]);

    // The same repository twice is one plugin.
    expect(await status(installMod({ source: server.url }))).toBe(409);
    deleteMod(mod.id);
  });

  test("a run loads the checkout itself, with the plugin's options", async () => {
    const server = repo(PLUGIN);
    const mod = await installMod({ source: server.url });
    await updateMod(mod.id, { values: { greeting: "hello there" } });
    const { run, invocation } = await chat(agent.id);
    expect(run.status).toBe("succeeded");
    const dir = checkoutPath(mod.id, mod.source!.commit);
    expect(pluginDirs(invocation.args)).toContain(dir);
    expect(invocation.settings?.pluginConfigs).toEqual({ "demo-plugin": { options: { greeting: "hello there" } } });
    // The checkout outlives the run: it is the installed version, not a copy.
    expect(existsSync(dir)).toBe(true);

    // Switched off, it isn't loaded.
    await updateMod(mod.id, { enabled: false });
    expect(pluginDirs((await chat(agent.id)).invocation.args)).not.toContain(dir);
    deleteMod(mod.id);
  });

  test("a checkout that is gone is cloned again at its commit before a run", async () => {
    const server = repo(PLUGIN);
    const mod = await installMod({ source: server.url });
    // A newer commit upstream doesn't change what runs.
    server.commitFiles({ "README.md": "# Changed\n" });
    rmSync(join(checkoutsRoot(), mod.id), { recursive: true, force: true });
    const { invocation } = await chat(agent.id);
    const dir = checkoutPath(mod.id, mod.source!.commit);
    expect(pluginDirs(invocation.args)).toContain(dir);
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("# App\n");
    deleteMod(mod.id);
  });

  test("uninstalling removes the plugin and its checkout", async () => {
    const server = repo(PLUGIN);
    const mod = await installMod({ source: server.url });
    deleteMod(mod.id);
    expect(listMods().find((m) => m.id === mod.id)).toBeUndefined();
    expect(existsSync(join(checkoutsRoot(), mod.id))).toBe(false);
  });

  test("a repository with several plugins asks which one", async () => {
    const market = {
      name: "acme",
      owner: { name: "Acme" },
      plugins: [
        { name: "lint", description: "Lints", source: "./plugins/lint" },
        { name: "format", description: "Formats", source: "./plugins/format" },
      ],
    };
    const server = repo({
      ".claude-plugin/marketplace.json": JSON.stringify(market),
      "plugins/lint/.claude-plugin/plugin.json": JSON.stringify({ name: "lint", version: "0.1.0" }),
      "plugins/lint/commands/lint.md": "Lint.\n",
      "plugins/format/.claude-plugin/plugin.json": JSON.stringify({ name: "format", version: "0.2.0" }),
      "plugins/format/commands/format.md": "Format.\n",
    });
    let details: unknown = null;
    try {
      await installMod({ source: server.url });
    } catch (err) {
      expect((err as HttpError).status).toBe(409);
      details = (err as HttpError).details;
    }
    expect(details).toEqual({ plugins: [{ name: "lint", description: "Lints" }, { name: "format", description: "Formats" }] });
    const mod = await installMod({ source: server.url, plugin: "format" });
    expect(mod).toMatchObject({ name: "format", source: { path: "plugins/format", version: "0.2.0" }, contents: { commands: ["format"] } });
    deleteMod(mod.id);
  });

  test("a repository without a plugin is refused and leaves nothing behind", async () => {
    const server = repo({ "src/index.ts": "export {}\n" });
    expect(await status(installMod({ source: server.url }))).toBe(400);
    expect(readdirSync(checkoutsRoot()).filter((id) => !listMods().some((m) => m.id === id))).toEqual([]);
  });
});

describe("updates", () => {
  test("a newer commit is found, installed on request, and the old checkout goes", async () => {
    const server = repo(PLUGIN);
    const mod = await installMod({ source: server.url });
    const first = mod.source!.commit;

    const [same] = await checkModUpdates([mod.id]);
    expect(modUpdateAvailable(same!)).toBe(false);
    expect(same!.source!.checkedAt).not.toBeNull();

    const next = server.commitFiles({ ".claude-plugin/plugin.json": manifest("1.1.0", { userConfig: { greeting: { type: "string", title: "Greeting", default: "hi" } } }), "agents/writer.md": "Write.\n" });
    const [found] = await checkModUpdates([mod.id]);
    expect(found!.source).toMatchObject({ commit: first, latestCommit: next, checkError: null });
    expect(modUpdateAvailable(found!)).toBe(true);

    const updated = await updateGitMod(mod.id);
    expect(updated.source).toMatchObject({ commit: next, latestCommit: next, version: "1.1.0" });
    expect(updated.contents?.agents).toEqual(["reviewer", "writer"]);
    expect(updated.enabled).toBe(true);
    expect(modUpdateAvailable(updated)).toBe(false);
    expect(readdirSync(join(checkoutsRoot(), mod.id))).toEqual([next.slice(0, 12)]);

    // Already up to date: nothing changes.
    expect((await updateGitMod(mod.id)).source!.commit).toBe(next);
    deleteMod(mod.id);
  });

  test("a new version Claude Code refuses isn't installed", async () => {
    const server = repo(PLUGIN);
    const mod = await installMod({ source: server.url });
    server.commitFiles({ ".claude-plugin/plugin.json": manifest("2.0.0", { userConfig: { broken: { type: "string" } } }) });
    expect(await status(updateGitMod(mod.id))).toBe(409);
    const kept = getMod(mod.id);
    expect(kept.source).toMatchObject({ commit: mod.source!.commit, version: "1.0.0" });
    expect(readdirSync(join(checkoutsRoot(), mod.id))).toEqual([mod.source!.commit.slice(0, 12)]);
    deleteMod(mod.id);
  });

  test("a repository that can't be reached is noted, not thrown", async () => {
    const server = repo(PLUGIN);
    const mod = await installMod({ source: server.url });
    server.close();
    servers.splice(servers.indexOf(server), 1);
    const [checked] = await checkModUpdates([mod.id]);
    expect(checked!.source!.checkError).toBeTruthy();
    expect(modUpdateAvailable(checked!)).toBe(false);
    deleteMod(mod.id);
  });

  test("the files of a plugin from a repository aren't edited in place", async () => {
    const server = repo(PLUGIN);
    const mod = await installMod({ source: server.url });
    expect(await status(updateMod(mod.id, { files: mod.files }))).toBe(400);
    deleteMod(mod.id);
  });
});

describe("agents", () => {
  test("an agent's install arrives switched off for the human to review", async () => {
    const server = repo(PLUGIN);
    const ctx: RunContext = { runId: "run_plugins_boss", agentId: manager.id, conversationId: "cnv_plugins", workspaceId: manager.workspaceId, depth: 0 };
    const res = await callTool(ctx, "plugin_install", { source: server.url });
    expect(res.isError).toBeFalsy();
    const mod = listMods().find((m) => m.name === "demo-plugin")!;
    expect(mod).toMatchObject({ enabled: false, needsReview: true, createdBy: `agent:${manager.id}` });
    expect(listNotifications(1)[0]).toMatchObject({ title: "Boss installed the plugin Demo plugin", link: `/plugins?plugin=${mod.id}` });
    // The plugin_save tool doesn't write over it.
    expect((await callTool(ctx, "plugin_save", { plugin: mod.id, title: "x", files: mod.files })).isError).toBe(true);
    // Switching it on is the human's OK for that commit.
    expect((await updateMod(mod.id, { enabled: true, digest: mod.digest })).needsReview).toBe(false);
    deleteMod(mod.id);
  });
});
