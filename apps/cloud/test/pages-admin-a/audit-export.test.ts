import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { GET as exportAudit } from "@/app/(app)/admin/audit/export/route";
import { audit } from "@/server/audit";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import { person, seed } from "./helpers";

const state = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("next/headers", async () => (await import("./helpers")).nextHeadersMock(state));
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

const actAs = (token: string | null) => {
  state.token = token;
};

beforeAll(resetDatabase);
beforeEach(async () => {
  await truncateAll();
  await seed();
  actAs(null);
});
afterAll(closeDatabase);

const request = (query = "") => new Request(`http://localhost:3210/admin/audit/export${query}`);

describe("audit CSV export", () => {
  test("needs audit.read: signed out 401, billing role 403, admin 200", async () => {
    const billing = await person({ role: "billing" });
    const admin = await person({ role: "admin" });
    expect((await exportAudit(request())).status).toBe(401);
    actAs(billing.token);
    const refused = await exportAudit(request());
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "forbidden" });
    actAs(admin.token);
    const ok = await exportAudit(request());
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(ok.headers.get("content-disposition")).toMatch(/^attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });

  test("rows are escaped and follow the search and action filter", async () => {
    const admin = await person({ role: "admin" });
    await audit({ id: null, label: "=cmd|' /C calc'!A0", ip: "203.0.113.5" }, "login.denied", { type: "login", id: "lgn_1" }, { reason: "domain", note: 'a "quoted", note' });
    await audit({ id: admin.ctx.user.id, label: admin.ctx.user.email }, "settings.update", { type: "settings", id: "general" }, { fields: ["appName"] });
    actAs(admin.token);

    const all = (await (await exportAudit(request())).text()).replace(/^﻿/, "");
    const lines = all.trimEnd().split("\r\n");
    expect(lines[0]).toBe("id,at,actor,actor_id,action,target_type,target_id,ip,meta");
    expect(lines).toHaveLength(3);
    expect(all).toContain(`,'=cmd|' /C calc'!A0,`);
    // jsonb keeps its own key order; the JSON is one quoted cell with doubled quotes.
    expect(all).toContain(`""reason"":""domain""`);
    expect(all).toContain(`""note"":""a \\""quoted\\"", note""`);

    const byAction = (await (await exportAudit(request("?action=settings.update"))).text()).trimEnd().split("\r\n");
    expect(byAction).toHaveLength(2);
    expect(byAction[1]).toContain("settings.update");

    const unknownAction = (await (await exportAudit(request("?action=not.a.thing"))).text()).trimEnd().split("\r\n");
    expect(unknownAction).toHaveLength(3); // an unknown filter value is ignored, not an error

    const bySearch = (await (await exportAudit(request("?q=203.0.113.5"))).text()).trimEnd().split("\r\n");
    expect(bySearch).toHaveLength(2);
    expect(bySearch[1]).toContain("login.denied");
  });
});
