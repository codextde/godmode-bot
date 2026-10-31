import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { searchSegments, type Agent } from "@godmode/shared";
import { makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { run as sql } from "../src/db";
import { addMessage, createConversation, deleteConversation, listConversations, updateConversation } from "../src/services/conversations";
import { createTask, updateTask } from "../src/tasks/service";
import { chunkMarkdown, makeSnippet, rebuildSearchIndex, refreshNotes, search } from "../src/services/search";
import { parseQuery } from "../src/services/searchQuery";

let env: TestEnv;
let agent: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-search-");
  agent = await makeAgent({ name: "Search Bot" });
});

afterAll(async () => {
  await env.close();
});

function chat(title: string, ...messages: string[]) {
  const c = createConversation({ agentId: agent.id, title });
  for (const content of messages) addMessage({ conversationId: c.id, role: "user", content });
  return c;
}

describe("query parsing", () => {
  test("folds case and accents, splits on punctuation, keeps quoted phrases", () => {
    expect(parseQuery('Café  invoice-march "Sales Report"')).toEqual([
      { text: "cafe", phrase: false },
      { text: "invoice", phrase: false },
      { text: "march", phrase: false },
      { text: "sales report", phrase: true },
    ]);
  });

  test("never lets FTS syntax through", () => {
    expect(parseQuery('a" OR NEAR( b* -c ^d')).toEqual(
      expect.arrayContaining([{ text: "a", phrase: false }]),
    );
    expect(() => search('"unterminated OR (')).not.toThrow();
  });
});

describe("search", () => {
  test("finds message text by word prefix, accent-insensitive, with a highlighted snippet and the message", async () => {
    const c = chat("Weekly sync", "Please send the Rechnung for the Café order to accounting");
    const found = await search("rech cafe");
    const hit = found.chats.find((h) => h.id === c.id);
    expect(hit).toBeDefined();
    expect(hit!.messageId).toBeTruthy();
    expect(searchSegments(hit!.snippet!).filter((s) => s.hit).map((s) => s.text.toLowerCase())).toEqual(["rechnung", "café"]);
  });

  test("a word only matches where a word starts", async () => {
    chat("Voice notes", "transcribe the voice memo");
    const found = await search("nvoice");
    expect(found.chats.some((h) => h.title === "Voice notes")).toBe(false);
  });

  test("title matches rank above passing mentions", async () => {
    const mention = chat("Random", "by the way the kangaroo thing");
    const titled = chat("Kangaroo budget", "numbers for next year");
    const found = await search("kangaroo");
    expect(found.chats.map((h) => h.id).slice(0, 2)).toEqual([titled.id, mention.id]);
    expect(found.chats[0]!.titleMatch).toBe(true);
  });

  test("words spread over several messages of one chat still find it", async () => {
    const c = chat("Planning", "the zeppelin arrives tuesday", "bring the marmalade");
    const found = await search("zeppelin marmalade");
    expect(found.chats.map((h) => h.id)).toContain(c.id);
  });

  test("a typo falls back to the closest indexed words", async () => {
    const c = chat("Ops", "the quarterly reconciliation is due");
    const found = await search("reconcilation");
    expect(found.corrected).toBe("reconciliation");
    expect(found.chats.map((h) => h.id)).toContain(c.id);
  });

  test("private chats are never found", async () => {
    const c = createConversation({ agentId: agent.id, title: "Secret", private: true });
    addMessage({ conversationId: c.id, role: "user", content: "the platypus password" });
    const found = await search("platypus");
    expect(found.chats).toEqual([]);
    expect(listConversations({ search: "platypus" })).toEqual([]);
  });

  test("renamed and deleted chats leave the index", async () => {
    const c = chat("Albatross review", "wombat");
    updateConversation(c.id, { title: "Pelican review" });
    expect((await search("albatross")).chats.some((h) => h.id === c.id)).toBe(false);
    expect((await search("pelican")).chats.some((h) => h.id === c.id)).toBe(true);
    await deleteConversation(c.id);
    expect((await search("wombat")).chats.some((h) => h.id === c.id)).toBe(false);
  });

  test("edited message text is indexed again", async () => {
    const c = chat("Edits");
    const m = addMessage({ conversationId: c.id, role: "assistant", content: "draft about narwhals" });
    sql("UPDATE messages SET content = ? WHERE id = ?", "final about walruses", m.id);
    expect((await search("narwhals")).chats.some((h) => h.id === c.id)).toBe(false);
    expect((await search("walruses")).chats.some((h) => h.id === c.id)).toBe(true);
  });

  test("tickets by title and description", async () => {
    const t = createTask({ title: "Fix the flamingo importer", description: "It drops the axolotl rows" });
    expect((await search("flamingo")).tasks.map((h) => h.id)).toContain(t.id);
    const byDescription = (await search("axolotl")).tasks.find((h) => h.id === t.id);
    expect(byDescription?.snippet).toContain("axolotl");
    updateTask(t.id, { title: "Fix the heron importer" });
    expect((await search("flamingo")).tasks.map((h) => h.id)).not.toContain(t.id);
  });

  test("the index survives a rebuild (after VACUUM)", async () => {
    const c = chat("Rebuild", "the capybara survives");
    rebuildSearchIndex();
    expect((await search("capybara")).chats.map((h) => h.id)).toContain(c.id);
  });

  test("the chat list's search uses the index too: every word in the title or any message", () => {
    const c = chat("Lighthouse", "keeper schedule");
    expect(listConversations({ search: "light keep" }).map((x) => x.id)).toContain(c.id);
    expect(listConversations({ search: "ighthouse" }).map((x) => x.id)).not.toContain(c.id);
  });
});

describe("snippets", () => {
  test("marks whole words that start with a term, keeps the original spelling, and trims around the first hit", () => {
    const long = `${"filler ".repeat(40)}the Café über-Rechnung arrived ${"tail ".repeat(60)}`;
    const snip = makeSnippet(long, ["cafe", "rech"]);
    expect(snip.startsWith("…")).toBe(true);
    expect(snip.endsWith("…")).toBe(true);
    expect(searchSegments(snip).filter((s) => s.hit).map((s) => s.text)).toEqual(["Café", "Rechnung"]);
    expect(searchSegments(makeSnippet("a decaf day", ["caf"])).some((s) => s.hit)).toBe(false);
  });
});

describe("notes", () => {
  test("splits Markdown into sections with their heading and line", () => {
    expect(chunkMarkdown("intro\n# One\nalpha\n## Two\nbeta")).toEqual([
      { line: 1, heading: "", body: "intro" },
      { line: 2, heading: "One", body: "alpha" },
      { line: 4, heading: "Two", body: "beta" },
    ]);
  });

  test("finds the agents' memory and notes, and follows changes", async () => {
    mkdirSync(join(agent.repoPath, "memory"), { recursive: true });
    writeFileSync(join(agent.repoPath, "memory", "suppliers.md"), "# Suppliers\n\n## Okapi Logistics\nPallets ship on Thursdays.\n");
    await refreshNotes(true);
    const hit = (await search("okapi pallets")).notes[0];
    expect(hit).toMatchObject({ agentId: agent.id, path: "memory/suppliers.md", heading: "Okapi Logistics", line: 3 });
    writeFileSync(join(agent.repoPath, "memory", "suppliers.md"), "# Suppliers\n\nnone left\n");
    const later = new Date(Date.now() + 5000);
    utimesSync(join(agent.repoPath, "memory", "suppliers.md"), later, later);
    await refreshNotes(true);
    expect((await search("okapi")).notes).toEqual([]);
  });
});
