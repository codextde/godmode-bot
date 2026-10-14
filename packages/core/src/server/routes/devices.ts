import type { Hono } from "hono";
import { createInvite, deviceGroup, handoff, joinGroup, leaveGroup, moveChat, primaryLink, removeDevice, setDefaultRunOn, setFailover } from "../../remote/devices";
import { isSecondary } from "../../remote/group";
import { body, z } from "../validate";

const deviceId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);

/** Device groups: the full Godmode apps of several computers working as one (remote/devices.ts). */
export function registerDeviceRoutes(app: Hono): void {
  app.get("/api/devices", async (c) => c.json(await deviceGroup()));

  app.patch("/api/devices", async (c) => {
    const input = await body(
      c,
      z.object({ defaultRunOn: deviceId.nullable().optional(), failover: z.boolean().optional(), failoverMinutes: z.number().int().min(1).max(120).optional() }),
    );
    if (input.defaultRunOn !== undefined) setDefaultRunOn(input.defaultRunOn);
    if (input.failover !== undefined || input.failoverMinutes !== undefined) {
      const change = { failover: input.failover, failoverMinutes: input.failoverMinutes };
      // The primary takes over the work: it keeps the setting.
      if (isSecondary()) await primaryLink().json("PATCH", "/api/devices", change);
      else setFailover(change);
    }
    return c.json(await deviceGroup());
  });

  app.post("/api/devices/invite", async (c) => c.json(await createInvite(), 201));

  app.post("/api/devices/join", async (c) => {
    const { code } = await body(c, z.object({ code: z.string().min(10).max(8192) }));
    return c.json(await joinGroup(code));
  });

  app.post("/api/devices/leave", async (c) => c.json(await leaveGroup()));

  app.delete("/api/devices/:id", async (c) => c.json(await removeDevice(c.req.param("id"))));

  // Before a computer goes away (the lid closes): its working chats continue on another one.
  app.post("/api/devices/handoff", async (c) => {
    const input = await body(c, z.object({ from: deviceId.nullable(), to: deviceId.nullable() }));
    return c.json(await handoff(input.from, input.to));
  });

  app.post("/api/conversations/:id/move", async (c) => {
    const input = await body(c, z.object({ to: deviceId.nullable(), force: z.boolean().optional() }));
    return c.json(await moveChat(c.req.param("id"), input));
  });
}
