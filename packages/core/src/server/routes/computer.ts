import type { Hono } from "hono";
import { computerStatus, listSources, requestComputerPermissions, thumbnail } from "../../computer/service";
import { dispatchComputerInput, initComputerLiveView } from "../../computer/liveView";
import { installCuaDriver, stopCuaDriver } from "../../computer/cua";
import { bus } from "../../events/bus";
import { resetDoctorCache } from "../../services/doctor";
import { badRequest } from "../../util";
import { body, z } from "../validate";

const view = z
  .string()
  .min(3)
  .max(300)
  .regex(/^(display|window|tab):/, "Invalid view");

const point = { x: z.number(), y: z.number() };

export const inputEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), ...point, button: z.enum(["left", "right", "middle"]).optional(), count: z.number().int().min(1).max(3).optional() }),
  z.object({ type: z.literal("move"), ...point }),
  z.object({ type: z.literal("drag"), ...point, toX: z.number(), toY: z.number() }),
  z.object({ type: z.literal("scroll"), ...point, deltaX: z.number().optional(), deltaY: z.number() }),
  z.object({ type: z.literal("key"), key: z.string().min(1).max(40), modifiers: z.array(z.string().max(16)).max(5).optional() }),
  z.object({ type: z.literal("text"), text: z.string().max(10_000) }),
]);

export function registerComputerRoutes(app: Hono): void {
  initComputerLiveView();

  app.get("/api/computer/status", async (c) => c.json(await computerStatus()));

  /** Displays, windows and browser tabs the human can share. */
  app.get("/api/computer/sources", async (c) => c.json(await listSources()));

  app.get("/api/computer/thumbnail", async (c) => {
    const parsed = view.safeParse(c.req.query("view") ?? "");
    if (!parsed.success) throw badRequest("Invalid view");
    const size = Number(c.req.query("size") ?? 480);
    return c.json(await thumbnail(parsed.data, Number.isFinite(size) ? size : 480));
  });

  /** macOS: show the Accessibility and Screen Recording prompts for the app running Godmode. */
  app.post("/api/computer/permissions", async (c) => c.json(await requestComputerPermissions()));

  app.post("/api/computer/cua/install", async (c) => {
    const result = await installCuaDriver();
    resetDoctorCache();
    bus.changed("computer");
    return c.json(result);
  });

  app.post("/api/computer/cua/stop", async (c) => {
    await stopCuaDriver();
    bus.changed("computer");
    return c.json({ ok: true as const });
  });

  /** Human takeover in the live view. */
  app.post("/api/computer/input", async (c) => {
    const input = await body(
      c,
      z.object({ view, event: inputEvent, frame: z.object({ width: z.number().positive(), height: z.number().positive() }).optional() }),
    );
    await dispatchComputerInput(input.view, input.event, input.frame);
    return c.json({ ok: true as const });
  });
}
