import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { ClientEvent } from "@godmode/shared";
import { bus } from "../src/events/bus";
import { hasBrowserSubscribers, hasBrowserWatchers, websocketHandler, type WsData } from "../src/server/ws";

const fake = (id: string) =>
  ({
    data: { id, subscriptions: new Set<string>() },
    send: () => 0,
    close: () => {},
  }) as unknown as ServerWebSocket<WsData>;

const msg = (ws: ServerWebSocket<WsData>, event: ClientEvent) => websocketHandler.message(ws, JSON.stringify(event));

describe("browser live view subscriptions", () => {
  test("passive viewers stream frames without keeping the browser in use", () => {
    const chat = fake("ws_chat");
    const page = fake("ws_page");
    websocketHandler.open(chat);
    websocketHandler.open(page);

    msg(chat, { type: "browser.subscribe", profileId: "bpr_a", passive: true });
    expect(hasBrowserSubscribers("bpr_a")).toBe(true);
    expect(hasBrowserWatchers("bpr_a")).toBe(false);

    msg(page, { type: "browser.subscribe", profileId: "bpr_a" });
    expect(hasBrowserWatchers("bpr_a")).toBe(true);

    msg(chat, { type: "browser.unsubscribe", profileId: "bpr_a" });
    msg(chat, { type: "browser.unsubscribe", profileId: "bpr_a" });
    expect(hasBrowserWatchers("bpr_a")).toBe(true);

    msg(chat, { type: "browser.subscribe", profileId: "bpr_a", passive: true });
    msg(page, { type: "browser.unsubscribe", profileId: "bpr_a" });
    expect(hasBrowserWatchers("bpr_a")).toBe(false);
    expect(hasBrowserSubscribers("bpr_a")).toBe(true);

    websocketHandler.close(chat);
    websocketHandler.close(page);
    expect(hasBrowserSubscribers("bpr_a")).toBe(false);
  });

  test("re-subscribing switches a socket between passive and watching", () => {
    const ws = fake("ws_switch");
    websocketHandler.open(ws);

    msg(ws, { type: "browser.subscribe", profileId: "bpr_b", passive: true });
    msg(ws, { type: "browser.subscribe", profileId: "bpr_b" });
    msg(ws, { type: "browser.subscribe", profileId: "bpr_b" });
    expect(hasBrowserWatchers("bpr_b")).toBe(true);

    msg(ws, { type: "browser.subscribe", profileId: "bpr_b", passive: true });
    expect(hasBrowserWatchers("bpr_b")).toBe(false);
    expect(hasBrowserSubscribers("bpr_b")).toBe(true);

    msg(ws, { type: "browser.subscribe", profileId: "bpr_b" });
    websocketHandler.close(ws);
    expect(hasBrowserWatchers("bpr_b")).toBe(false);
    expect(hasBrowserSubscribers("bpr_b")).toBe(false);
  });
});

describe("chat-scoped browser live views", () => {
  test("a chat's view is its own subscription, and frames reach only its subscribers", () => {
    const received: Record<string, string[]> = { panel: [], page: [] };
    const socket = (id: keyof typeof received) =>
      ({
        data: { id, subscriptions: new Set<string>() },
        send: (raw: string) => {
          received[id]!.push((JSON.parse(raw) as { conversationId?: string }).conversationId ?? "profile");
          return 0;
        },
        close: () => {},
      }) as unknown as ServerWebSocket<WsData>;
    const panel = socket("panel");
    const page = socket("page");
    websocketHandler.open(panel);
    websocketHandler.open(page);
    received.panel = [];
    received.page = [];

    msg(panel, { type: "browser.subscribe", profileId: "bpr_c", conversationId: "cnv_1", passive: true });
    msg(page, { type: "browser.subscribe", profileId: "bpr_c" });
    expect(hasBrowserSubscribers("bpr_c", "cnv_1")).toBe(true);
    expect(hasBrowserSubscribers("bpr_c", "cnv_2")).toBe(false);
    expect(hasBrowserWatchers("bpr_c", "cnv_1")).toBe(false);

    const frame = { type: "browser.frame", profileId: "bpr_c", data: "", url: "", title: "", width: 1, height: 1 } as const;
    bus.emit({ ...frame, conversationId: "cnv_1" });
    bus.emit(frame);
    expect(received).toEqual({ panel: ["cnv_1"], page: ["profile"] });

    // Watching a chat's view (the full-size view) keeps its browser — and the chat's tab — in use.
    msg(panel, { type: "browser.subscribe", profileId: "bpr_c", conversationId: "cnv_1" });
    msg(page, { type: "browser.unsubscribe", profileId: "bpr_c" });
    expect(hasBrowserWatchers("bpr_c")).toBe(true);
    expect(hasBrowserWatchers("bpr_c", "cnv_1")).toBe(true);

    websocketHandler.close(panel);
    websocketHandler.close(page);
    expect(hasBrowserSubscribers("bpr_c")).toBe(false);
    expect(hasBrowserWatchers("bpr_c")).toBe(false);
  });

  test("malformed ids are ignored", () => {
    const ws = fake("ws_bad");
    websocketHandler.open(ws);
    msg(ws, { type: "browser.subscribe", profileId: "bpr_d", conversationId: "../../x" });
    expect(hasBrowserSubscribers("bpr_d")).toBe(false);
    websocketHandler.close(ws);
  });
});
