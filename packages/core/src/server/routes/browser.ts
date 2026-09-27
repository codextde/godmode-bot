import type { Hono } from "hono";
import {
  createProfile,
  deleteProfile,
  getProfile,
  importChromeSession,
  launchBrowser,
  listLocalChromeProfiles,
  listProfiles,
  navigate,
  stopBrowser,
  updateProfile,
} from "../../browser/manager";
import { dispatchInput, initLiveView } from "../../browser/screencast";
import { installProfileUse, profileUseStatus, syncWithProfileUse } from "../../browser/profileUse";
import { body, z } from "../validate";

const inputEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), x: z.number().finite(), y: z.number().finite() }),
  z.object({ type: z.literal("scroll"), x: z.number().finite(), y: z.number().finite(), deltaY: z.number().finite() }),
  z.object({ type: z.literal("key"), key: z.string().min(1).max(32) }),
  z.object({ type: z.literal("text"), text: z.string().max(10_000) }),
]);

export function registerBrowserRoutes(app: Hono): void {
  initLiveView();

  app.get("/api/browser/profiles", (c) => c.json(listProfiles()));

  app.post("/api/browser/profiles", async (c) => {
    const input = await body(c, z.object({ name: z.string().min(1).max(80), workspaceId: z.string().nullable().optional() }));
    return c.json(createProfile({ name: input.name, workspaceId: input.workspaceId ?? null }), 201);
  });

  app.get("/api/browser/profiles/:id", (c) => c.json(getProfile(c.req.param("id"))));

  app.patch("/api/browser/profiles/:id", async (c) => {
    const patch = await body(c, z.object({ name: z.string().min(1).max(80).optional(), isDefault: z.boolean().optional() }));
    return c.json(updateProfile(c.req.param("id"), patch));
  });

  app.delete("/api/browser/profiles/:id", async (c) => {
    await deleteProfile(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/browser/profiles/:id/launch", async (c) => {
    const { headless } = await body(c, z.object({ headless: z.boolean().nullable().optional() }));
    return c.json(await launchBrowser(c.req.param("id"), headless == null ? {} : { headless }));
  });

  app.post("/api/browser/profiles/:id/stop", async (c) => {
    getProfile(c.req.param("id"));
    await stopBrowser(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/api/browser/chrome-profiles", async (c) => c.json(await listLocalChromeProfiles()));

  app.post("/api/browser/profiles/:id/import", async (c) => {
    const input = await body(
      c,
      z
        .object({
          sourcePath: z.string().max(4096).optional(),
          cookiesJson: z.string().max(20_000_000).optional(),
          domains: z.array(z.string().min(1).max(253)).max(500).optional(),
        })
        .refine((v) => !!(v.sourcePath?.trim() || v.cookiesJson?.trim()), { message: "Provide sourcePath or cookiesJson" }),
    );
    return c.json(await importChromeSession(c.req.param("id"), input));
  });

  app.post("/api/browser/profiles/:id/navigate", async (c) => {
    const { url } = await body(c, z.object({ url: z.string().min(1).max(8192) }));
    await navigate(c.req.param("id"), url);
    return c.json({ ok: true });
  });

  app.post("/api/browser/profiles/:id/input", async (c) => {
    const event = await body(c, inputEvent);
    getProfile(c.req.param("id"));
    await dispatchInput(c.req.param("id"), event);
    return c.json({ ok: true });
  });

  app.get("/api/browser/profile-use", (c) => c.json(profileUseStatus()));

  app.post("/api/browser/profile-use/install", async (c) => c.json(await installProfileUse()));

  app.post("/api/browser/profile-use/sync", async (c) => {
    const input = await body(
      c,
      z.object({
        sourcePath: z.string().min(1).max(4096).optional(),
        browser: z.string().min(1).max(100).optional(),
        profile: z.string().min(1).max(200).optional(),
        domains: z.array(z.string().min(1).max(253)).max(200).optional(),
        cloudProfileId: z.string().min(1).max(100).optional(),
      }),
    );
    return c.json(await syncWithProfileUse(input));
  });
}
