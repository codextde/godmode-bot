import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, insert, openDb } from "../src/db";
import { bus } from "../src/events/bus";
import { setLogLevel } from "../src/log";
import { resetSettingsCache } from "../src/services/settings";
import { listNotifications } from "../src/services/notifications";
import { listMissingLogins, reportMissingLogin, updateMissingLogin } from "../src/services/missingLogins";
import { HttpError } from "../src/util";

let dataDir: string;
const events: ServerEvent[] = [];
let off: () => void;

beforeAll(() => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-missing-logins-"));
  loadConfig({ dataDir });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  off = bus.on((e) => events.push(e));
});

afterAll(() => {
  off();
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

function catchHttp(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return err as HttpError;
  }
  throw new Error("expected an HttpError");
}

const base = { agentId: "agt_a", runId: "run_1", workspaceId: null };

describe("missing logins", () => {
  test("a new report creates an open item and notifies the human", () => {
    events.length = 0;
    const item = reportMissingLogin({
      ...base,
      kind: "missing_credential",
      service: "GitHub",
      url: "https://github.com/login",
      reason: "No saved login for github.com",
    });
    expect(item).toMatchObject({ status: "open", occurrences: 1, service: "GitHub", kind: "missing_credential", credentialId: null });
    expect(events.some((e) => e.type === "missing-login.created" && e.item.id === item.id)).toBe(true);
    const notification = listNotifications().find((n) => n.title === "Login needed: GitHub")!;
    expect(notification).toMatchObject({ kind: "missing_login", body: "No saved login for github.com", link: "/inbox" });
  });

  test("reports for the same site are deduplicated while open", () => {
    const first = listMissingLogins({ status: "open" }).find((i) => i.service === "GitHub")!;
    const notificationsBefore = listNotifications().length;
    events.length = 0;

    const byUrl = reportMissingLogin({
      agentId: "agt_b",
      runId: "run_2",
      workspaceId: null,
      kind: "invalid_credential",
      service: "GitHub Enterprise",
      url: "https://www.github.com/settings/profile",
      reason: "Password rejected",
    });
    expect(byUrl.id).toBe(first.id);
    expect(byUrl).toMatchObject({ occurrences: 2, kind: "invalid_credential", reason: "Password rejected", agentId: "agt_b", runId: "run_2" });
    expect(events.some((e) => e.type === "missing-login.updated" && e.item.id === first.id)).toBe(true);

    const byName = reportMissingLogin({ ...base, kind: "missing_totp", service: "github" });
    expect(byName.id).toBe(first.id);
    expect(byName.occurrences).toBe(3);
    expect(byName.reason).toBe("Password rejected");

    expect(listNotifications().length).toBe(notificationsBefore);
    expect(listMissingLogins({ status: "open" }).filter((i) => i.service === "GitHub")).toHaveLength(1);
  });

  test("different sites and different workspaces are separate items", () => {
    const gitlab = reportMissingLogin({ ...base, kind: "missing_credential", service: "GitLab", url: "gitlab.com" });
    const github = listMissingLogins({ status: "open" }).find((i) => i.service === "GitHub")!;
    expect(gitlab.id).not.toBe(github.id);
    const ts = new Date().toISOString();
    insert("workspaces", { id: "wsp_ml", name: "ML", slug: "ml", created_at: ts, updated_at: ts });
    const scoped = reportMissingLogin({ ...base, workspaceId: "wsp_ml", kind: "missing_credential", service: "GitHub", url: "https://github.com" });
    expect(scoped.id).not.toBe(github.id);
    expect(scoped.workspaceId).toBe("wsp_ml");
  });

  test("resolving links a credential; later reports open a new item", () => {
    const item = listMissingLogins({ status: "open" }).find((i) => i.service === "GitLab")!;
    expect(catchHttp(() => updateMissingLogin(item.id, { credentialId: "crd_missing" })).status).toBe(400);
    expect(catchHttp(() => updateMissingLogin(item.id, { status: "bogus" as never })).status).toBe(400);
    expect(catchHttp(() => updateMissingLogin("mlg_missing", { status: "dismissed" })).status).toBe(404);

    const ts = new Date().toISOString();
    insert("credentials", { id: "crd_gitlab", name: "GitLab", created_at: ts, updated_at: ts });
    const resolved = updateMissingLogin(item.id, { credentialId: "crd_gitlab" });
    expect(resolved).toMatchObject({ status: "resolved", credentialId: "crd_gitlab" });

    const reopened = reportMissingLogin({ ...base, kind: "invalid_credential", service: "GitLab", url: "https://gitlab.com/users/sign_in" });
    expect(reopened.id).not.toBe(item.id);
    expect(reopened.occurrences).toBe(1);

    const dismissed = updateMissingLogin(reopened.id, { status: "dismissed" });
    expect(dismissed.status).toBe("dismissed");
    expect(updateMissingLogin(reopened.id, { status: "open", credentialId: null })).toMatchObject({ status: "open", credentialId: null });
  });

  test("list filters by status and puts open items first", () => {
    const all = listMissingLogins();
    const firstClosed = all.findIndex((i) => i.status !== "open");
    expect(firstClosed).toBeGreaterThan(0);
    expect(all.slice(firstClosed).every((i) => i.status !== "open")).toBe(true);
    expect(listMissingLogins({ status: "resolved" }).every((i) => i.status === "resolved")).toBe(true);
    expect(listMissingLogins({ status: "all" })).toHaveLength(all.length);
    expect(catchHttp(() => listMissingLogins({ status: "weird" })).status).toBe(400);
  });

  test("normalizes input", () => {
    const item = reportMissingLogin({ ...base, kind: "unknown" as never, service: "", url: "https://portal.example.com/login" });
    expect(item.service).toBe("portal.example.com");
    expect(item.kind).toBe("other");
    expect(catchHttp(() => reportMissingLogin({ ...base, kind: "other", service: "  " })).status).toBe(400);
  });
});
