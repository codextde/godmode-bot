import type { Hono } from "hono";
import {
  cancelPairing,
  connectRunner,
  createPairing,
  fixRunner,
  getRunner,
  listRunners,
  pairWithCode,
  removeRunner,
  runnerHealth,
  startAutofix,
  syncRunner,
  updateRunner,
  updateRunnerNow,
} from "../../remote/runners";
import { body, z } from "../validate";

/** Runners: other computers that work for this Godmode (remote/runners.ts). Requests about their chats: remote/routing.ts. */
export function registerRunnerRoutes(app: Hono): void {
  app.get("/api/runners", (c) => c.json(listRunners()));

  // An install command that pairs the runner by itself (and the listener it reports back to).
  app.post("/api/runners/pairing", async (c) => c.json(await createPairing(), 201));
  app.delete("/api/runners/pairing", (c) => {
    cancelPairing();
    return c.json({ ok: true as const });
  });

  // Pair with a code the runner showed (`godmode runner pair`).
  app.post("/api/runners", async (c) => {
    const { code } = await body(c, z.object({ code: z.string().min(1).max(8192) }));
    return c.json(await pairWithCode(code), 201);
  });

  app.get("/api/runners/:id", (c) => c.json(getRunner(c.req.param("id"))));

  app.patch("/api/runners/:id", async (c) => {
    const patch = await body(
      c,
      z.object({
        name: z.string().max(80).optional(),
        addresses: z.array(z.string().max(253)).max(10).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        syncBrowser: z.boolean().optional(),
        autoUpdate: z.boolean().optional(),
      }),
    );
    return c.json(updateRunner(c.req.param("id"), patch));
  });

  app.delete("/api/runners/:id", async (c) => {
    await removeRunner(c.req.param("id"));
    return c.json({ ok: true as const });
  });

  app.post("/api/runners/:id/connect", (c) => c.json(connectRunner(c.req.param("id"))));

  app.post("/api/runners/:id/sync", async (c) => {
    const id = c.req.param("id");
    await syncRunner(id, { force: true });
    return c.json(getRunner(id));
  });

  // Its Godmode to this computer's, its tools to their newest; the progress follows as runner.updated.
  app.post("/api/runners/:id/update", async (c) => {
    const input = await body(c, z.object({ tools: z.boolean().optional() }));
    return c.json(await updateRunnerNow(c.req.param("id"), input));
  });

  app.get("/api/runners/:id/health", async (c) => c.json(await runnerHealth(c.req.param("id"), c.req.query("refresh") === "1")));

  app.post("/api/runners/:id/health/fix", async (c) => {
    const { id } = await body(c, z.object({ id: z.string().min(1).max(64) }));
    return c.json(await fixRunner(c.req.param("id"), id));
  });

  app.post("/api/runners/:id/autofix", async (c) => {
    const input = await body(c, z.object({ checkId: z.string().max(64).optional(), note: z.string().max(4000).optional() }));
    return c.json(await startAutofix(c.req.param("id"), input), 201);
  });
}
