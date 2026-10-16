import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent } from "@godmode/shared";
import { makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { buildSystemPrompt } from "../src/runner/prompt";
import { DEFAULT_SETTINGS, getSettings, updateSettings } from "../src/services/settings";
import { checkSettingsPatch } from "../src/services/settingsPatch";
import { agentSettingKeys } from "../src/services/agentSettings";

let env: TestEnv;
let agent: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-mode-");
  agent = await makeAgent({ name: "Helper", description: "test agent" });
});

afterAll(async () => {
  await env.close();
});

const prompt = () => buildSystemPrompt({ agent, settings: getSettings(), peers: [agent], browserAvailable: false });

describe("interface mode", () => {
  test("Professional is the default", () => {
    expect(DEFAULT_SETTINGS.general.mode).toBe("pro");
    expect(getSettings().general.mode).toBe("pro");
  });

  test("only easy and pro are accepted", () => {
    expect(() => checkSettingsPatch({ general: { mode: "easy" } }, () => {})).not.toThrow();
    expect(() => checkSettingsPatch({ general: { mode: "pro" } }, () => {})).not.toThrow();
    expect(() => checkSettingsPatch({ general: { mode: "simple" } }, () => {})).toThrow("general.mode");
  });

  test("agents may switch it for the human", () => {
    expect(agentSettingKeys()).toContain("general.mode");
  });

  test("in Easy mode agents answer in plain words; Professional prompts stay as they were", () => {
    expect(prompt()).not.toContain("Easy mode");
    updateSettings({ general: { mode: "easy" } });
    expect(prompt()).toContain("uses Godmode in Easy mode");
    expect(prompt()).toContain("plain everyday words");
    updateSettings({ general: { mode: "pro" } });
    expect(prompt()).not.toContain("Easy mode");
  });
});
