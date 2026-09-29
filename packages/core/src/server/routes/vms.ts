import type { Hono } from "hono";
import {
  assignVm,
  createVm,
  deleteVm,
  duplicateVm,
  execInVm,
  getVm,
  installTart,
  listVms,
  openVmScreen,
  openVmTerminal,
  resetVm,
  restartVm,
  revealVmFolder,
  startVm,
  stopVm,
  suspendVm,
  updateVm,
  vmStatus,
} from "../../vm/service";
import { captureScreen } from "../../vm/screen";
import { badRequest, conflict, sleep } from "../../util";
import { body, z } from "../validate";
import { disableIdleTimeout } from "../../mcp/http";

const name = z.string().trim().min(1, "Name is required").max(60);
const display = z.string().trim().regex(/^\d{3,4}x\d{3,4}$/, 'Display must look like "1440x900"');

const vmSchema = z.object({
  name,
  image: z.string().trim().max(300).optional(),
  cpu: z.number().int().min(1).max(64).optional(),
  memoryMb: z.number().int().min(2048).max(1024 * 1024).optional(),
  diskGb: z.number().int().min(20).max(4000).optional(),
  display: display.optional(),
  start: z.boolean().optional(),
});

const patchSchema = z.object({
  name: name.optional(),
  cpu: z.number().int().min(1).max(64).optional(),
  memoryMb: z.number().int().min(2048).max(1024 * 1024).optional(),
  diskGb: z.number().int().min(20).max(4000).optional(),
  display: display.optional(),
});

/**
 * Start in the background (booting takes a while; progress arrives as `vm.updated` events), but answer with the
 * error when the start fails right away (two VMs already running, disk missing, …).
 */
async function startSoon(id: string): Promise<void> {
  const started = startVm(id);
  const early = await Promise.race([started.then(() => null, (err: unknown) => err), sleep(1500).then(() => "pending" as const)]);
  if (early && early !== "pending") throw early;
  started.catch(() => undefined);
}

export function registerVmRoutes(app: Hono): void {
  app.get("/api/vms/status", async (c) => c.json(await vmStatus()));

  /** Download Godmode's own copy of Tart (pinned version, verified checksum). */
  app.post("/api/vms/install", async (c) => {
    disableIdleTimeout(c);
    return c.json(await installTart());
  });

  app.get("/api/vms", async (c) => c.json(await listVms()));

  app.post("/api/vms", async (c) => c.json(await createVm(await body(c, vmSchema)), 201));

  app.get("/api/vms/:id", async (c) => c.json(await getVm(c.req.param("id"))));

  app.patch("/api/vms/:id", async (c) => c.json(await updateVm(c.req.param("id"), await body(c, patchSchema))));

  app.delete("/api/vms/:id", async (c) => {
    const keepFiles = ["1", "true"].includes(c.req.query("keepFiles") ?? "");
    await deleteVm(c.req.param("id"), { keepFiles });
    return c.json({ ok: true as const });
  });

  app.post("/api/vms/:id/start", async (c) => {
    const id = c.req.param("id");
    await startSoon(id);
    return c.json(await getVm(id));
  });

  app.post("/api/vms/:id/stop", async (c) => {
    disableIdleTimeout(c);
    return c.json(await stopVm(c.req.param("id")));
  });

  app.post("/api/vms/:id/suspend", async (c) => c.json(await suspendVm(c.req.param("id"))));

  app.post("/api/vms/:id/restart", async (c) => {
    disableIdleTimeout(c);
    return c.json(await restartVm(c.req.param("id")));
  });

  /**
   * Recreate the disk from the VM's image (a clean macOS); keeps the shared folder and assignments. Answers once the
   * reset started (state "creating"); progress arrives as `vm.updated` events.
   */
  app.post("/api/vms/:id/reset", async (c) => {
    const input = await body(c, z.object({ start: z.boolean().optional() }));
    disableIdleTimeout(c);
    return c.json(await resetVm(c.req.param("id"), input));
  });

  app.post("/api/vms/:id/duplicate", async (c) => {
    const input = await body(c, z.object({ name: name.optional() }));
    disableIdleTimeout(c);
    return c.json(await duplicateVm(c.req.param("id"), input.name), 201);
  });

  app.post("/api/vms/:id/exec", async (c) => {
    const input = await body(
      c,
      z.object({ command: z.string().min(1).max(100_000), cwd: z.string().max(4096).optional(), timeoutSeconds: z.number().int().min(1).max(3600).optional() }),
    );
    disableIdleTimeout(c);
    return c.json(await execInVm(c.req.param("id"), input.command, { cwd: input.cwd, timeoutMs: (input.timeoutSeconds ?? 120) * 1000 }));
  });

  /** Show the VM on this Mac: its screen (Screen Sharing), a Terminal (SSH) or its shared folder (Finder). */
  app.post("/api/vms/:id/open", async (c) => {
    const { what } = await body(c, z.object({ what: z.enum(["screen", "terminal", "folder"]) }));
    const id = c.req.param("id");
    // Screen and Terminal boot a stopped VM first.
    disableIdleTimeout(c);
    if (what === "screen") await openVmScreen(id);
    else if (what === "terminal") await openVmTerminal(id);
    else revealVmFolder(id);
    return c.json({ ok: true as const });
  });

  /** A picture of the running VM's screen (never boots it), for previews. */
  app.get("/api/vms/:id/screenshot", async (c) => {
    const id = c.req.param("id");
    const size = Number(c.req.query("size") ?? 640);
    if (!Number.isFinite(size) || size < 64 || size > 1568) throw badRequest("size must be between 64 and 1568");
    const vm = await getVm(id);
    if (vm.state !== "running") throw conflict("The VM isn't running");
    const shot = await captureScreen(id, { maxEdge: size, fast: true, boot: false });
    return c.json({ data: shot.data, mime: "image/png", width: shot.width, height: shot.height });
  });

  app.post("/api/vms/:id/assign", async (c) => {
    const input = await body(c, z.object({ kind: z.enum(["agent", "conversation", "workspace"]), id: z.string().min(1).max(100), assigned: z.boolean() }));
    return c.json(await assignVm(c.req.param("id"), input));
  });
}
