import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@godmode/shared";
import { GLM_MODELS, modUpdateAvailable } from "@godmode/shared";
import { argValue, invocations, makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import * as vault from "../src/vault/vault";
import { startGitServer, type GitServer } from "./fixtures/git-server";
import { getConversation, startChat } from "../src/services/conversations";
import { listNotifications } from "../src/services/notifications";
import { waitForRun } from "../src/runner/runner";
import { callTool } from "../src/mcp/tools";
import { checkoutPath, checkoutsRoot, gitTarget } from "../src/mods/git";
import { checkModUpdates, deleteMod, getMod, installMod, listModCatalog, listMods, updateGitMod, updateMod } from "../src/mods/service";
import { run as sql } from "../src/db";
import { HttpError } from "../src/util";
import { blankModFiles } from "../src/mods/templates";
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
  ".mcp.json": JSON.stringify({ mcpServers: { demo: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js"] } } }),
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

async function chat(agentId: string, model: string | null = null) {
  const started = await startChat({ agentId, content: "hello", model });
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
    // Its MCP server goes into the run's own MCP config, under the name Claude Code gives a plugin's server.
    expect(invocation.pluginServers["plugin_demo-plugin_demo"]).toMatchObject({ command: "node", args: [join(dir, "server.js")], env: { CLAUDE_PLUGIN_ROOT: dir } });
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

  test("a plugin its marketplace describes gets a manifest with its name, and updates find it again", async () => {
    // No plugin.json anywhere: every entry names the root and says which skills are its own.
    const market = {
      name: "skills",
      plugins: [
        { name: "docs", description: "Document skills", source: "./", strict: false, skills: ["./skills/pdf"] },
        { name: "art", description: "Art skills", source: "./", strict: false, skills: ["./skills/draw"] },
      ],
    };
    const server = repo({
      ".claude-plugin/marketplace.json": JSON.stringify(market),
      "skills/pdf/SKILL.md": "---\nname: pdf\n---\nRead PDFs.\n",
      "skills/draw/SKILL.md": "---\nname: draw\n---\nDraw.\n",
    });
    expect(await status(installMod({ source: server.url }))).toBe(409);
    const mod = await installMod({ source: server.url, plugin: "docs" });
    expect(mod).toMatchObject({ name: "docs", description: "Document skills", source: { path: "" }, check: { ok: true } });
    const manifest = JSON.parse(readFileSync(join(checkoutPath(mod.id, mod.source!.commit), ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest).toEqual({ name: "docs", description: "Document skills", skills: ["./skills/pdf"] });
    // The other one of the same repository installs beside it.
    const art = await installMod({ source: server.url, plugin: "art" });
    expect(art.name).toBe("art");

    server.commitFiles({ "skills/pdf/SKILL.md": "---\nname: pdf\n---\nRead PDFs well.\n" });
    const updated = await updateGitMod(mod.id);
    expect(updated.source!.commit).not.toBe(mod.source!.commit);
    expect(updated.name).toBe("docs");
    deleteMod(mod.id);
    deleteMod(art.id);
  });

  test("links in a repository aren't followed out of the checkout", async () => {
    const secret = join(env.dataDir, "secret.json");
    writeFileSync(secret, JSON.stringify({ mcpServers: { stolen: { command: "leak" } } }));
    const server = repo({ ".claude-plugin/plugin.json": manifest("1.0.0"), "commands/hello.md": "Hi.\n" });
    server.commitLink(".mcp.json", secret);
    server.commitLink("skills", env.dataDir);
    const mod = await installMod({ source: server.url, enabled: false });
    expect(Object.keys(mod.files)).toEqual([".claude-plugin/plugin.json"]);
    expect(mod.contents).toMatchObject({ mcpServers: [], skills: [], commands: ["hello"] });
    expect(JSON.stringify(mod)).not.toContain("stolen");
    deleteMod(mod.id);
  });

  test("a record whose folder leads out of its checkout isn't loaded", async () => {
    const server = repo(PLUGIN);
    const mod = await installMod({ source: server.url });
    sql("UPDATE mods SET source = json_set(source, '$.path', '../../..') WHERE id = ?", mod.id);
    expect(getMod(mod.id).source).toBeNull();
    const { invocation, blocks } = await chat(agent.id);
    expect(pluginDirs(invocation.args)).toEqual([]);
    expect(blocks.some((b) => b.type === "notice" && b.text.includes("its record is damaged"))).toBe(true);
    deleteMod(mod.id);
  });

  test("an MCP server with skills for agents (server.json, .agents/skills) installs as a plugin that runs on Claude and on GLM", async () => {
    const server = repo({
      "server.json": JSON.stringify({
        name: "io.github.acme/rea",
        description: "Reverse engineer anything.",
        version: "6.4.0",
        packages: [{ registryType: "npm", identifier: "rea-agents", version: "6.4.0", transport: { type: "stdio" }, packageArguments: [{ type: "positional", value: "mcp" }] }],
      }),
      ".agents/skills/reverse-engineer-anything/SKILL.md": "---\nname: reverse-engineer-anything\ndescription: Reverse engineer\n---\nSee [native](references/native.md) and [the site](https://rea.tools/).\n",
      ".agents/skills/reverse-engineer-anything/references/native.md": "Native targets.\n",
      // The same skill linked for Claude Code counts once.
      ".claude/skills/reverse-engineer-anything/SKILL.md": "---\nname: reverse-engineer-anything\ndescription: Reverse engineer\n---\nSee [native](references/native.md).\n",
      // A skill for working on the repository itself: it leans on the repository's docs.
      ".agents/skills/rea-tool-design/SKILL.md": "---\nname: rea-tool-design\ndescription: Design tools\n---\nRead [the guide](../../../docs/tool-design.md).\n",
      "docs/tool-design.md": "Guide.\n",
    });
    const mod = await installMod({ source: server.url });
    expect(mod).toMatchObject({ name: "app", description: "Reverse engineer anything.", source: { version: "6.4.0" }, check: { ok: true, startsPrograms: true } });
    expect(mod.contents).toMatchObject({ skills: ["reverse-engineer-anything"], mcpServers: ["rea"] });
    const dir = checkoutPath(mod.id, mod.source!.commit);
    const written = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8"));
    expect(written).toEqual({
      name: "app",
      version: "6.4.0",
      description: "Reverse engineer anything.",
      skills: ["./.agents/skills/reverse-engineer-anything"],
      mcpServers: { rea: { command: "npx", args: ["-y", "rea-agents@6.4.0", "mcp"] } },
    });

    const opus = await chat(agent.id, "opus");
    expect(argValue(opus.invocation, "--model")).toBe("opus");
    expect(pluginDirs(opus.invocation.args)).toContain(dir);
    expect(opus.invocation.pluginServers["plugin_app_rea"]).toMatchObject({ command: "npx", args: ["-y", "rea-agents@6.4.0", "mcp"] });

    await vault.setup("correct horse battery staple", false);
    vault.setAppSecret("zai_api_key", "zai-test-key");
    const glm = await chat(agent.id, GLM_MODELS[0]!.id);
    expect(glm.run.status).toBe("succeeded");
    expect(argValue(glm.invocation, "--model")).toBe(GLM_MODELS[0]!.id);
    expect(pluginDirs(glm.invocation.args)).toContain(dir);
    expect(glm.invocation.pluginServers["plugin_app_rea"]).toMatchObject({ command: "npx", args: ["-y", "rea-agents@6.4.0", "mcp"] });

    // A checkout cloned again (a runner, a restored backup) gets its manifest back.
    rmSync(join(checkoutsRoot(), mod.id), { recursive: true, force: true });
    const again = await chat(agent.id, "opus");
    expect(again.invocation.pluginServers["plugin_app_rea"]).toMatchObject({ command: "npx" });
    expect(JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8"))).toEqual(written);
    deleteMod(mod.id);
  });

  test("an MCP server that needs a setting turns it into an option; a remote one connects by its address", async () => {
    const server = repo({
      "server.json": JSON.stringify({
        name: "io.github.acme/weather",
        version: "1.2.0",
        packages: [
          { registryType: "oci", identifier: "acme/weather", transport: { type: "stdio" } },
          {
            registryType: "pypi",
            identifier: "acme-weather",
            transport: { type: "stdio" },
            runtimeArguments: [{ type: "named", name: "--python", value: "3.12" }],
            packageArguments: [{ type: "named", name: "--units-file", isRequired: false }],
            environmentVariables: [{ name: "WEATHER_KEY", description: "API key", isRequired: true, isSecret: true }, { name: "UNITS", default: "metric" }],
          },
        ],
      }),
    });
    const mod = await installMod({ source: server.url });
    const written = JSON.parse(readFileSync(join(checkoutPath(mod.id, mod.source!.commit), ".claude-plugin", "plugin.json"), "utf8"));
    expect(written.mcpServers).toEqual({
      weather: { command: "uvx", args: ["--python", "3.12", "acme-weather==1.2.0", "--units-file"], env: { WEATHER_KEY: "${user_config.WEATHER_KEY}", UNITS: "metric" } },
    });
    expect(written.userConfig).toEqual({ WEATHER_KEY: { type: "string", title: "WEATHER_KEY", description: "API key", required: true, sensitive: true } });
    // The key is needed before it can be switched on.
    expect(mod.enabled).toBe(false);
    deleteMod(mod.id);

    // Nothing it could start as it stands: a package from another registry, an argument only the human can give, a remote that needs a token.
    const unusable = repo({
      "server.json": JSON.stringify({
        name: "io.github.acme/private",
        version: "1.0.0",
        packages: [
          { registryType: "npm", registryBaseUrl: "https://npm.acme.internal", identifier: "private-mcp", transport: { type: "stdio" } },
          { registryType: "npm", identifier: "-c", transport: { type: "stdio" } },
          { registryType: "npm", identifier: "needs-arg", transport: { type: "stdio" }, packageArguments: [{ type: "positional", valueHint: "dir", isRequired: true }] },
        ],
        remotes: [{ type: "streamable-http", url: "https://mcp.acme.dev/{tenant}/mcp" }, { type: "sse", url: "https://mcp.acme.dev/sse", headers: [{ name: "Authorization", isRequired: true }] }],
      }),
    });
    expect(await status(installMod({ source: unusable.url }))).toBe(400);

    const remote = repo({ "server.json": JSON.stringify({ name: "io.github.acme/docs", remotes: [{ type: "streamable-http", url: "https://mcp.acme.dev/mcp" }] }) });
    const hosted = await installMod({ source: remote.url });
    expect(JSON.parse(readFileSync(join(checkoutPath(hosted.id, hosted.source!.commit), ".claude-plugin", "plugin.json"), "utf8")).mcpServers).toEqual({
      docs: { type: "http", url: "https://mcp.acme.dev/mcp" },
    });
    deleteMod(hosted.id);
  });

  test("a plugin of its own keeps its own parts: no skills from .claude/skills, no server from server.json", async () => {
    const server = repo({
      "skills/lint/SKILL.md": "---\nname: lint\ndescription: Lint\n---\nLint.\n",
      ".claude/skills/release/SKILL.md": "---\nname: release\ndescription: Release this repo\n---\nRelease.\n",
      "server.json": JSON.stringify({ name: "io.github.acme/lint", version: "1.0.0", packages: [{ registryType: "npm", identifier: "lint-mcp", transport: { type: "stdio" } }] }),
    });
    const mod = await installMod({ source: server.url, enabled: false });
    expect(mod.contents).toMatchObject({ skills: ["lint"], mcpServers: [] });
    expect(JSON.parse(readFileSync(join(checkoutPath(mod.id, mod.source!.commit), ".claude-plugin", "plugin.json"), "utf8"))).toEqual({ name: "app" });
    deleteMod(mod.id);
  });

  test("a restored checkout gets the manifest that was installed, even when the repository would read differently now", async () => {
    const market = { name: "acme", plugins: [{ name: "docs", description: "Docs", source: "./plugins/docs", skills: ["./extra"] }] };
    const server = repo({ ".claude-plugin/marketplace.json": JSON.stringify(market), "plugins/docs/extra/SKILL.md": "---\nname: extra\n---\nExtra.\n" });
    const mod = await installMod({ source: server.url });
    const file = () => join(checkoutPath(mod.id, mod.source!.commit), "plugins", "docs", ".claude-plugin", "plugin.json");
    const installed = readFileSync(file(), "utf8");
    expect(JSON.parse(installed)).toMatchObject({ name: "docs", skills: ["./extra"] });
    rmSync(join(checkoutsRoot(), mod.id), { recursive: true, force: true });
    const { run } = await chat(agent.id);
    expect(run.status).toBe("succeeded");
    expect(readFileSync(file(), "utf8")).toBe(installed);
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

  test("following an annotated tag: no update while it names the installed commit", async () => {
    const server = repo(PLUGIN);
    server.tag("v1");
    const mod = await installMod({ source: server.url, ref: "v1" });
    // The branch moves on, the tag doesn't.
    server.commitFiles({ "README.md": "# Later\n" });
    const [checked] = await checkModUpdates([mod.id]);
    expect(checked!.source).toMatchObject({ ref: "v1", commit: mod.source!.commit, latestCommit: mod.source!.commit });
    expect(modUpdateAvailable(checked!)).toBe(false);
    expect((await updateGitMod(mod.id)).source!.commit).toBe(mod.source!.commit);
    expect(existsSync(join(checkoutPath(mod.id, mod.source!.commit), "skills", "summarize", "SKILL.md"))).toBe(true);
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
    // A manager switches it on itself, for the agents that need it, and the human is told.
    expect((await callTool(ctx, "plugin_update", { plugin: mod.name, runsFor: ["nobody"] })).isError).toBe(true);
    const on = await callTool(ctx, "plugin_update", { plugin: mod.name, enabled: true, runsFor: ["Coder"] });
    expect(on.isError).toBeFalsy();
    expect(getMod(mod.id)).toMatchObject({ enabled: true, needsReview: false, scope: "agents", agentIds: [agent.id] });
    expect(listNotifications(1)[0]).toMatchObject({ title: "Boss changed the plugin Demo plugin", body: "Switched it on, it runs for Coder." });
    expect(pluginDirs((await chat(agent.id)).invocation.args)).toContain(checkoutPath(mod.id, mod.source!.commit));
    expect(pluginDirs((await chat(manager.id)).invocation.args)).not.toContain(checkoutPath(mod.id, mod.source!.commit));
    expect((await callTool(ctx, "plugin_update", { plugin: mod.id, runsFor: "all" })).isError).toBeFalsy();
    expect(getMod(mod.id).scope).toBe("all");
    expect((await callTool(ctx, "plugin_update", { plugin: mod.id, enabled: false })).isError).toBeFalsy();
    expect(getMod(mod.id).enabled).toBe(false);
    // Hook code an agent wrote still waits for the human.
    const draft = JSON.parse((await callTool(ctx, "plugin_save", { title: "Guard", files: blankModFiles("guard", "Guard") })).content[0]!.text) as { id: string };
    const refused = await callTool(ctx, "plugin_update", { plugin: draft.id, enabled: true });
    expect(refused.isError).toBe(true);
    expect(getMod(draft.id).enabled).toBe(false);
    deleteMod(draft.id);
    // A plain agent has no such tool.
    const plain: RunContext = { ...ctx, runId: "run_plugins_coder", agentId: agent.id };
    expect((await callTool(plain, "plugin_update", { plugin: mod.id, enabled: true })).isError).toBe(true);
    // Switching it on is the human's OK for that commit.
    expect((await updateMod(mod.id, { enabled: true, digest: mod.digest })).needsReview).toBe(false);
    deleteMod(mod.id);
  });
});
