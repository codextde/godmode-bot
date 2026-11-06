import type { Context, Hono } from "hono";
import { EXPO_PUSH_TOKEN, type MobileDevice, type MobileSession } from "@godmode/shared";
import { isCloudOnline, phoneGatewayUrl } from "../../cloud/state";
import { phonePeers } from "../../remote/devices";
import { mobileStatus, mobileUrls, refreshMobileAccess } from "../../mobile/access";
import { cancelPairingOffer, claimPairing, createPairingOffer, getDevice, instanceInfo, renameDevice, revokeDevice, setDeviceFullAccess, setDevicePushToken } from "../../mobile/devices";
import { getSettings, updateSettings } from "../../services/settings";
import { HttpError, conflict } from "../../util";
import { clientIp, isLimitedPhone, isOwnComputer, rateLimitLogin, requestDevice, requestVia, resetLoginAttempts } from "../auth";
import { body, z } from "../validate";

const port = z.number().int().min(1024).max(65535);

/** The computer, or a phone with full access. */
function onlyComputer(c: Context) {
  if (isLimitedPhone(c)) throw new HttpError(403, "The phone app can't do this. Use Godmode on your computer.", "device_forbidden");
}

function session(device: MobileDevice): MobileSession {
  const group = phonePeers();
  return { device, instance: instanceInfo(), fullAccess: device.fullAccess, urls: mobileUrls(), ...(group.length ? { group } : {}) };
}

function phoneOf(c: Context): MobileDevice {
  const device = requestDevice(c);
  if (!device) throw new HttpError(400, "Only for the phone app", "not_a_phone");
  return device;
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

  /** A QR code for pairing a phone. Turns phone access on; needs Tailscale, or the cloud link online with its phone gateway. */
  app.post("/api/mobile/pairing", async (c) => {
    onlyComputer(c);
    if (!getSettings().mobile.enabled) updateSettings({ mobile: { enabled: true } });
    const status = await mobileStatus(true);
    const gateway = phoneGatewayUrl();
    const tailscale = status.urls.filter((url) => url !== gateway);
    if (!tailscale.length && !(gateway && isCloudOnline())) {
      throw conflict(
        gateway ? "Godmode Cloud can't be reached right now and Tailscale isn't connected, so phones can't reach Godmode yet." : (status.error ?? "Phones can't reach Godmode yet."),
      );
    }
    return c.json(createPairingOffer(mobileUrls()), 201);
  });

  app.delete("/api/mobile/pairing", (c) => {
    onlyComputer(c);
    cancelPairingOffer();
    return c.json({ ok: true as const });
  });

  /** Renames a phone, or switches its full access: on only from this computer's own app or dashboard. */
  app.patch("/api/mobile/devices/:id", async (c) => {
    onlyComputer(c);
    const { name, fullAccess } = await body(
      c,
      z
        .object({ name: z.string().trim().min(1).max(80).optional(), fullAccess: z.boolean().optional() })
        .strict()
        .refine((v) => v.name !== undefined || v.fullAccess !== undefined, "Nothing to change"),
    );
    const id = c.req.param("id");
    if (fullAccess && !isOwnComputer(c)) throw new HttpError(403, "Only Godmode on this computer can give a phone full access.", "computer_only");
    if (name !== undefined) renameDevice(id, name);
    if (fullAccess !== undefined) setDeviceFullAccess(id, fullAccess, "user", requestVia(c));
    return c.json(getDevice(id));
  });

  app.delete("/api/mobile/devices/:id", (c) => {
    onlyComputer(c);
    revokeDevice(c.req.param("id"));
    return c.json({ ok: true as const });
  });

  /** The phone asking who it is and which computer it controls. */
  app.get("/api/mobile/me", (c) => c.json(session(phoneOf(c))));

  /** The phone switches its own full access off; only the computer switches it on. */
  app.patch("/api/mobile/me", async (c) => {
    const device = phoneOf(c);
    const { fullAccess } = await body(c, z.object({ fullAccess: z.boolean() }).strict());
    if (fullAccess) throw new HttpError(403, "Only Godmode on your computer can give a phone full access.", "device_forbidden");
    return c.json(session(setDeviceFullAccess(device.id, false, `device:${device.id}`, requestVia(c))));
  });

  /** The phone unpairs itself. */
  app.delete("/api/mobile/me", (c) => {
    const device = phoneOf(c);
    revokeDevice(device.id, `device:${device.id}`);
    return c.json({ ok: true as const });
  });

  /** The phone switches its notifications on with its Expo push token (mobile/push.ts), or off. */
  app.post("/api/mobile/me/push", async (c) => {
    const device = phoneOf(c);
    const { token } = await body(c, z.object({ token: z.string().max(240).regex(EXPO_PUSH_TOKEN, "Not an Expo push token"), platform: z.enum(["ios", "android"]) }).strict());
    return c.json(session(setDevicePushToken(device.id, token)));
  });

  app.delete("/api/mobile/me/push", (c) => {
    const device = phoneOf(c);
    return c.json(session(setDevicePushToken(device.id, null)));
  });
}
