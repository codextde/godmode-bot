import type { Hono } from "hono";
import { licenseState, licenseUsage, refreshLicense, removeLicenseKey, setLicenseKey } from "../../license/license";
import { body, z } from "../validate";

export function registerLicenseRoutes(app: Hono) {
  app.get("/api/license", (c) => c.json(licenseState()));

  app.get("/api/license/usage", (c) => c.json(licenseUsage()));

  app.put("/api/license", async (c) => {
    const { key } = await body(c, z.object({ key: z.string().max(200) }));
    return c.json(await setLicenseKey(key));
  });

  app.delete("/api/license", (c) => c.json(removeLicenseKey()));

  app.post("/api/license/refresh", async (c) => c.json(await refreshLicense()));
}
