import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { ClientEvent } from "@godmode/shared";
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
