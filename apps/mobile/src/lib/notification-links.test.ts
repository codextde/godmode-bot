import { describe, expect, test } from "bun:test";
import { notificationRoute } from "./notification-links";

describe("notificationRoute", () => {
  test("what the phone always opened", () => {
    expect(notificationRoute("/chat/c%201")).toEqual({ pathname: "/chat/[id]", params: { id: "c 1" } });
    expect(notificationRoute("/agents/a1")).toEqual({ pathname: "/agent/[id]", params: { id: "a1" } });
    expect(notificationRoute("/tasks?task=t1")).toEqual({ pathname: "/task/[id]", params: { id: "t1" } });
    expect(notificationRoute("/my-tasks?task=h1")).toEqual({ pathname: "/human-task/[id]", params: { id: "h1" } });
    expect(notificationRoute("/my-tasks")).toBe("/my-tasks");
    expect(notificationRoute("/calls?call=x")).toEqual({ pathname: "/call/[id]", params: { id: "x" } });
    expect(notificationRoute("/calls")).toBe("/calls");
    expect(notificationRoute("/automations")).toBe("/automations");
    expect(notificationRoute("/artifacts/a")).toEqual({ pathname: "/artifact/[id]", params: { id: "a" } });
  });

  test("the settings the core's notices point at", () => {
    expect(notificationRoute("/settings/license")).toBe("/settings/license");
    expect(notificationRoute("/settings/system")).toBe("/settings/health");
    expect(notificationRoute("/settings/general")).toBe("/settings/computer");
    expect(notificationRoute("/settings/phone")).toBe("/settings/phones");
    expect(notificationRoute("/settings/integrations?tab=tools")).toBe("/settings/integrations");
    for (const section of ["accounts", "browser", "calls", "cloud", "devices", "review"]) expect(notificationRoute(`/settings/${section}`)).toBe(`/settings/${section}` as never);
  });

  test("a section the phone doesn't know opens Settings", () => {
    expect(notificationRoute("/settings/something-new")).toBe("/settings");
  });

  test("the links outside Settings", () => {
    expect(notificationRoute("/integrations")).toBe("/settings/integrations");
    expect(notificationRoute("/integrations?tab=api-keys")).toBe("/settings/vault/api-keys");
    expect(notificationRoute("/messaging")).toBe("/settings/messaging");
    expect(notificationRoute("/messaging?connection=m1")).toEqual({ pathname: "/settings/messaging-bot", params: { id: "m1" } });
    expect(notificationRoute("/agents/a1/memory")).toEqual({ pathname: "/memory/[id]", params: { id: "a1" } });
  });

  test("a plugin opens itself only with full access", () => {
    expect(notificationRoute("/plugins?plugin=p1")).toBe("/settings/plugins");
    expect(notificationRoute("/plugins?plugin=p1", true)).toEqual({ pathname: "/settings/plugin", params: { id: "p1" } });
    expect(notificationRoute("/plugins?plugin=p1&tab=code", true)).toEqual({ pathname: "/settings/plugin-code", params: { id: "p1" } });
  });

  test("nowhere to go: the caller decides", () => {
    expect(notificationRoute(null)).toBeNull();
    expect(notificationRoute("/inbox")).toBeNull();
    expect(notificationRoute("/tasks")).toBeNull();
    expect(notificationRoute("/somewhere")).toBeNull();
  });
});
