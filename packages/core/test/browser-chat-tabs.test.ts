/**
 * Chats work in parallel in one browser profile, each in its own tabs: the tab registry, the per-chat DevTools
 * endpoint browser-use connects to, fills, live views and cleanup — against a real headless Chromium (skipped when
 * none is installed).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";
import { bus } from "../src/events/bus";
import { CdpClient, attachToPage, type CdpParams } from "../src/browser/cdp";
import { findChrome } from "../src/browser/chrome";
import { getRunning } from "../src/browser/state";
import { TabRegistry, type TargetInfo } from "../src/browser/tabs";
import { openChatLease, releaseChatLease } from "../src/browser/proxy";
import { addCardMask, clearCardMasks } from "../src/vault/cardMask";
import { startLiveView, stopLiveView } from "../src/browser/screencast";
import * as manager from "../src/browser/manager";

describe("tab registry", () => {
  const registry = () => {
    const handlers = new Map<string, (p: CdpParams) => void>();
    const client = { on: (method: string, fn: (p: CdpParams) => void) => handlers.set(method, fn) };
    const tabs = new TabRegistry(client as unknown as CdpClient);
    const created = (info: TargetInfo) => handlers.get("Target.targetCreated")!({ targetInfo: info });
    const destroyed = (targetId: string) => handlers.get("Target.targetDestroyed")!({ targetId });
    return { tabs, created, destroyed };
  };
  const page = (targetId: string, extra: Partial<TargetInfo> = {}): TargetInfo => ({ targetId, type: "page", url: "https://a.test/", title: "A", ...extra });

  test("older Chromium names an iframe's parent by its frame id only", () => {
    const { tabs, created } = registry();
    created(page("T1"));
    tabs.claim("T1", "chat_a");
    created({ targetId: "F1", type: "iframe", url: "https://b.test/", title: "", parentFrameId: "T1" });
    expect(tabs.visibleTo(tabs.info("F1")!, "chat_a")).toBe(true);
    expect(tabs.pageOf("F1")).toBe("T1");
  });

  test("popups and iframes belong to the chat whose tab opened them, even after it closes", () => {
    const { tabs, created, destroyed } = registry();
    created(page("T1"));
    tabs.claim("T1", "chat_a");
    created(page("P1", { openerId: "T1" }));
    created({ targetId: "F1", type: "iframe", url: "https://b.test/", title: "", parentId: "P1" });
    expect(tabs.ownerOf("P1")).toBe("chat_a");
    expect(tabs.visibleTo(tabs.info("F1")!, "chat_a")).toBe(true);
    expect(tabs.visibleTo(tabs.info("F1")!, "chat_b")).toBe(false);
    destroyed("T1");
    expect(tabs.ownerOf("P1")).toBe("chat_a");
    expect(tabs.pagesOf("chat_a").map((p) => p.targetId)).toEqual(["P1"]);
  });

  test("workers are shared, tabs of nobody are hidden", () => {
    const { tabs, created } = registry();
    created(page("H1", { url: "https://human.test/" }));
    expect(tabs.visibleTo(tabs.info("H1")!, "chat_a")).toBe(false);
    expect(tabs.visibleTo({ targetId: "W1", type: "service_worker", url: "", title: "" }, "chat_a")).toBe(true);
    expect(tabs.visibleTo({ targetId: "X1", type: "tab", url: "", title: "" }, "chat_a")).toBe(false);
  });

  test("the current tab follows where the agent works; blank unclaimed pages are spare", () => {
    const { tabs, created, destroyed } = registry();
    created(page("S1", { url: "about:blank" }));
    created(page("N1", { url: "about:blank" }));
    created(page("T1"));
    created(page("T2"));
    // Only pages offered as spares: a fresh blank tab may be another chat's, its createTarget answer on the way.
    expect(tabs.spareBlankPage()).toBeNull();
    tabs.addSpares(["S1"]);
    expect(tabs.spareBlankPage()?.targetId).toBe("S1");
    tabs.claim("T1", "chat_a");
    tabs.claim("T2", "chat_a", false);
    expect(tabs.currentPage("chat_a")?.targetId).toBe("T1");
    tabs.focus("chat_a", "T2");
    expect(tabs.currentPage("chat_a")?.targetId).toBe("T2");
    tabs.focus("chat_b", "T1");
    expect(tabs.currentPage("chat_a")?.targetId).toBe("T2");
    destroyed("T2");
    expect(tabs.currentPage("chat_a")?.targetId).toBe("T1");
    expect(tabs.openChats().map((c) => [c.conversationId, c.tabs])).toEqual([["chat_a", 1]]);
    tabs.dropChat("chat_a");
    expect(tabs.openChats()).toEqual([]);
  });
});

const chrome = findChrome();
const suite = chrome && !process.env.GODMODE_SKIP_BROWSER_TESTS ? describe : describe.skip;

async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (err) {
      last = err;
    }
    await Bun.sleep(100);
  }
  throw new Error(`waitFor timed out${last ? `: ${String(last)}` : ""}`);
}

interface Chat {
  url: string;
  client: CdpClient;
  events: { method: string; params: CdpParams }[];
}

suite("parallel chats in one browser", () => {
  let dataDir = "";
  let profileId = "";
  let origin = "";
  let pages: ReturnType<typeof Bun.serve>;
  const chats: Record<string, Chat> = {};

  const rb = () => getRunning(profileId)!;
  const targetsOf = async (chat: Chat) =>
    (await chat.client.send<{ targetInfos: TargetInfo[] }>("Target.getTargets")).targetInfos.filter((t) => t.type === "page");

  /** What browser-use does: a run's cdp_url → /json/version → the browser WebSocket. */
  async function connect(conversationId: string, runId: string): Promise<Chat> {
    const url = openChatLease({
      runId,
      profileId,
      conversationId,
      open: async () => {
        await manager.ensureChatTab(rb(), conversationId);
        return rb();
      },
    });
    const version = (await (await fetch(`${url}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const client = await CdpClient.connect(version.webSocketDebuggerUrl);
    const chat: Chat = { url, client, events: [] };
    for (const method of ["Target.targetCreated", "Target.targetInfoChanged", "Target.attachedToTarget"]) {
      client.on(method, (params, sessionId) => {
        if (!sessionId) chat.events.push({ method, params });
      });
    }
    await client.send("Target.setDiscoverTargets", { discover: true });
    await client.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    return chat;
  }

  async function openIn(chat: Chat, path: string): Promise<string> {
    const [page] = await targetsOf(chat);
    const { sessionId } = await chat.client.send<{ sessionId: string }>("Target.attachToTarget", { targetId: page!.targetId, flatten: true });
    await chat.client.send("Page.navigate", { url: `${origin}${path}` }, sessionId);
    await waitFor(async () => (await chat.client.send<{ result: { value: string } }>("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, sessionId)).result.value === "complete");
    return sessionId;
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "godmode-chat-tabs-"));
    openDb(loadConfig({ dataDir }).dbPath);
    pages = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        const body =
          path === "/login"
            ? `<!doctype html><title>Login</title><input id="pass" type="password">`
            : path === "/checkout"
              ? `<!doctype html><title>Checkout</title><input id="num" autocomplete="cc-number">`
              : `<!doctype html><title>${path.slice(1)}</title><p>${path}</p>`;
        return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
      },
    });
    origin = `http://127.0.0.1:${pages.port}`;
    manager.ensureDefaultProfile();
    profileId = manager.createProfile({ name: "Chats", workspaceId: null }).id;
    await manager.launchBrowser(profileId, { headless: true });
    chats.a = await connect("cnv_a", "run_a");
    chats.b = await connect("cnv_b", "run_b");
  }, 60_000);

  afterAll(async () => {
    for (const chat of Object.values(chats)) chat.client.close();
    await manager.shutdownBrowsers();
    pages?.stop(true);
    closeDb();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, 60_000);

  test("each chat sees exactly one tab of its own", async () => {
    const [a, b] = [await targetsOf(chats.a!), await targetsOf(chats.b!)];
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.targetId).not.toBe(b[0]!.targetId);
    expect(rb().tabs.ownerOf(a[0]!.targetId)).toBe("cnv_a");
    expect(rb().tabs.ownerOf(b[0]!.targetId)).toBe("cnv_b");
  });

  test("both chats browse at the same time, each in its own tab", async () => {
    const [sa, sb] = await Promise.all([openIn(chats.a!, "/a"), openIn(chats.b!, "/b")]);
    expect(sa).not.toBe(sb);
    expect(rb().tabs.currentPage("cnv_a")?.url).toBe(`${origin}/a`);
    expect(rb().tabs.currentPage("cnv_b")?.url).toBe(`${origin}/b`);
    expect(chats.b!.events.some((e) => JSON.stringify(e.params).includes(`${origin}/a`))).toBe(false);
  });

  test("tabs a chat opens are its own and out of reach for other chats", async () => {
    const before = chats.b!.events.length;
    const { targetId } = await chats.a!.client.send<{ targetId: string }>("Target.createTarget", { url: `${origin}/a2` });
    await waitFor(() => chats.a!.events.some((e) => e.method === "Target.attachedToTarget" && e.params.targetInfo.targetId === targetId));
    expect(rb().tabs.ownerOf(targetId)).toBe("cnv_a");
    expect((await targetsOf(chats.a!)).map((t) => t.targetId)).toContain(targetId);
    expect((await targetsOf(chats.b!)).map((t) => t.targetId)).not.toContain(targetId);
    for (const method of ["Target.attachToTarget", "Target.activateTarget", "Target.closeTarget", "Target.getTargetInfo"]) {
      await expect(chats.b!.client.send(method, { targetId })).rejects.toThrow("No target with given id found");
    }
    await Bun.sleep(300);
    expect(chats.b!.events.slice(before).some((e) => JSON.stringify(e.params).includes(targetId))).toBe(false);
    // Waiting for a debugger is never forced on other chats' new tabs.
    const page = await attachToPage(rb().client, targetId);
    await waitFor(() => page.evaluate<boolean>("document.readyState === 'complete'", { timeoutMs: 1000 }));
    await page.detach();
  });

  test("popups belong to the chat that opened them", async () => {
    const [opener] = await targetsOf(chats.a!);
    const { sessionId } = await chats.a!.client.send<{ sessionId: string }>("Target.attachToTarget", { targetId: opener!.targetId, flatten: true });
    await chats.a!.client.send("Runtime.evaluate", { expression: `window.open("${origin}/popup", "_blank", "noopener")`, userGesture: true }, sessionId);
    const popup = await waitFor(async () => (await targetsOf(chats.a!)).find((t) => t.url.endsWith("/popup")));
    expect(rb().tabs.ownerOf(popup.targetId)).toBe("cnv_a");
    expect((await targetsOf(chats.b!)).some((t) => t.url.endsWith("/popup"))).toBe(false);
  });

  test("switching tabs never brings the browser to the front", async () => {
    const tabs = await targetsOf(chats.a!);
    const [first, last] = [tabs[0]!, tabs.at(-1)!];
    await expect(chats.a!.client.send("Target.activateTarget", { targetId: last.targetId })).resolves.toEqual({});
    expect(rb().tabs.currentPage("cnv_a")?.targetId).toBe(last.targetId);
    const { sessionId } = await chats.a!.client.send<{ sessionId: string }>("Target.attachToTarget", { targetId: first.targetId, flatten: true });
    await expect(chats.a!.client.send("Page.bringToFront", {}, sessionId)).resolves.toEqual({});
    expect(rb().tabs.currentPage("cnv_a")?.targetId).toBe(first.targetId);
  });

  test("other chats' sessions and browser-wide commands are refused", async () => {
    const [page] = await targetsOf(chats.a!);
    const { sessionId } = await chats.a!.client.send<{ sessionId: string }>("Target.attachToTarget", { targetId: page!.targetId, flatten: true });
    await expect(chats.b!.client.send("Runtime.evaluate", { expression: "1" }, sessionId)).rejects.toThrow("Session with given id not found");
    await expect(chats.a!.client.send("Browser.close")).rejects.toThrow("only reaches its own chat");
    expect(manager.getProfile(profileId).running).toBe(true);
  });

  test("vault fills go into the chat's own tab", async () => {
    await Promise.all([openIn(chats.a!, "/login"), openIn(chats.b!, "/login")]);
    const res = await manager.fillIntoPage(profileId, {
      text: "secret-b",
      kind: "password",
      conversationId: "cnv_b",
      allowedHosts: ["127.0.0.1"],
      httpHosts: ["127.0.0.1"],
    });
    expect(res.ok).toBe(true);
    const valueIn = async (conversationId: string) => {
      const s = await attachToPage(rb().client, rb().tabs.currentPage(conversationId)!.targetId);
      try {
        return await s.evaluate<string>("document.getElementById('pass').value");
      } finally {
        await s.detach();
      }
    };
    expect(await valueIn("cnv_b")).toBe("secret-b");
    expect(await valueIn("cnv_a")).toBe("");
    expect((await manager.currentPage(profileId, "cnv_b"))?.url).toBe(`${origin}/login`);
    const none = await manager.fillIntoPage(profileId, { text: "x", kind: "password", conversationId: "cnv_none", allowedHosts: ["127.0.0.1"] });
    expect(none.detail).toContain("no open tab");
  });

  test("a card number Godmode typed reads back masked through the chat's endpoint", async () => {
    const sessionId = await openIn(chats.a!, "/checkout");
    addCardMask("4242424242424242");
    try {
      const res = await manager.fillIntoPage(profileId, {
        text: "4242424242424242",
        kind: "cc-number",
        conversationId: "cnv_a",
        allowedHosts: ["127.0.0.1"],
        httpHosts: ["127.0.0.1"],
      });
      expect(res.ok).toBe(true);
      const read = await chats.a!.client.send<{ result: { value: string } }>(
        "Runtime.evaluate",
        { expression: "document.getElementById('num').value + ' ' + document.documentElement.outerHTML", returnByValue: true },
        sessionId,
      );
      expect(read.result.value).toStartWith("•••• 4242 ");
      expect(read.result.value).not.toContain("4242424242424242");
      const s = await attachToPage(rb().client, rb().tabs.currentPage("cnv_a")!.targetId);
      try {
        expect(await s.evaluate<string>("document.getElementById('num').value")).toBe("4242424242424242");
      } finally {
        await s.detach();
      }
    } finally {
      clearCardMasks();
    }
  });

  test("a chat's live view shows its own tab", async () => {
    await openIn(chats.b!, "/b-live");
    const frames: Extract<ServerEvent, { type: "browser.frame" }>[] = [];
    const off = bus.on((e) => {
      if (e.type === "browser.frame") frames.push(e);
    });
    try {
      await startLiveView(profileId, "cnv_b");
      const frame = await waitFor(() => frames.find((f) => f.conversationId === "cnv_b"), 15_000);
      expect(frame.url).toBe(`${origin}/b-live`);
    } finally {
      off();
      await stopLiveView(profileId, "cnv_b");
    }
  });

  test("the profile lists its chats with their tabs", async () => {
    const chats = await waitFor(() => {
      const list = manager.getProfile(profileId).chats;
      return list.length === 2 && list;
    });
    expect(chats.map((c) => c.conversationId).sort()).toEqual(["cnv_a", "cnv_b"]);
    expect(chats.every((c) => c.active)).toBe(true);
    expect(chats.find((c) => c.conversationId === "cnv_a")!.tabs).toBe(3);
  });

  test("ending a run closes its connection; the chat keeps its tabs", async () => {
    releaseChatLease("run_a");
    await waitFor(() => chats.a!.client.closed);
    expect((await fetch(`${chats.a!.url}/json/version`)).status).toBe(404);
    expect(rb().tabs.pagesOf("cnv_a").length).toBe(3);
    expect(manager.getProfile(profileId).chats.find((c) => c.conversationId === "cnv_a")?.active).toBe(false);
  });

  test("closing chats' tabs keeps the browser's last page, blank, for the next chat", async () => {
    await manager.closeChatTabs("cnv_a");
    expect(rb().tabs.pagesOf("cnv_a")).toEqual([]);
    await waitFor(async () => (await targetsOf(chats.b!)).length === 1);
    // A chat whose run is still going keeps its tabs.
    await manager.closeChatTabs("cnv_b");
    expect(rb().tabs.pagesOf("cnv_b")).toHaveLength(1);
    releaseChatLease("run_b");
    const last = rb().tabs.currentPage("cnv_b")!;
    await manager.closeChatTabs("cnv_b");
    await waitFor(() => rb().tabs.info(last.targetId)?.url === "about:blank");
    expect(rb().tabs.userPages().map((p) => p.targetId)).toEqual([last.targetId]);
    expect(await manager.ensureChatTab(rb(), "cnv_c")).toBe(last.targetId);
    expect(manager.getProfile(profileId).running).toBe(true);
  });
});
