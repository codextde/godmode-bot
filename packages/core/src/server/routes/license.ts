import type { Hono } from "hono";
import { licenseState, licenseUsage, refreshLicense, removeLicenseKey, removeReminderEmail, setLicenseKey, setReminderEmail } from "../../license/license";
import { isPhoneRequest } from "../auth";
import { body, z } from "../validate";

export function registerLicenseRoutes(app: Hono) {
  // The customer portal opens without a sign-in: a phone gets the state without it.
  app.get("/api/license", (c) => {
    const state = licenseState();
    return c.json(isPhoneRequest(c) ? { ...state, manageUrl: null } : state);
  });

  app.get("/api/license/usage", (c) => c.json(licenseUsage()));

  app.put("/api/license", async (c) => {
    const { key } = await body(c, z.object({ key: z.string().max(200) }));
    return c.json(await setLicenseKey(key));
  });

  app.delete("/api/license", (c) => c.json(removeLicenseKey()));

  app.post("/api/license/refresh", async (c) => c.json(await refreshLicense()));

  app.put("/api/license/reminders", async (c) => {
    const { email, locale } = await body(c, z.object({ email: z.string().max(320), locale: z.enum(["en", "de"]).default("en") }));
    return c.json(await setReminderEmail(email, locale));
  });

  app.delete("/api/license/reminders", async (c) => c.json(await removeReminderEmail()));
}
