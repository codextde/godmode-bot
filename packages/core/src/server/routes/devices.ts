import type { Hono } from "hono";
import { createInvite, deviceGroup, handoff, joinGroup, leaveGroup, moveChat, primaryLink, removeDevice, retireRunner, setDefaultRunOn, setGroupSettings } from "../../remote/devices";
import { isSecondary } from "../../remote/group";
import { body, z } from "../validate";

const deviceId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);

/** Device groups: the full Godmode apps of several computers working as one (remote/devices.ts). */
export function registerDeviceRoutes(app: Hono): void {
  app.get("/api/devices", async (c) => c.json(await deviceGroup()));

  app.patch("/api/devices", async (c) => {
    const input = await body(
      c,
      z.object({
        defaultRunOn: deviceId.nullable().optional(),
        failover: z.boolean().optional(),
        failoverMinutes: z.number().int().min(1).max(120).optional(),
        standInEnabled: z.boolean().optional(),
        standInMinutes: z.number().int().min(1).max(60).optional(),
        browserSignIns: z.enum(["own", "seed"]).optional(),
      }),
    );
    if (input.defaultRunOn !== undefined) setDefaultRunOn(input.defaultRunOn);
    const { defaultRunOn: _here, ...group } = input;
    if (Object.values(group).some((v) => v !== undefined)) {
      // The primary keeps the group's settings; its secondaries keep a copy for while it is away.
      if (isSecondary()) await primaryLink().json("PATCH", "/api/devices", group);
      else setGroupSettings(group);
    }
    return c.json(await deviceGroup());
  });

  // The computer runs the app of the group now: its old runner goes, its chats move to the app.
  app.post("/api/devices/retire-runner", async (c) => {
    const { runnerId } = await body(c, z.object({ runnerId: deviceId }));
    return c.json(await retireRunner(runnerId));
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
