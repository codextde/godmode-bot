import type { Hono } from "hono";
import { ANDROID_KEYS, type AndroidInputEvent } from "@godmode/shared";
import {
  androidStatus,
  assignDevice,
  connectWifi,
  disconnectWifi,
  execForHuman,
  forgetDevice,
  freshDevices,
  getDevice,
  installAndroidTools,
  noticeFailure,
  refreshDevices,
  serialOf,
  updateDevice,
} from "../../android/service";
import { AdbError } from "../../android/adb";
import { longPress, pressKey, screenSize, screenshot, swipe, tap, typeText, untypable } from "../../android/screen";
import { requestKeyframe, setViewers } from "../../android/stream";
import { disableIdleTimeout } from "../../mcp/http";
import { setAndroidViewHandlers } from "../ws";
import { badRequest, conflict } from "../../util";
import { body, z } from "../validate";

const point = { x: z.number(), y: z.number() };

const inputEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tap"), ...point }),
  z.object({ type: z.literal("long_press"), ...point, durationMs: z.number().int().min(300).max(10_000).optional() }),
  z.object({ type: z.literal("swipe"), ...point, toX: z.number(), toY: z.number(), durationMs: z.number().int().min(10).max(10_000).optional() }),
  z.object({ type: z.literal("key"), key: z.enum(ANDROID_KEYS) }),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(10_000) }),
]);

/** Device errors become answers the app can show. */
function deviceProblem(err: unknown): never {
  if (err instanceof AdbError) {
    noticeFailure(err);
    throw conflict(err.message);
  }
  throw err;
}

/** The human's touch on the live view: coordinates of the picture they saw, mapped to the phone's pixels. */
async function humanInput(id: string, event: AndroidInputEvent, frame?: { width: number; height: number }): Promise<void> {
  const serial = serialOf(id);
  try {
    if (event.type === "key") return await pressKey(serial, event.key);
    if (event.type === "text") {
      const bad = untypable(event.text);
      if (bad.length) throw badRequest(`Only plain ASCII can be typed over adb (not ${bad.slice(0, 6).join(" ")}). Use the phone's own keyboard for those.`);
      return await typeText(serial, event.text);
    }
    const screen = await screenSize(serial);
    const sx = frame?.width ? screen.width / frame.width : 1;
    const sy = frame?.height ? screen.height / frame.height : 1;
    const at = (x: number, y: number) => {
      const p = { x: x * sx, y: y * sy };
      if (p.x < 0 || p.y < 0 || p.x > screen.width || p.y > screen.height) throw badRequest("That point is outside the screen.");
      return p;
    };
    if (event.type === "tap") {
      const p = at(event.x, event.y);
      return await tap(serial, p.x, p.y);
    }
    if (event.type === "long_press") {
      const p = at(event.x, event.y);
      return await longPress(serial, p.x, p.y, event.durationMs ?? 800);
    }
    return await swipe(serial, at(event.x, event.y), at(event.toX, event.toY), event.durationMs ?? 300);
  } catch (err) {
    deviceProblem(err);
  }
}

export function registerAndroidRoutes(app: Hono): void {
  setAndroidViewHandlers({ viewers: setViewers, keyframe: requestKeyframe });

  app.get("/api/android/status", async (c) => c.json(await androidStatus()));

  app.get("/api/android/devices", async (c) => c.json(await freshDevices()));

  app.post("/api/android/refresh", async (c) => {
    await refreshDevices({ startServer: true });
    return c.json(await androidStatus());
  });

  /** Download Google's platform-tools (adb) into Godmode's data directory. */
  app.post("/api/android/install", async (c) => {
    disableIdleTimeout(c);
    return c.json(await installAndroidTools());
  });

  /** Reach a phone over Wi-Fi (Developer options → Wireless debugging), pairing it first when a code is given. */
  app.post("/api/android/connect", async (c) => {
    const input = await body(
      c,
      z.object({
        host: z.string().trim().min(1).max(253),
        port: z.number().int().min(1).max(65535).optional(),
        pairingCode: z.string().trim().max(10).optional(),
        pairingPort: z.number().int().min(1).max(65535).optional(),
      }),
    );
    disableIdleTimeout(c);
    return c.json(await connectWifi(input));
  });

  app.get("/api/android/devices/:id", (c) => c.json(getDevice(c.req.param("id"))));

  app.patch("/api/android/devices/:id", async (c) => {
    const patch = await body(c, z.object({ name: z.string().max(100).optional(), description: z.string().max(4000).optional() }));
    return c.json(updateDevice(c.req.param("id"), patch));
  });

  app.delete("/api/android/devices/:id", (c) => {
    forgetDevice(c.req.param("id"));
    return c.json({ ok: true as const });
  });

  app.post("/api/android/devices/:id/disconnect", async (c) => {
    await disconnectWifi(c.req.param("id"));
    return c.json(getDevice(c.req.param("id")));
  });

  /** A picture of the phone's screen, for previews. */
  app.get("/api/android/devices/:id/screenshot", async (c) => {
    const size = Number(c.req.query("size") ?? 480);
    if (!Number.isFinite(size) || size < 64 || size > 1568) throw badRequest("size must be between 64 and 1568");
    const serial = serialOf(c.req.param("id"));
    try {
      const shot = await screenshot(serial, size, { level: 1 });
      return c.json({ data: shot.data, mime: "image/png" as const, width: shot.width, height: shot.height, screen: shot.screen });
    } catch (err) {
      deviceProblem(err);
    }
  });

  /** Human takeover in the live view: taps, swipes, keys and text. */
  app.post("/api/android/devices/:id/input", async (c) => {
    const input = await body(c, z.object({ event: inputEvent, frame: z.object({ width: z.number().positive(), height: z.number().positive() }).optional() }));
    await humanInput(c.req.param("id"), input.event, input.frame);
    return c.json({ ok: true as const });
  });

  app.post("/api/android/devices/:id/exec", async (c) => {
    const input = await body(c, z.object({ command: z.string().min(1).max(100_000), timeoutSeconds: z.number().int().min(1).max(600).optional() }));
    disableIdleTimeout(c);
    return c.json(await execForHuman(c.req.param("id"), input));
  });

  app.post("/api/android/devices/:id/assign", async (c) => {
    const input = await body(c, z.object({ kind: z.enum(["agent", "conversation"]), id: z.string().min(1).max(100), assigned: z.boolean() }));
    return c.json(await assignDevice(c.req.param("id"), input));
  });
}
