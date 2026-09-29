import type { Hono } from "hono";
import { homedir } from "node:os";
import type { Bootstrap } from "@godmode/shared";
import { MAX_INSTRUCTIONS_LENGTH } from "@godmode/shared";
import { config } from "../../config";
import { get } from "../../db";
import * as vault from "../../vault/vault";
import { getSettings, updateSettings } from "../../services/settings";
import { listNotifications, markRead, clearNotifications, unreadCount } from "../../services/notifications";
import { listAudit } from "../../services/audit";
import { runDoctor, installDependency } from "../../services/doctor";
import { claudeUpdateStatus, updateClaude } from "../../services/claudeUpdate";
import { getModelCatalog } from "../../runner/models";
import { getDefaultAgentId } from "../../agents/service";
import { applyRuntimeSettings } from "../../services/runtime";
import { hasDashboardPassword } from "../auth";
import { requireGrant } from "../grants";
import { body, z } from "../validate";
import { badRequest } from "../../util";

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
        runningRuns: count("SELECT COUNT(*) AS c FROM runs WHERE status IN ('queued','running')"),
        unreadNotifications: unreadCount(),
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
    // server.hasDashboardPassword is derived; never trust client value
    if (patch.server && typeof patch.server === "object") delete (patch.server as Record<string, unknown>).hasDashboardPassword;
    // Making "reveal" the default secret access for new agents needs a fresh passphrase confirmation.
    const security = patch.security as { defaultSecretAccess?: unknown } | undefined;
    if (security?.defaultSecretAccess === "reveal" && getSettings().security.defaultSecretAccess !== "reveal") requireGrant(c);
    const instructions = (patch.runner as { appendSystemPrompt?: unknown } | undefined)?.appendSystemPrompt;
    if (typeof instructions === "string" && instructions.length > MAX_INSTRUCTIONS_LENGTH) {
      throw badRequest(`Instructions for every agent can be at most ${MAX_INSTRUCTIONS_LENGTH.toLocaleString("en-US")} characters`);
    }
    const next = updateSettings(patch as never);
    applyRuntimeSettings(next);
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
    return c.json(await installDependency(id as never));
  });
  app.get("/api/doctor/claude-update", async (c) => c.json(await claudeUpdateStatus(c.req.query("refresh") === "1")));
  app.post("/api/doctor/claude-update", async (c) => c.json(await updateClaude()));
}
