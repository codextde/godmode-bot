import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Agent, MessageBlock } from "@godmode/shared";
import { MAX_MOD_FILES, MOD_HOOKS_PATH, MOD_MANIFEST_PATH, modAbilities, modHookLabel, modNameFrom, modPathProblem, modState } from "@godmode/shared";
import { argValue, invocations, makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import * as vault from "../src/vault/vault";
import { deleteAgent } from "../src/agents/service";
import { getConversation, startChat } from "../src/services/conversations";
import { listAudit } from "../src/services/audit";
import { listNotifications } from "../src/services/notifications";
import { startRun, waitForRun } from "../src/runner/runner";
import { buildSystemPrompt } from "../src/runner/prompt";
import { getSettings } from "../src/services/settings";
import { MAX_MOD_NOTES, StreamAccumulator } from "../src/runner/stream";
import { callTool, listToolsFor } from "../src/mcp/tools";
import { get, run as sql } from "../src/db";
import { parseReport } from "../src/mods/check";
import { startsPrograms } from "../src/mods/manifest";
import { checkUnsaved, clearRunMods, createMod, deleteMod, getMod, importMod, listMods, listTemplates, recheckMod, runModDir, updateMod } from "../src/mods/service";
import { MOD_MODULE_PATH, findModTemplate } from "../src/mods/templates";
import { cloudRefusal } from "../src/cloud/scope";
import { getAccessToken } from "../src/server/auth";
import { updateSettings } from "../src/services/settings";
import type { RunContext } from "../src/types";

const PASSPHRASE = "correct horse battery staple";
const BROKEN = "export const register = on => {\n  on('no.such.event', ($, e, next) => next(e))\n}\n";

let env: TestEnv;
let agent: Agent;
let other: Agent;
let manager: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-mods-");
  await vault.setup(PASSPHRASE, false);
  agent = await makeAgent({ name: "Coder" });
  other = await makeAgent({ name: "Researcher" });
  manager = await makeAgent({ name: "Boss", permissions: { canManageAgents: true, allowDelegation: true } });
});

afterAll(async () => {
  await env.close();
});

function removeAll() {
  for (const mod of listMods()) deleteMod(mod.id);
}

function manifest(name: string, userConfig?: Record<string, unknown>): string {
  return JSON.stringify({ name, version: "0.1.0", description: "A test mod", ...(userConfig ? { userConfig } : {}) });
}

function pluginFiles(name: string, source: string, userConfig?: Record<string, unknown>): Record<string, string> {
  return { [MOD_MANIFEST_PATH]: manifest(name, userConfig), [MOD_HOOKS_PATH]: '{ "modules": ["./register.ts"] }', [MOD_MODULE_PATH]: source };
}

const LOGGER = "export const register = on => {\n  on('tool.call', { tool: 'Bash' }, ($, e, next) => {\n    $.ui.log(e.command)\n    return next(e)\n  })\n}\n";

async function chat(agentId: string, content: string) {
  const started = await startChat({ agentId, content });
  const finished = await waitForRun(started.run.id, 20_000);
  const blocks = getConversation(started.conversation.id).messages.flatMap((m) => m.blocks);
  return { run: finished, blocks, invocation: invocations(env).at(-1)! };
}

function pluginDirs(args: string[]): string[] {
  return args.flatMap((arg, i) => (arg === "--plugin-dir" ? [args[i + 1]!] : []));
}

/** The mods a run loaded, in load order, by name. */
function loaded(args: string[]): string[] {
  return pluginDirs(args).map((dir) => basename(dir));
}

function notes(blocks: MessageBlock[]) {
  return blocks.filter((b): b is Extract<MessageBlock, { type: "notice" }> => b.type === "notice");
}

describe("gallery", () => {
  test("every mod of the gallery passes the check and is on once added", async () => {
    const templates = listTemplates();
    expect(templates.map((t) => t.id)).toEqual(["protect-files", "command-guard", "step-limit", "secret-scrubber", "turn-recap", "prompt-shortcuts"]);
    for (const template of templates) {
      const mod = await createMod({ templateId: template.id });
      expect(mod).toMatchObject({ name: template.id, title: template.title, origin: "template", templateId: template.id, enabled: true, needsReview: false, scope: "all" });
      expect(mod.check?.ok).toBe(true);
      expect(mod.check?.claudeVersion).toBe("9.9.9");
      expect(mod.check!.hooks.length).toBeGreaterThan(0);
      expect(mod.options).toEqual(template.options);
      expect(modState(mod)).toBe("on");
      expect(JSON.parse(mod.files[MOD_MANIFEST_PATH]!).name).toBe(template.id);
    }
    const guard = listMods().find((m) => m.name === "protect-files")!;
    expect(guard.check!.hooks).toContainEqual({ event: "tool.call", matcher: "tool=Edit" });
    expect(guard.options.find((o) => o.key === "mode")).toMatchObject({ choices: ["writes", "everything"], default: "writes", multiple: false });
    expect(guard.options.find((o) => o.key === "paths")).toMatchObject({ multiple: true, default: [".env", ".env.*", "*.pem", "id_rsa", "id_ed25519", "secrets"] });
    // A second copy gets a name of its own.
    expect((await createMod({ templateId: "protect-files" })).name).toBe("protect-files-2");
    await expect(createMod({ templateId: "nope" })).rejects.toThrow(/no mod "nope" in the gallery/);
    removeAll();
  });
});

describe("mods", () => {
  test("a mod from scratch starts switched off, with a manifest that carries its name", async () => {
    const mod = await createMod({ title: "Protect .env files!" });
    expect(mod).toMatchObject({ name: "protect-env-files", origin: "custom", enabled: false, createdBy: "user", icon: "puzzle" });
    expect(Object.keys(mod.files).sort()).toEqual([MOD_MANIFEST_PATH, MOD_HOOKS_PATH, MOD_MODULE_PATH].sort());
    expect(mod.check).toMatchObject({ ok: true, hooks: [{ event: "tool.call", matcher: "tool=Bash" }], calls: [], startsPrograms: false });
    expect(modState(mod)).toBe("off");

    const renamed = await updateMod(mod.id, { files: pluginFiles("something-else", LOGGER) });
    expect(JSON.parse(renamed.files[MOD_MANIFEST_PATH]!).name).toBe("protect-env-files");
    expect(renamed.check?.calls).toEqual(["$.ui.log"]);

    await expect(createMod({ title: "x", name: "protect-env-files" })).rejects.toThrow(/already is a mod named/);
    await expect(createMod({ title: "x", name: "Bad Name" })).rejects.toThrow(/lowercase letters/);
    await expect(createMod({ title: "x", name: "claude-mem" })).rejects.toThrow(/uses itself/);
    await expect(createMod({ title: "  " })).rejects.toThrow(/Give the mod a name/);
    expect(listAudit(20, "mod.create").some((a) => a.target === mod.id)).toBe(true);
    removeAll();
  });

  test("files stay inside the mod's folder", async () => {
    const mod = await createMod({ title: "Paths" });
    const withFile = (path: string) => updateMod(mod.id, { files: { ...mod.files, [path]: "x" } });
    await expect(withFile("../escape.ts")).rejects.toThrow(/isn't allowed/);
    await expect(withFile("/etc/passwd")).rejects.toThrow(/relative path/);
    await expect(withFile("hooks\\evil.ts")).rejects.toThrow(/relative path/);
    await expect(withFile(".claude-plugin/types/claude-code/index.d.ts")).rejects.toThrow(/written by Claude Code/);
    await expect(withFile("hooks/register.ts/inner.ts")).rejects.toThrow(/both a file and a folder/);
    // One name in two spellings is one file on macOS and Windows.
    await expect(withFile("Hooks/Register.ts")).rejects.toThrow(/there twice/);
    await expect(withFile("lib/Util.ts")).resolves.toBeDefined();
    await expect(updateMod(mod.id, { files: { "hooks/register.ts": "x" } })).rejects.toThrow(/needs its manifest/);
    await expect(updateMod(mod.id, { files: { ...mod.files, [MOD_MANIFEST_PATH]: "[]" } })).rejects.toThrow(/must be a JSON object/);
    const many = Object.fromEntries(Array.from({ length: MAX_MOD_FILES + 1 }, (_, i) => [`lib/f${i}.ts`, ""]));
    await expect(updateMod(mod.id, { files: { ...mod.files, ...many } })).rejects.toThrow(/at most/);
    await expect(updateMod(mod.id, { files: { ...mod.files, "big.txt": "x".repeat(200_001) } })).rejects.toThrow(/larger than/);
    expect(modPathProblem("hooks/lib/util.ts")).toBeNull();
    expect(modPathProblem("__proto__")).not.toBeNull();
    expect(modPathProblem("lib/__proto__/x.ts")).not.toBeNull();
    // Claude Code's own folder, in any spelling.
    expect(modPathProblem(".claude-plugin/Types/x.d.ts")).not.toBeNull();
    expect(modPathProblem(".claude-plugin/types")).not.toBeNull();
    expect(modPathProblem(".claude-plugin/typeset.md")).toBeNull();
    removeAll();
  });

  test("code Claude Code refuses can't be switched on, and says which file is wrong", async () => {
    const mod = await createMod({ title: "Breaks" });
    const broken = await updateMod(mod.id, { files: { ...mod.files, [MOD_MODULE_PATH]: BROKEN } });
    expect(broken.check?.ok).toBe(false);
    expect(broken.check?.errors[0]).toMatchObject({ where: MOD_MODULE_PATH });
    expect(broken.check?.errors[0]!.message).toContain('"no.such.event" is not an event');
    // The path of the scratch folder the check ran in never reaches the human.
    expect(broken.check?.errors[0]!.message).not.toContain(tmpdir());
    expect(modState(broken)).toBe("broken");
    await expect(updateMod(mod.id, { enabled: true })).rejects.toMatchObject({ status: 409 });

    const fixed = await updateMod(mod.id, { files: { ...mod.files, [MOD_MODULE_PATH]: LOGGER }, enabled: true });
    expect(fixed).toMatchObject({ enabled: true });
    expect(modState(fixed)).toBe("on");
    // A mod that is created switched on but doesn't pass stays off.
    const born = await createMod({ title: "Born broken", files: pluginFiles("born-broken", BROKEN), enabled: true });
    expect(born.enabled).toBe(false);
    removeAll();
  });

  test("switching on is the OK for the code that was read", async () => {
    const mod = await createMod({ title: "Read me", files: pluginFiles("read-me", LOGGER) });
    const seen = mod.digest;
    // An agent saves another version while the human still looks at the first.
    const changed = await updateMod(mod.id, { files: pluginFiles("read-me", `${LOGGER}// v2\n`) }, `agent:${manager.id}`);
    expect(changed.digest).not.toBe(seen);
    await expect(updateMod(mod.id, { enabled: true, digest: seen })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("code changed") });
    expect(getMod(mod.id)).toMatchObject({ enabled: false, needsReview: true });
    expect(await updateMod(mod.id, { enabled: true, digest: changed.digest })).toMatchObject({ enabled: true, needsReview: false });
    removeAll();
  });

  test("a gallery mod is Godmode's code as it ships; with other code it is the human's own", async () => {
    await expect(createMod({ templateId: "turn-recap", files: pluginFiles("turn-recap", LOGGER) })).rejects.toThrow(/Add the gallery mod first/);
    const mod = await createMod({ templateId: "turn-recap" });
    expect((await updateMod(mod.id, { values: { minSeconds: 5 } })).origin).toBe("template");
    const edited = await updateMod(mod.id, { files: { ...mod.files, [MOD_MODULE_PATH]: LOGGER } });
    expect(edited).toMatchObject({ origin: "custom", templateId: null, enabled: true });
    removeAll();
  });

  test("runs that start together ask Claude Code once about the same code", async () => {
    const validations = () => readFileSync(join(env.stateDir, "validations.jsonl"), "utf8").split("\n").filter(Boolean).length;
    const before = validations();
    const files = pluginFiles("same", `${LOGGER}// same\n`);
    const [a, b, c] = await Promise.all([checkUnsaved(files), checkUnsaved(files), checkUnsaved(files)]);
    expect([a?.ok, b?.ok, c?.ok]).toEqual([true, true, true]);
    expect(validations() - before).toBe(1);
  });

  test("unsaved files can be checked", async () => {
    expect(await checkUnsaved(pluginFiles("draft", LOGGER))).toMatchObject({ ok: true, calls: ["$.ui.log"] });
    expect(await checkUnsaved(pluginFiles("draft", BROKEN))).toMatchObject({ ok: false });
    await expect(checkUnsaved({ "../x": "y" })).rejects.toThrow(/isn't allowed/);
    expect(listMods()).toEqual([]);
  });

  test("options: values are checked against the manifest, secrets are sealed", async () => {
    const userConfig = {
      paths: { type: "string", multiple: true, title: "Paths", description: "d", default: ["a"] },
      limit: { type: "number", title: "Limit", description: "d", default: 3, min: 1, max: 10 },
      mode: { type: "string", title: "Mode", description: "d", options: ["soft", "hard"], default: "soft" },
      loud: { type: "boolean", title: "Loud", description: "d", default: false },
      apiKey: { type: "string", title: "API key", description: "d", sensitive: true, required: true },
    };
    const mod = await createMod({ title: "Options", files: pluginFiles("options", LOGGER, userConfig), enabled: true });
    expect(mod.enabled).toBe(false); // the required key has no value yet
    expect(mod.options.map((o) => o.key)).toEqual(["paths", "limit", "mode", "loud", "apiKey"]);
    expect(mod.values).toEqual({});
    await expect(updateMod(mod.id, { enabled: true })).rejects.toThrow(/Set "API key" under Options/);

    const set = await updateMod(mod.id, { values: { paths: ["x/**", "y"], limit: 7, mode: "hard", loud: true, apiKey: "sk-live-very-secret-1" } });
    expect(set.values).toEqual({ paths: ["x/**", "y"], limit: 7, mode: "hard", loud: true });
    expect(set.secretKeys).toEqual(["apiKey"]);
    expect(JSON.stringify(set)).not.toContain("sk-live-very-secret-1");
    const row = get<{ secrets_enc: string; option_values: string }>("SELECT secrets_enc, option_values FROM mods WHERE id = ?", mod.id)!;
    expect(row.secrets_enc).not.toContain("sk-live-very-secret-1");
    expect(row.option_values).not.toContain("sk-live-very-secret-1");
    expect(vault.redact("key sk-live-very-secret-1")).not.toContain("sk-live-very-secret-1");

    await expect(updateMod(mod.id, { values: { limit: 99 } })).rejects.toThrow(/"Limit" doesn't take that value/);
    await expect(updateMod(mod.id, { values: { mode: "medium" } })).rejects.toThrow(/"Mode"/);
    await expect(updateMod(mod.id, { values: { paths: "one" } })).rejects.toThrow(/"Paths"/);
    await expect(updateMod(mod.id, { values: { nope: 1 } })).rejects.toThrow(/no option "nope"/);
    expect((await updateMod(mod.id, { values: { limit: null } })).values).toEqual({ paths: ["x/**", "y"], mode: "hard", loud: true });

    expect((await updateMod(mod.id, { enabled: true })).enabled).toBe(true);
    const { invocation } = await chat(agent.id, "MOD_NOTES");
    expect(invocation.settings?.pluginConfigs).toEqual({ options: { options: { paths: ["x/**", "y"], mode: "hard", loud: true, apiKey: "sk-live-very-secret-1" } } });

    expect(JSON.stringify(listAudit(50, "mod.update"))).not.toContain("sk-live-very-secret-1");
    expect(JSON.stringify(listAudit(50, "mod.update"))).not.toContain("x/**");

    // A value the new code no longer declares is forgotten, and so is one that no longer fits.
    const slim = await updateMod(mod.id, { files: pluginFiles("options", LOGGER, { mode: { ...userConfig.mode, options: ["soft"] } }) });
    expect(slim.values).toEqual({});
    expect(slim.secretKeys).toEqual([]);
    expect(get<Record<string, unknown>>("SELECT option_values, secret_keys FROM mods WHERE id = ?", mod.id)).toEqual({ option_values: "{}", secret_keys: "[]" });
    // For good: code that declares the option again doesn't get the old secret.
    const again = await updateMod(mod.id, { files: pluginFiles("options", LOGGER, userConfig) });
    expect(again.secretKeys).toEqual([]);
    expect(again.values).toEqual({});
    await expect(updateMod(mod.id, { enabled: true })).rejects.toThrow(/Set "API key"/);
    await updateMod(mod.id, { values: { loud: true } });
    expect(getMod(mod.id).secretKeys).toEqual([]);

    // A list takes only its choices; a required option isn't filled by nothing.
    const picky = await createMod({
      title: "Picky",
      files: pluginFiles("picky", LOGGER, {
        tags: { type: "string", multiple: true, title: "Tags", description: "d", options: ["a", "b"], default: ["a"] },
        owner: { type: "string", title: "Owner", description: "d", required: true },
      }),
    });
    await expect(updateMod(picky.id, { values: { tags: ["a", "z"] } })).rejects.toThrow(/"Tags"/);
    await updateMod(picky.id, { values: { tags: ["b"], owner: "" } });
    await expect(updateMod(picky.id, { enabled: true })).rejects.toThrow(/Set "Owner"/);
    removeAll();
  });

  test("a mod runs for every agent, or for the ones it names", async () => {
    const mod = await createMod({ title: "Scoped", files: pluginFiles("scoped", LOGGER), enabled: true });
    expect(loaded((await chat(other.id, "hello")).invocation.args)).toEqual(["scoped"]);

    const scoped = await updateMod(mod.id, { scope: "agents", agentIds: [agent.id, agent.id] });
    expect(scoped.agentIds).toEqual([agent.id]);
    expect(loaded((await chat(agent.id, "hello")).invocation.args)).toEqual(["scoped"]);
    expect(loaded((await chat(other.id, "hello")).invocation.args)).toEqual([]);
    await expect(updateMod(mod.id, { agentIds: ["agt_missing"] })).rejects.toThrow(/does not exist/);

    // An agent that is gone doesn't widen the mod to everyone.
    const gone = await makeAgent({ name: "Temp" });
    await updateMod(mod.id, { agentIds: [gone.id] });
    await deleteAgent(gone.id);
    expect(getMod(mod.id)).toMatchObject({ scope: "agents", agentIds: [] });
    expect(loaded((await chat(agent.id, "hello")).invocation.args)).toEqual([]);
    removeAll();
  });
});

describe("runs", () => {
  test("load the mods that are on from a copy of their own: insight first, guardrails last", async () => {
    await createMod({ templateId: "command-guard" });
    const first = await createMod({ title: "First", files: pluginFiles("first", LOGGER), enabled: true });
    await createMod({ title: "Off", files: pluginFiles("off", LOGGER) });
    await createMod({ templateId: "turn-recap" });
    await updateMod(listMods().find((m) => m.name === "turn-recap")!.id, { values: { minSeconds: 0 } });
    const second = await createMod({ title: "Second", files: pluginFiles("second", LOGGER), enabled: true });

    // The recap sees every call, refused ones too; the guard judges a call after the others had their say.
    expect(loaded((await chat(agent.id, "hello")).invocation.args)).toEqual(["turn-recap", "first", "second", "command-guard"]);
    deleteMod(second.id);
    deleteMod(listMods().find((m) => m.name === "command-guard")!.id);

    const { invocation, blocks, run } = await chat(agent.id, "MOD_NOTES");
    expect(run.status).toBe("succeeded");
    expect(loaded(invocation.args)).toEqual(["turn-recap", "first"]);
    expect(invocation.settings?.pluginConfigs).toEqual({ "turn-recap": { options: { minSeconds: 0 } } });
    expect(invocation.settings?.hooks).toBeDefined();
    expect(invocation.env.CLAUDE_CODE_PLUGIN_DIR_WATCH).toBe("1");

    // The run had the mod's files, exactly, in a folder of its own that is gone once the run has ended.
    const copy = invocation.plugins.find((p) => basename(p.dir) === "first")!;
    expect(copy.dir).toBe(runModDir(run.id, "first"));
    expect(copy.module).toBe(LOGGER);
    expect(copy.files).toEqual(Object.keys(first.files).sort());
    expect(existsSync(join(env.dataDir, "mods", run.id))).toBe(false);

    // What a mod posts shows as a note from that mod; a status that stands is said once, a cleared one not at all.
    expect(notes(blocks).map((n) => [n.mod, n.text])).toEqual([
      ["turn-recap", 'loaded with {"minSeconds":0}'],
      ["turn-recap", "watching"],
      ["turn-recap", "done"],
      ["first", "loaded with {}"],
      ["first", "watching"],
      ["first", "done"],
    ]);

    // What a run wrote into its mods reaches no other run: the next one gets the code as it is kept.
    const next = await chat(other.id, "hello");
    expect(next.invocation.plugins.find((p) => basename(p.dir) === "first")!.dir).not.toBe(copy.dir);
    expect(next.invocation.plugins.find((p) => basename(p.dir) === "first")!.module).toBe(LOGGER);

    // What a crashed run left behind goes when Godmode starts.
    const left = runModDir("run_crashed", "first");
    mkdirSync(left, { recursive: true });
    clearRunMods();
    expect(existsSync(join(env.dataDir, "mods"))).toBe(false);
    removeAll();
  });

  test("a mod that no longer passes is left out, and the chat says so", async () => {
    const mod = await createMod({ title: "Was fine", files: pluginFiles("was-fine", LOGGER), enabled: true });
    // As after an update of Claude Code: the report on file is about another one, and this one refuses the code.
    sql("UPDATE mods SET files = ?, check_key = 'stale' WHERE id = ?", JSON.stringify(pluginFiles("was-fine", BROKEN)), mod.id);
    const { invocation, blocks, run } = await chat(agent.id, "hello");
    expect(run.status).toBe("succeeded");
    expect(loaded(invocation.args)).toEqual([]);
    const warning = notes(blocks).find((n) => n.level === "warning")!;
    expect(warning.text).toContain('The mod "Was fine" wasn\'t loaded');
    expect(warning.text).toContain("is not an event");
    expect(warning.mod).toBeUndefined();
    expect(getMod(mod.id).check?.ok).toBe(false);
    expect(modState(getMod(mod.id))).toBe("broken");

    // Switching on asks Claude Code first when the report on file is about other code.
    sql("UPDATE mods SET enabled = 0, check_report = ?, check_key = 'stale' WHERE id = ?", JSON.stringify({ ...mod.check, ok: true, errors: [] }), mod.id);
    expect(getMod(mod.id).check?.ok).toBe(true);
    await expect(updateMod(mod.id, { enabled: true })).rejects.toMatchObject({ status: 409 });
    expect(getMod(mod.id)).toMatchObject({ enabled: false, check: { ok: false } });

    // Fixed files are checked again by "Check again".
    sql("UPDATE mods SET files = ? WHERE id = ?", JSON.stringify(pluginFiles("was-fine", LOGGER)), mod.id);
    expect((await recheckMod(mod.id)).check?.ok).toBe(true);
    removeAll();
  });

  test("a row that came in with a path outside the folder never writes there", async () => {
    const mod = await createMod({ title: "Restored", files: pluginFiles("restored", LOGGER), enabled: true });
    sql("UPDATE mods SET files = ? WHERE id = ?", JSON.stringify({ ...pluginFiles("restored", LOGGER), "../escaped.ts": "planted", "../../escaped.ts": "planted" }), mod.id);
    expect(Object.keys(getMod(mod.id).files)).not.toContain("../escaped.ts");
    const { invocation } = await chat(agent.id, "hello");
    expect(invocation.plugins[0]!.files).toEqual([MOD_MANIFEST_PATH, MOD_HOOKS_PATH, MOD_MODULE_PATH].sort());
    expect(readdirSync(env.dataDir).filter((f) => f.includes("escaped"))).toEqual([]);

    // Columns that aren't what they should be (a mirrored or restored row) don't take the list down.
    sql("UPDATE mods SET option_values = 'null', secret_keys = '5', agent_ids = '{}', check_report = '[]' WHERE id = ?", mod.id);
    expect(getMod(mod.id)).toMatchObject({ values: {}, secretKeys: [], agentIds: [], check: null });
    expect((await chat(agent.id, "hello")).run.status).toBe("succeeded");
    removeAll();
  });

  test("a mod that floods the chat is cut off", async () => {
    await createMod({ title: "Flood", files: pluginFiles("flood", LOGGER), enabled: true });
    const { blocks } = await chat(agent.id, "MOD_NOTES_FLOOD");
    const all = notes(blocks);
    expect(all.filter((n) => n.mod).length).toBe(MAX_MOD_NOTES);
    expect(all.at(-1)).toMatchObject({ text: "More notes from mods aren't shown in this turn." });
    removeAll();
  });

  test("condition checks load no mods", async () => {
    await createMod({ title: "Everywhere", files: pluginFiles("everywhere", LOGGER), enabled: true });
    const started = await startChat({ agentId: agent.id, content: "hello" });
    await waitForRun(started.run.id, 20_000);
    const check = await startRun({ agentId: agent.id, conversationId: started.conversation.id, prompt: "hello", trigger: "check" });
    await waitForRun(check.id, 20_000);
    const [chatRun, checkRun] = invocations(env).slice(-2);
    expect(loaded(chatRun!.args)).toEqual(["everywhere"]);
    expect(loaded(checkRun!.args)).toEqual([]);
    expect(argValue(checkRun!, "--settings")).toBeNull();
    expect(checkRun!.env.CLAUDE_CODE_PLUGIN_DIR_WATCH).toBeNull();
    removeAll();
  });
});

describe("agents", () => {
  const ctx = (a: Agent): RunContext => ({ runId: `run_mods_${a.slug}`, agentId: a.id, conversationId: "cnv_mods", workspaceId: a.workspaceId, depth: 0 });
  const tool = async (a: Agent, name: string, args: unknown) => {
    const res = await callTool(ctx(a), name, args);
    return { isError: res.isError === true, text: res.content[0]!.text };
  };

  test("only the manager sees the mod tools, and is told how to write a mod", () => {
    const names = (a: Agent) => listToolsFor(a, ctx(a)).map((t) => t.name);
    expect(names(manager)).toEqual(expect.arrayContaining(["mods_list", "mod_save"]));
    expect(names(agent)).not.toContain("mods_list");
    expect(names(agent)).not.toContain("mod_save");

    const prompt = (a: Agent, mods: boolean) => buildSystemPrompt({ agent: a, settings: getSettings(), peers: [], browserAvailable: false, mods });
    expect(prompt(manager, true)).toContain("### Mods");
    expect(prompt(manager, true)).toContain("plugin-authoring");
    // A runner's setup is its controller's: nothing is drafted there.
    expect(prompt(manager, false)).not.toContain("### Mods");
    expect(prompt(agent, true)).not.toContain("### Mods");
  });

  test("an agent's mod is a draft: switched off and marked for review until the human switches it on", async () => {
    const saved = await tool(manager, "mod_save", { title: "Protect migrations", description: "Keeps migrations as they are.", files: pluginFiles("whatever", LOGGER) });
    expect(saved.isError).toBe(false);
    const summary = JSON.parse(saved.text) as { id: string; name: string; state: string; check: { ok: boolean } };
    expect(summary).toMatchObject({ name: "protect-migrations", state: "review", check: { ok: true } });
    const draft = getMod(summary.id);
    expect(draft).toMatchObject({ enabled: false, needsReview: true, origin: "agent", createdBy: `agent:${manager.id}` });
    expect(listNotifications(5)[0]).toMatchObject({ title: "Boss drafted a mod: Protect migrations", link: `/mods?mod=${draft.id}&tab=code` });
    expect(loaded((await chat(agent.id, "hello")).invocation.args)).toEqual([]);

    // A broken save comes back with what to fix; saving again over the draft repairs it.
    const broken = JSON.parse((await tool(manager, "mod_save", { mod: draft.id, title: "Protect migrations", files: pluginFiles("x", BROKEN) })).text);
    expect(broken).toMatchObject({ state: "broken", check: { ok: false } });
    expect(broken.next).toContain("Fix the errors");
    await tool(manager, "mod_save", { mod: "protect-migrations", title: "Protect migrations", files: pluginFiles("x", LOGGER) });

    const on = await updateMod(draft.id, { enabled: true });
    expect(on).toMatchObject({ enabled: true, needsReview: false });
    expect(modState(on)).toBe("on");

    // A running mod is the human's: an agent can't change it, and so can't switch a guard off by rewriting it.
    const refused = await tool(manager, "mod_save", { mod: draft.id, title: "Protect migrations", files: pluginFiles("x", "export const register = () => {}\n") });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("is switched on");
    expect(getMod(draft.id).files[MOD_MODULE_PATH]).toBe(LOGGER);
    expect(getMod(draft.id).enabled).toBe(true);

    const list = JSON.parse((await tool(manager, "mods_list", {})).text) as { name: string; files?: unknown }[];
    expect(list.map((m) => m.name)).toEqual(["protect-migrations"]);
    expect(list[0]!.files).toBeUndefined();
    expect(JSON.parse((await tool(manager, "mods_list", { mod: "protect-migrations" })).text).files[MOD_MODULE_PATH]).toBe(LOGGER);
    expect((await tool(manager, "mods_list", { mod: "nope" })).isError).toBe(true);
    removeAll();
  });

  test("an agent saves over its drafts only, and every version is told", async () => {
    const mine = await createMod({ title: "Mine", files: pluginFiles("mine", LOGGER) });
    const refused = await tool(manager, "mod_save", { mod: mine.id, title: "Mine", files: pluginFiles("mine", "export const register = () => {}\n") });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("not a draft of yours");
    expect(getMod(mine.id).files[MOD_MODULE_PATH]).toBe(LOGGER);

    // Nor a gallery guard the human paused for a moment.
    const guard = await createMod({ templateId: "command-guard" });
    await updateMod(guard.id, { enabled: false });
    expect((await tool(manager, "mod_save", { mod: "command-guard", title: "Command guard", files: pluginFiles("command-guard", LOGGER) })).isError).toBe(true);
    expect(getMod(guard.id)).toMatchObject({ origin: "template", needsReview: false });

    const draft = JSON.parse((await tool(manager, "mod_save", { title: "Told twice", files: pluginFiles("x", LOGGER) })).text) as { id: string };
    await tool(manager, "mod_save", { mod: draft.id, title: "Told twice", files: pluginFiles("x", `${LOGGER}// v2\n`) });
    expect(listNotifications(2).map((n) => n.title)).toEqual(["Boss changed its draft of the mod Told twice", "Boss drafted a mod: Told twice"]);
    removeAll();
  });

  test("code an agent changes in a draft the human had on before goes back to review", async () => {
    const mod = await createMod({ title: "Mine", files: pluginFiles("mine", LOGGER), enabled: true });
    await updateMod(mod.id, { enabled: false });
    const changed = await updateMod(mod.id, { files: pluginFiles("mine", `${LOGGER}// more\n`), enabled: true }, `agent:${manager.id}`);
    expect(changed).toMatchObject({ enabled: false, needsReview: true });
    removeAll();
  });
});

describe("import", () => {
  test("a plugin folder becomes a mod that is switched off", async () => {
    const folder = mkdtempSync(join(tmpdir(), "godmode-plugin-"));
    try {
      const files = pluginFiles("team-rules", LOGGER);
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(folder, path, ".."), { recursive: true });
        writeFileSync(join(folder, path), content);
      }
      mkdirSync(join(folder, ".claude-plugin", "types", "claude-code"), { recursive: true });
      writeFileSync(join(folder, ".claude-plugin", "types", "claude-code", "index.d.ts"), "// engine");
      mkdirSync(join(folder, ".git"));
      writeFileSync(join(folder, ".git", "config"), "[core]");
      symlinkSync("/etc/hosts", join(folder, "hosts"));

      const mod = await importMod(folder);
      expect(mod).toMatchObject({ name: "team-rules", title: "Team rules", origin: "import", enabled: false, description: "A test mod" });
      expect(Object.keys(mod.files).sort()).toEqual(Object.keys(files).sort());
      await expect(importMod(folder)).rejects.toMatchObject({ status: 409 });

      writeFileSync(join(folder, "sound.wav"), "RIFF\0\0");
      deleteMod(mod.id);
      await expect(importMod(folder)).rejects.toThrow(/isn't a text file/);
      await expect(importMod(tmpdir())).rejects.toThrow(/no Claude Code plugin/);
      await expect(importMod("relative/path")).rejects.toThrow(/full path/);
      await expect(importMod(join(folder, "missing"))).rejects.toThrow(/isn't a folder/);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("the API", () => {
  test("create, check, change, switch on for the code that was read, delete", async () => {
    const token = getAccessToken();
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${env.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    expect((await call("GET", "/api/mods/templates")).body).toHaveLength(6);
    expect((await call("POST", "/api/mods/check", { files: pluginFiles("draft", BROKEN) })).body.check).toMatchObject({ ok: false });

    const created = await call("POST", "/api/mods", { title: "Over HTTP", files: pluginFiles("over-http", LOGGER) });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect(created.body).toMatchObject({ name: "over-http", enabled: false, check: { ok: true } });
    expect((await call("GET", "/api/mods")).body.map((m: { name: string }) => m.name)).toEqual(["over-http"]);

    // The switch names the code that was on screen.
    const seen = created.body.digest as string;
    const changed = await call("PATCH", `/api/mods/${id}`, { files: pluginFiles("over-http", `${LOGGER}// v2\n`) });
    expect(changed.body.digest).not.toBe(seen);
    const stale = await call("PATCH", `/api/mods/${id}`, { enabled: true, digest: seen });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toContain("code changed");
    expect((await call("PATCH", `/api/mods/${id}`, { enabled: true, digest: changed.body.digest })).body).toMatchObject({ enabled: true });

    expect((await call("PATCH", `/api/mods/${id}`, { scope: "agents", agentIds: [agent.id], icon: "shield", title: "Renamed" })).body).toMatchObject({
      scope: "agents",
      agentIds: [agent.id],
      icon: "shield",
      title: "Renamed",
      name: "over-http",
    });
    expect((await call("PATCH", `/api/mods/${id}`, { icon: "rocket" })).status).toBe(400);
    expect((await call("POST", `/api/mods/${id}/check`)).body.check.ok).toBe(true);
    expect((await call("POST", "/api/mods/import", { path: tmpdir() })).status).toBe(400);
    expect((await call("DELETE", `/api/mods/${id}`)).body).toEqual({ ok: true });
    expect((await call("GET", `/api/mods/${id}`)).status).toBe(404);
  });
});

describe("what a mod can do", () => {
  const check = (hooks: string[], calls: string[], programs = false) => ({ hooks: hooks.map((event) => ({ event, matcher: null })), calls, startsPrograms: programs });

  test("abilities come from what the mod hooks and calls, sensitive ones last", () => {
    expect(modAbilities(check(["tool.call"], [])).map((a) => a.id)).toEqual(["tools"]);
    const reach = modAbilities(check(["session.append", "turn.complete"], ["$.ui.log", "$.fs.write", "$.process.run", "$.http.fetch", "$.env.get"], true));
    expect(reach.map((a) => [a.id, a.level])).toEqual([
      ["transcript", "normal"],
      ["turns", "normal"],
      ["notes", "normal"],
      ["files-write", "sensitive"],
      ["process", "sensitive"],
      ["network", "sensitive"],
      ["env", "sensitive"],
      ["programs", "sensitive"],
    ]);
    expect(modAbilities(check(["ui.render"], ["$.ui.open"])).map((a) => a.id)).toEqual(["panes"]);
  });

  test("hooks read in words, names come from titles", () => {
    expect(modHookLabel({ event: "tool.call", matcher: "tool=Bash" })).toBe("Bash calls");
    expect(modHookLabel({ event: "tool.call", matcher: null })).toBe("Every tool call");
    expect(modHookLabel({ event: "session.append", matcher: "door=tool-result" })).toBe("Conversation rows");
    expect(modHookLabel({ event: "made.up", matcher: null })).toBe("made.up");
    expect(modNameFrom("Über-Guard 2000!")).toBe("uber-guard-2000");
    expect(modNameFrom("123")).toBe("mod");
    expect(modNameFrom("!!!")).toBe("mod");
  });

  test("the validator's report: matchers with commas, command hooks, paths cleaned", () => {
    const dir = "/tmp/godmode-mod-x/panes";
    const report = {
      success: true,
      manifest: { file: `${dir}/.claude-plugin/plugin.json`, errors: [], warnings: [{ path: "author", message: "No author information provided", code: null }, { path: "bogus", message: "Unknown field 'bogus'", code: null }] },
      contents: [
        {
          file: `${dir}/hooks/hooks.json`,
          type: "hooks",
          errors: [],
          warnings: [],
          notes: ["./register.tsx hooks: session.start, ui.render{component=Pane, requestId=probe}, tool.call{tool=Bash}", "./register.tsx calls: $.ui.open, $.ui.resolve"],
        },
      ],
    };
    const files = { [MOD_MANIFEST_PATH]: "{}", [MOD_HOOKS_PATH]: '{ "modules": ["./register.tsx"], "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }] } }' };
    const parsed = parseReport(JSON.stringify(report), dir, files, "2.1.289")!;
    expect(parsed).toMatchObject({ ok: true, startsPrograms: true, claudeVersion: "2.1.289", calls: ["$.ui.open", "$.ui.resolve"] });
    expect(parsed.hooks).toEqual([
      { event: "session.start", matcher: null },
      { event: "ui.render", matcher: "component=Pane, requestId=probe" },
      { event: "tool.call", matcher: "tool=Bash" },
    ]);
    expect(parsed.warnings).toEqual([{ where: ".claude-plugin/plugin.json", message: "bogus: Unknown field 'bogus'" }]);
    expect(parseReport("not json", dir, files, null)).toBeNull();
    expect(parseReport("{}", dir, files, null)).toBeNull();
  });

  test("a call made through a helper function still counts, and a module that hooks nothing has no hooks", () => {
    const dir = "/tmp/godmode-mod-y/leaky";
    const notes = (hooks: string, calls: string) =>
      JSON.stringify({ success: true, manifest: { file: `${dir}/.claude-plugin/plugin.json`, errors: [], warnings: [] }, contents: [{ file: `${dir}/hooks/hooks.json`, errors: [], warnings: [], notes: [`./register.ts hooks: ${hooks}`, `./register.ts calls: ${calls}`] }] });
    // The validator's wording for a call reached through a function of the same file.
    const leaky = parseReport(notes("tool.call", "$.fs.read (via peek), $.fs.write (via save, keep), $.http.fetch (via send), $.settings.read (via conf), $.ui.log"), dir, {}, null)!;
    expect(leaky.calls).toEqual(["$.fs.read", "$.fs.write", "$.http.fetch", "$.settings.read", "$.ui.log"]);
    expect(modAbilities(leaky).filter((a) => a.level === "sensitive").map((a) => a.id)).toEqual(["files-read", "files-write", "network", "env"]);
    expect(parseReport(notes("nothing", "nothing on $"), dir, {}, null)).toMatchObject({ hooks: [], calls: [] });
  });

  test("a plugin that ships programs says so, however it declares them", () => {
    const manifest = (extra: Record<string, unknown>) => ({ [MOD_MANIFEST_PATH]: JSON.stringify({ name: "p", ...extra }) });
    const command = '{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }] } }';
    expect(startsPrograms({ ...manifest({}), [MOD_HOOKS_PATH]: '{ "modules": ["./register.ts"] }' })).toBe(false);
    expect(startsPrograms({ ...manifest({}), [MOD_HOOKS_PATH]: command })).toBe(true);
    expect(startsPrograms({ ...manifest({ hooks: "./extra/cmd.json" }), "extra/cmd.json": command })).toBe(true);
    expect(startsPrograms({ ...manifest({ hooks: ["./hooks/hooks.json", "./extra/cmd.json"] }), [MOD_HOOKS_PATH]: "{}", "extra/cmd.json": command })).toBe(true);
    expect(startsPrograms(manifest({ hooks: [{ Stop: [{ hooks: [{ type: "command", command: "x" }] }] }] }))).toBe(true);
    expect(startsPrograms(manifest({ hooks: { modules: ["./a.ts"] } }))).toBe(false);
    expect(startsPrograms(manifest({ mcpServers: { x: { command: "node" } } }))).toBe(true);
    expect(startsPrograms({ ...manifest({}), "bin/tool.sh": "#!/bin/sh" })).toBe(true);
    expect(startsPrograms({ ...manifest({}), ".mcp.json": "{}" })).toBe(true);
    expect(startsPrograms({ ...manifest({}), "monitors/monitors.json": "{}" })).toBe(true);
  });

  test("through Godmode Cloud, mods are read freely and changed only with the secrets switch", async () => {
    const may = (method: string, path: string, role: "owner" | "operator" | "viewer" = "operator") => cloudRefusal(method, path, role, async () => ({}));
    updateSettings({ cloud: { allowSecrets: false } });
    expect(await may("GET", "/api/mods")).toBeNull();
    expect(await may("GET", "/api/mods/templates", "viewer")).toBeNull();
    expect(await may("POST", "/api/mods/mod_x/check")).toBeNull();
    for (const [method, path] of [["POST", "/api/mods"], ["PATCH", "/api/mods/mod_x"], ["DELETE", "/api/mods/mod_x"], ["POST", "/api/mods/check"]] as const) {
      expect(await may(method, path)).not.toBeNull();
    }
    expect(await may("POST", "/api/mods/import", "owner")).toContain("on the computer itself");
    updateSettings({ cloud: { allowSecrets: true } });
    expect(await may("PATCH", "/api/mods/mod_x")).toBeNull();
    expect(await may("DELETE", "/api/mods/mod_x")).toBeNull();
    expect(await may("DELETE", "/api/mods/mod_x", "viewer")).not.toBeNull();
    expect(await may("POST", "/api/mods/import", "owner")).not.toBeNull();
    updateSettings({ cloud: { allowSecrets: false } });
  });

  test("the stream turns a mod's log, toast and status into notes", () => {
    const acc = new StreamAccumulator();
    const push = (subtype: string, text?: string) => acc.push({ type: "system", subtype, plugin: "guard", text });
    expect(push("ui_log", "  blocked rm -rf  ")).toBe(true);
    expect(push("ui_status", "3 blocked")).toBe(true);
    expect(push("ui_status", "3 blocked")).toBe(false);
    expect(push("ui_status")).toBe(false);
    expect(push("ui_status", "3 blocked")).toBe(true);
    expect(push("ui_toast", "x".repeat(3000))).toBe(true);
    // What the engine itself says about a mod that failed.
    expect(push("ui_log", "turn.complete hook skipped: threw Error: boom")).toBe(true);
    expect(push("ui_log", "hooks module did not load: /x/hooks/register.ts, compiled line 2")).toBe(true);
    expect(push("ui_panes")).toBe(false);
    expect(acc.push({ type: "system", subtype: "ui_log", text: "no plugin" })).toBe(false);
    const blocks = acc.blocks as Extract<MessageBlock, { type: "notice" }>[];
    expect(blocks.map((b) => [b.mod, b.level, b.text.length > 100 ? b.text.length : b.text])).toEqual([
      ["guard", "info", "blocked rm -rf"],
      ["guard", "info", "3 blocked"],
      ["guard", "info", "3 blocked"],
      ["guard", "info", 2001],
      ["guard", "warning", "turn.complete hook skipped: threw Error: boom"],
      ["guard", "warning", "hooks module did not load: /x/hooks/register.ts, compiled line 2"],
    ]);
  });
});
