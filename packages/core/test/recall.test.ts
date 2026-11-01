import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent } from "@godmode/shared";
import { makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { addMessage, createConversation } from "../src/services/conversations";
import { recallRead, recallSearch } from "../src/memory/recall";

let env: TestEnv;
let agent: Agent;
let other: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-recall-");
  agent = await makeAgent({ name: "Recall Bot" });
  other = await makeAgent({ name: "Other Bot" });
});

afterAll(async () => {
  await env.close();
});

function chat(owner: Agent, title: string, messages: [string, string][], opts: { private?: boolean } = {}) {
  const c = createConversation({ agentId: owner.id, title, private: opts.private });
  return { id: c.id, ids: messages.map(([role, content]) => addMessage({ conversationId: c.id, role: role as "user" | "assistant", content }).id) };
}

describe("recall", () => {
  test("finds the agent's own messages, never other agents' or private chats", () => {
    const own = chat(agent, "Kontist fees", [
      ["user", "Download the Kontist fee invoice for October"],
      ["assistant", "Saved the Kontist invoice PDF to workspace/finance/kontist-2026-10.pdf"],
    ]);
    chat(other, "Kontist elsewhere", [["user", "Kontist invoice for the other agent"]]);
    chat(agent, "Secret plans", [["user", "Kontist invoice in a private chat"]], { private: true });
    const { hits } = recallSearch(agent.id, "kontist invoice");
    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.conversationId === own.id)).toBe(true);
    expect(hits.map((h) => h.conversation)).toContain("Kontist fees");
    expect(hits.some((h) => h.snippet.includes("kontist-2026-10.pdf"))).toBe(true);
  });

  test("falls back to a typo fix, then to any of the keywords", () => {
    chat(agent, "Hetzner", [["user", "The Hetzner server invoice number is R0012345"]]);
    const typo = recallSearch(agent.id, "hetzer");
    expect(typo.hits.length).toBeGreaterThan(0);
    const loose = recallSearch(agent.id, "hetzner nonexistentword");
    expect(loose.loose).toBe(true);
    expect(loose.hits[0]!.snippet).toContain("Hetzner");
    expect(recallSearch(agent.id, "zzzqqq").hits).toEqual([]);
  });

  test("reads a message with its neighbours, only from the agent's own conversations", () => {
    const c = chat(agent, "Trip", [
      ["user", "Book the train to Leipzig"],
      ["assistant", "Booked ICE 1234 for Friday"],
      ["user", "Thanks"],
    ]);
    const text = recallRead(agent.id, c.ids[1]!, 1)!;
    expect(text).toContain("# Trip");
    expect(text.indexOf("Book the train")).toBeLessThan(text.indexOf("Booked ICE 1234"));
    expect(text.indexOf("Booked ICE 1234")).toBeLessThan(text.indexOf("Thanks"));
    expect(recallRead(other.id, c.ids[1]!)).toBeNull();
  });
});
