import type { Context, Hono } from "hono";
import type { MobileSession } from "@godmode/shared";
import { mobileStatus, mobileUrls, refreshMobileAccess } from "../../mobile/access";
import { cancelPairingOffer, claimPairing, createPairingOffer, instanceInfo, renameDevice, revokeDevice } from "../../mobile/devices";
import { getSettings, updateSettings } from "../../services/settings";
import { HttpError, conflict } from "../../util";
import { clientIp, rateLimitLogin, requestDevice, resetLoginAttempts } from "../auth";
import { body, z } from "../validate";

const port = z.number().int().min(1024).max(65535);

function onlyComputer(c: Context) {
  if (requestDevice(c)) throw new HttpError(403, "The phone app can't do this. Use Godmode on your computer.", "device_forbidden");
}

export function registerMobileRoutes(app: Hono) {
  /** Public: the phone trades the code from the QR code for its device token. */
  app.post("/api/mobile/pair", async (c) => {
    const ip = clientIp(c);
    rateLimitLogin(ip);
    const input = await body(
      c,
      z.object({
        code: z.string().min(16).max(200),
        name: z.string().trim().min(1).max(80),
        platform: z.enum(["ios", "android"]),
        model: z.string().max(80).nullable().optional(),
        appVersion: z.string().max(40).nullable().optional(),
      }),
    );
    const result = claimPairing(input, ip);
    resetLoginAttempts(ip);
    return c.json(result, 201);
  });

  app.get("/api/mobile", async (c) => {
    onlyComputer(c);
    return c.json(await mobileStatus(c.req.query("refresh") === "1"));
  });

  app.put("/api/mobile", async (c) => {
    onlyComputer(c);
    const input = await body(c, z.object({ enabled: z.boolean().optional(), port: port.optional() }));
    updateSettings({ mobile: input });
    if (input.enabled === false) cancelPairingOffer();
    await refreshMobileAccess();
    return c.json(await mobileStatus());
  });

  /** A QR code for pairing a phone. Turns phone access on; needs Tailscale to be connected. */
  app.post("/api/mobile/pairing", async (c) => {
    onlyComputer(c);
    if (!getSettings().mobile.enabled) updateSettings({ mobile: { enabled: true } });
    const status = await mobileStatus(true);
    if (!status.urls.length) throw conflict(status.error ?? "Phones can't reach Godmode yet.");
    return c.json(createPairingOffer(mobileUrls()), 201);
  });

  app.delete("/api/mobile/pairing", (c) => {
    onlyComputer(c);
    cancelPairingOffer();
    return c.json({ ok: true as const });
  });

  app.patch("/api/mobile/devices/:id", async (c) => {
    onlyComputer(c);
    const { name } = await body(c, z.object({ name: z.string().trim().min(1).max(80) }));
    return c.json(renameDevice(c.req.param("id"), name));
  });

  app.delete("/api/mobile/devices/:id", (c) => {
    onlyComputer(c);
    revokeDevice(c.req.param("id"));
    return c.json({ ok: true as const });
  });

  /** The phone asking who it is and which computer it controls. */
  app.get("/api/mobile/me", (c) => {
    const device = requestDevice(c);
    if (!device) throw new HttpError(400, "Only for the phone app", "not_a_phone");
    return c.json({ device, instance: instanceInfo() } satisfies MobileSession);
  });

  /** The phone unpairs itself. */
  app.delete("/api/mobile/me", (c) => {
    const device = requestDevice(c);
    if (!device) throw new HttpError(400, "Only for the phone app", "not_a_phone");
    revokeDevice(device.id, `device:${device.id}`);
    return c.json({ ok: true as const });
  });
}
