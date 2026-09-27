import type { Hono } from "hono";
import { listMissingLogins, updateMissingLogin } from "../../services/missingLogins";
import { body, z } from "../validate";

const patchSchema = z.object({
  status: z.enum(["open", "resolved", "dismissed"]).optional(),
  credentialId: z.string().min(1).nullable().optional(),
});

export function registerMissingLoginRoutes(app: Hono): void {
  app.get("/api/missing-logins", (c) => c.json(listMissingLogins({ status: c.req.query("status") || undefined })));

  app.patch("/api/missing-logins/:id", async (c) => c.json(updateMissingLogin(c.req.param("id"), await body(c, patchSchema))));
}
