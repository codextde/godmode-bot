import type { Context, Hono } from "hono";
import type { RunnerFixResult } from "@godmode/shared";
import { importChromeSession } from "../../browser/manager";
import { config } from "../../config";
import { logger } from "../../log";
import { fixCheck, runnerHealth } from "../../remote/health";
import { forgetController, runnerInfo } from "../../remote/linkServer";
import { readMemoryState, writeMemoryState } from "../../remote/memorySync";
import { MAX_UPDATE_BYTES, applyUpdate, downloadUpdate, receiveChunk } from "../../remote/selfUpdate";
import { applySnapshot, type ConfigSnapshot } from "../../remote/snapshot";
import { audit } from "../../services/audit";
import { installUpdates } from "../../services/maintenance";
import { checkUpdates } from "../../services/updates";
import { runCommand, toolPath } from "../../services/doctor";
import { badRequest, childEnv, notFound } from "../../util";
import { body, z } from "../validate";

const log = logger("link");

const EXEC_DEFAULT_MS = 120_000;
const EXEC_MAX_MS = 15 * 60_000;
const EXEC_MAX_OUTPUT = 200_000;

/**
 * What the controller asks a runner over the encrypted link. These routes exist only on that channel: the link
 * listener (remote/linkServer.ts) forwards a paired controller's requests with the master token and tags them; the
 * same paths asked any other way (the loopback API, a dashboard, a phone) are not found.
 */
function viaLink(c: Context): string | null {
  const env = c.env as { channel?: string; controllerId?: string } | undefined;
  return env?.channel === "runner-link" ? (env.controllerId ?? "") : null;
}

export function registerLinkRoutes(app: Hono): void {
  app.use("/api/link/*", async (c, next) => {
    if (viaLink(c) === null) throw notFound("Route");
    await next();
  });

  app.get("/api/link/info", (c) => c.json(runnerInfo()));

  app.post("/api/link/sync", async (c) => {
    const snapshot = (await c.req.json()) as ConfigSnapshot;
    const result = await applySnapshot(snapshot);
    for (const w of result.warnings) log.warn(w);
    return c.json(result);
  });

  app.get("/api/link/health", async (c) => c.json(await runnerHealth(c.req.query("refresh") === "1")));

  app.post("/api/link/health/fix", async (c) => {
    const { id } = await body(c, z.object({ id: z.string().min(1).max(64) }));
    const result = await fixCheck(id);
    audit("controller", "runner.fix", id, { ok: result.ok });
    return c.json({ ...result, health: await runnerHealth(true) } satisfies RunnerFixResult);
  });

  app.get("/api/link/agents/:id/memory", (c) => c.json(readMemoryState(c.req.param("id"))));

  app.put("/api/link/agents/:id/memory", async (c) => {
    const input = await body(c, z.object({ snapshot: z.object({ files: z.record(z.string(), z.unknown()) }).passthrough() }));
    return c.json(await writeMemoryState(c.req.param("id"), input.snapshot as never, "Memory from Godmode"));
  });

  app.post("/api/link/browser/:profileId/cookies", async (c) => {
    const { cookies } = await body(c, z.object({ cookies: z.array(z.unknown()).max(20_000) }));
    return c.json(await importChromeSession(c.req.param("profileId"), { cookiesJson: JSON.stringify(cookies) }));
  });

  // Commands for the "fix with Claude" chat on the controller: its agent diagnoses and repairs the runner from there.
  app.post("/api/link/exec", async (c) => {
    const input = await body(
      c,
      z.object({ command: z.string().min(1).max(20_000), cwd: z.string().max(4096).optional(), timeoutMs: z.number().int().positive().max(EXEC_MAX_MS).optional() }),
    );
    const shell = process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
    audit("controller", "runner.exec", null, { command: input.command.slice(0, 500), cwd: input.cwd ?? null });
    const res = await runCommand([shell, "-lc", input.command], {
      timeoutMs: input.timeoutMs ?? EXEC_DEFAULT_MS,
      // The runner's data dir by default: its logs are in logs/.
      cwd: input.cwd ?? config().dataDir,
      env: childEnv({ PATH: toolPath() }),
      maxOutput: EXEC_MAX_OUTPUT,
    });
    return c.json(res);
  });

  // A new Godmode from the controller, in pieces (remote/selfUpdate.ts), then installed once nothing works.
  app.put("/api/link/update/chunk", async (c) => {
    const offset = Number(c.req.query("offset"));
    const total = Number(c.req.query("total"));
    if (!Number.isInteger(offset) || offset < 0 || offset > MAX_UPDATE_BYTES) throw badRequest("offset");
    return c.json(receiveChunk(offset, total, new Uint8Array(await c.req.arrayBuffer())));
  });

  const target = z.object({ version: z.string().min(1).max(64), build: z.string().max(128) });

  app.post("/api/link/update/apply", async (c) => {
    const input = await body(c, z.object({ sha256: z.string().regex(/^[0-9a-fA-F]{64}$/), size: z.number().int().positive().max(MAX_UPDATE_BYTES), target }));
    return c.json(await applyUpdate(input));
  });

  app.post("/api/link/update/download", async (c) => {
    const input = await body(c, z.object({ key: z.string().min(1).max(200), target, site: z.string().url().max(200).optional() }));
    return c.json(await downloadUpdate(input));
  });

  app.get("/api/link/updates", async (c) => c.json(await checkUpdates(c.req.query("refresh") === "1")));

  app.post("/api/link/updates/install", async (c) => c.json(await installUpdates()));

  app.post("/api/link/forget", (c) => {
    const controllerId = viaLink(c);
    // Answered first: forgetting closes the link this answer travels on.
    if (controllerId) setTimeout(() => forgetController(controllerId), 50);
    return c.json({ ok: true as const });
  });
}
