import type { Hono } from "hono";
import { homedir } from "node:os";
import type { Bootstrap } from "@godmode/shared";
import { countAttention } from "@godmode/shared";
import { config } from "../../config";
import { get } from "../../db";
import * as vault from "../../vault/vault";
import { getSettings, updateSettings } from "../../services/settings";
import { checkSettingsPatch } from "../../services/settingsPatch";
import { listNotifications, markRead, clearNotifications, unreadCount } from "../../services/notifications";
import { audit, listAudit } from "../../services/audit";
import { listAttention } from "../../services/attention";
import { runDoctor, installDependency } from "../../services/doctor";
import { claudeUpdateStatus, updateClaude } from "../../services/claudeUpdate";
import { PERMISSION_IDS, PRIVACY_IDS, checkPermissions, fixPermission, openPrivacySettings, resetPrivacy } from "../../services/permissions";
import { TOOL_IDS, checkUpdates } from "../../services/updates";
import { cleanUp, fixAll, inTurn, installUpdates, maintenanceStatus } from "../../services/maintenance";
import { CLEANUP_IDS, scanCleanup } from "../../services/cleanup";
import { disableIdleTimeout } from "../../mcp/http";
import { getModelCatalog } from "../../runner/models";
import { getDefaultAgentId } from "../../agents/service";
import { applyRuntimeSettings } from "../../services/runtime";
import { hasDashboardPassword } from "../auth";
import { requireGrant } from "../grants";
import { body, z } from "../validate";
import { pendingRequestCount } from "../../messaging/service";

function count(sql: string): number {
  return get<{ c: number }>(sql)?.c ?? 0;
}

export function registerSystemRoutes(app: Hono) {
  app.get("/api/bootstrap", (c) => {
    const cfg = config();
    const settings = getSettings();
    const data: Bootstrap = {
      version: cfg.version,
      mode: cfg.mode,
      dataDir: cfg.dataDir,
      homeDir: homedir(),
      platform: cfg.platform,
      vault: vault.status(),
      settings: { ...settings, server: { ...settings.server, hasDashboardPassword: hasDashboardPassword() } },
      defaultAgentId: getDefaultAgentId(),
      counts: {
        agents: count("SELECT COUNT(*) AS c FROM agents"),
        workspaces: count("SELECT COUNT(*) AS c FROM workspaces"),
        credentials: count("SELECT COUNT(*) AS c FROM credentials"),
        totp: count("SELECT COUNT(*) AS c FROM totp"),
        openMissingLogins: count("SELECT COUNT(*) AS c FROM missing_logins WHERE status = 'open'"),
        openQuestions: count("SELECT COUNT(*) AS c FROM questions WHERE status = 'open'"),
        runningRuns: count("SELECT COUNT(*) AS c FROM runs WHERE status IN ('queued','running')"),
        // A question counts once: as the open question, not also as its notification.
        // Questions and missing logins count once: as the waiting thing ("Needs you"), not also as their notification.
        unreadNotifications: count("SELECT COUNT(*) AS c FROM notifications WHERE read = 0 AND kind NOT IN ('question', 'missing_login')"),
        messagingRequests: pendingRequestCount(),
        attention: countAttention(listAttention()),
        unreadChats: count("SELECT COUNT(*) AS c FROM conversations WHERE unread_run_id IS NOT NULL AND archived = 0"),
      },
    };
    return c.json(data);
  });

  app.get("/api/settings", (c) => {
    const s = getSettings();
    return c.json({ ...s, server: { ...s.server, hasDashboardPassword: hasDashboardPassword() } });
  });

  app.put("/api/settings", async (c) => {
    const patch = await body(c, z.record(z.string(), z.unknown()));
    checkSettingsPatch(patch, () => requireGrant(c));
    const cloud = patch.cloud as Record<string, unknown> | undefined;
    const before = getSettings().runner.monthlyBudgetUsd ?? null;
    const next = updateSettings(patch as never);
    applyRuntimeSettings(next);
    if (cloud) audit("user", "cloud.settings", null, cloud);
    if ((next.runner.monthlyBudgetUsd ?? null) !== before) audit("user", "budget.set", null, { scope: "team", from: before, to: next.runner.monthlyBudgetUsd ?? null });
    return c.json(next);
  });

  app.get("/api/notifications", (c) => c.json(listNotifications(Number(c.req.query("limit") ?? 100))));
  app.post("/api/notifications/read", async (c) => {
    const { ids } = await body(c, z.object({ ids: z.union([z.array(z.string()), z.literal("all")]) }));
    markRead(ids);
    return c.json({ ok: true });
  });
  app.delete("/api/notifications", (c) => {
    clearNotifications();
    return c.json({ ok: true });
  });

  app.get("/api/audit", (c) => c.json(listAudit(Number(c.req.query("limit") ?? 200), c.req.query("action") || undefined)));

  app.get("/api/doctor", async (c) => c.json(await runDoctor(c.req.query("refresh") === "1")));
  app.get("/api/models", async (c) => c.json(await getModelCatalog({ refresh: c.req.query("refresh") === "1" })));
  app.post("/api/doctor/install", async (c) => {
    const { id } = await body(c, z.object({ id: z.string() }));
    disableIdleTimeout(c);
    return c.json(await inTurn(() => installDependency(id as never)));
  });
  app.get("/api/doctor/claude-update", async (c) => c.json(await claudeUpdateStatus(c.req.query("refresh") === "1")));
  app.post("/api/doctor/claude-update", async (c) => {
    disableIdleTimeout(c);
    return c.json(await inTurn(updateClaude));
  });

  /** Can Godmode read its data, start its tools and (macOS) see and control the computer? */
  app.get("/api/doctor/permissions", async (c) => c.json(await checkPermissions()));
  app.post("/api/doctor/permissions/fix", async (c) => {
    const { id } = await body(c, z.object({ id: z.enum(PERMISSION_IDS) }));
    return c.json(await fixPermission(id));
  });
  /** macOS: open the System Settings pane of a privacy permission (and show Godmode's app to drag in). */
  app.post("/api/doctor/permissions/open", async (c) => {
    const { id, reveal } = await body(c, z.object({ id: z.enum(PRIVACY_IDS), reveal: z.boolean().optional() }));
    return c.json(await openPrivacySettings(id, { reveal }));
  });
  /** macOS: forget Godmode's entry for a privacy permission and ask again. */
  app.post("/api/doctor/permissions/reset", async (c) => {
    const { id } = await body(c, z.object({ id: z.enum(PRIVACY_IDS) }));
    return c.json(await resetPrivacy(id));
  });
  /** Repair everything Godmode can repair by itself. */
  app.post("/api/doctor/fix", async (c) => {
    disableIdleTimeout(c);
    return c.json(await fixAll());
  });
  app.get("/api/doctor/updates", async (c) => {
    const refresh = c.req.query("refresh") === "1";
    // A fresh check may ask the newest Playwright what it would install, which can take a while.
    if (refresh) disableIdleTimeout(c);
    return c.json(await checkUpdates(refresh));
  });
  /** Update one tool, or (without an id) every tool that has an update. */
  app.post("/api/doctor/updates", async (c) => {
    const { id } = await body(c, z.object({ id: z.enum(TOOL_IDS).optional() }));
    disableIdleTimeout(c);
    return c.json(await installUpdates(id));
  });
  app.get("/api/doctor/maintenance", (c) => c.json(maintenanceStatus()));

  /** What takes up space, what can go, and a check of the data folder. */
  app.get("/api/cleanup", async (c) => {
    disableIdleTimeout(c);
    return c.json(await scanCleanup({ fresh: c.req.query("refresh") === "1" }));
  });
  app.post("/api/cleanup", async (c) => {
    const { ids } = await body(c, z.object({ ids: z.array(z.enum(CLEANUP_IDS)).min(1) }));
    disableIdleTimeout(c);
    return c.json(await cleanUp(ids));
  });
}
