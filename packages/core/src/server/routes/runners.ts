import type { Hono } from "hono";
import { connectRunner, getRunner, listRunners, moveChatHere, removeRunner, syncRunner, updateRunner, updateRunnerNow } from "../../remote/runners";
import { body, z } from "../validate";

/**
 * The other computers this Godmode has a link to: the computers of its device group, and runners paired before device
 * groups existed (no new ones are paired). Requests about their chats: remote/routing.ts.
 */
export function registerRunnerRoutes(app: Hono): void {
  app.get("/api/runners", (c) => c.json(listRunners()));

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

  // A chat on a runner moves to this computer (remote/routing.ts lets this request through to here).
  app.post("/api/conversations/:id/move-here", async (c) => c.json(await moveChatHere(c.req.param("id"))));
}
