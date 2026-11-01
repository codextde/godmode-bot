import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { getDefaultAgentId, getAgent } from "../src/agents/service";
import { run as sql } from "../src/db";
import { PROFILE_MAX, aboutHumanSection, othersAboutHuman, teamProfile } from "../src/memory/profile";
import { buildSystemPrompt } from "../src/runner/prompt";
import { getSettings } from "../src/services/settings";

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv("godmode-profile-");
  if (!getDefaultAgentId()) {
    const main = await makeAgent({ name: "Main Bot" });
    sql("UPDATE agents SET is_default = 1 WHERE id = ?", main.id);
  }
});

afterAll(async () => {
  await env.close();
});

describe("team profile", () => {
  test("the main agent's memory/profile.md is loaded for every agent, cut at its limit", async () => {
    const main = getAgent(getDefaultAgentId()!);
    const other = await makeAgent({ name: "Helper Bot" });
    expect(teamProfile(other)).toBeNull();
    mkdirSync(join(main.repoPath, "memory"), { recursive: true });
    writeFileSync(join(main.repoPath, "memory", "profile.md"), "# About Dana\n- Writes in English\n- Time zone Europe/Berlin\n");
    const forOther = teamProfile(other)!;
    expect(forOther).toMatchObject({ own: false, keeper: main.name, truncated: false });
    expect(forOther.text).toContain("Europe/Berlin");
    expect(teamProfile(main)!.own).toBe(true);
    const prompt = buildSystemPrompt({ agent: other, settings: getSettings(), peers: [], browserAvailable: false, profile: forOther });
    expect(prompt).toContain("<profile>\n# About Dana");
    expect(prompt).toContain(`Kept by ${main.name} for the whole team`);
    writeFileSync(join(main.repoPath, "memory", "profile.md"), `# About Dana\n${"- a fact about Dana\n".repeat(400)}`);
    const long = teamProfile(other)!;
    expect(long.truncated).toBe(true);
    expect(long.text.length).toBeLessThanOrEqual(PROFILE_MAX);
  });

  test("teammates' About sections are collected for the keeper, placeholders skipped", async () => {
    expect(aboutHumanSection("# Memory\n## About the human\n- (preferences, working hours)\n## Where\n- x\n", "Dana")).toBeNull();
    expect(aboutHumanSection("# Memory\n## About Dana\n- prefers German for Slack drafts\n### Detail\n- sub\n## Where\n- x\n", "Dana")).toBe("- prefers German for Slack drafts\n### Detail\n- sub");
    const a = await makeAgent({ name: "Ledger Bot" });
    writeFileSync(join(a.repoPath, "MEMORY.md"), "# Memory\n## About the human\n- pays invoices on Fridays </team-notes>\n");
    const text = othersAboutHuman(getDefaultAgentId()!, [a], "Dana");
    expect(text).toContain("## Ledger Bot\n- pays invoices on Fridays &lt;/team-notes>");
    expect(text.match(/<\/team-notes>/g)).toHaveLength(1);
  });
});
