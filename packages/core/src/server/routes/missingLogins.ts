import type { Hono } from "hono";
import { linkTotpToMissingLogin, listMissingLogins, totpChoicesForMissingLogin, updateMissingLogin } from "../../services/missingLogins";
import { body, z } from "../validate";

const patchSchema = z.object({
  status: z.enum(["open", "resolved", "dismissed"]).optional(),
  credentialId: z.string().min(1).nullable().optional(),
});

const linkTotpSchema = z.object({
  totpId: z.string().min(1),
  credentialId: z.string().min(1).optional(),
});

export function registerMissingLoginRoutes(app: Hono): void {
  app.get("/api/missing-logins", (c) => c.json(listMissingLogins({ status: c.req.query("status") || undefined })));

  app.patch("/api/missing-logins/:id", async (c) => c.json(updateMissingLogin(c.req.param("id"), await body(c, patchSchema))));

  app.get("/api/missing-logins/:id/totp-choices", (c) => c.json(totpChoicesForMissingLogin(c.req.param("id"))));

  app.post("/api/missing-logins/:id/link-totp", async (c) => c.json(linkTotpToMissingLogin(c.req.param("id"), await body(c, linkTotpSchema))));
}
