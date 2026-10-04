import type { Hono } from "hono";
import {
  createConnection,
  deleteConnection,
  deleteUser,
  getConnection,
  listChats,
  listConnections,
  listUsers,
  setUserOwner,
  setUserStatus,
  updateConnection,
  verifyCredentials,
} from "../../messaging/service";
import { teamsAppPackage } from "../../messaging/teams";
import { badRequest } from "../../util";
import { requireGrant } from "../grants";
import { body, z } from "../validate";

const credentials = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("telegram"), botToken: z.string().trim().min(1).max(200) }),
  z.object({ provider: z.literal("slack"), botToken: z.string().trim().min(1).max(300), appToken: z.string().trim().min(1).max(300) }),
  z.object({
    provider: z.literal("teams"),
    appId: z.string().trim().min(1).max(100),
    appPassword: z.string().min(1).max(500),
    tenantId: z.string().trim().min(1).max(100),
  }),
]);
const access = z.enum(["approved", "anyone"]);
const agentIds = z.array(z.string().min(1).max(100)).max(50);
const publicUrl = z.string().max(2048);

const createSchema = z.object({
  credentials,
  name: z.string().trim().max(100).optional(),
  agentIds,
  defaultAgentId: z.string().min(1).max(100).nullable().optional(),
  access: access.optional(),
  publicUrl: publicUrl.optional(),
});

const patchSchema = z.object({
  name: z.string().max(100).optional(),
  enabled: z.boolean().optional(),
  agentIds: agentIds.optional(),
  defaultAgentId: z.string().min(1).max(100).nullable().optional(),
  access: access.optional(),
  credentials: credentials.optional(),
  publicUrl: publicUrl.optional(),
});

export function registerMessagingRoutes(app: Hono): void {
  app.get("/api/messaging", (c) => c.json(listConnections()));

  app.post("/api/messaging/verify", async (c) => {
    const input = await body(c, z.object({ credentials }));
    return c.json(await verifyCredentials(input.credentials));
  });

  app.post("/api/messaging", async (c) => {
    const input = await body(c, createSchema);
    // Letting everyone who finds the bot use the agents (and their logins) is as sensitive as revealing secrets.
    if (input.access === "anyone") requireGrant(c);
    return c.json(await createConnection(input), 201);
  });

  app.get("/api/messaging/:id", (c) => c.json(getConnection(c.req.param("id"))));

  app.patch("/api/messaging/:id", async (c) => {
    const patch = await body(c, patchSchema);
    const current = getConnection(c.req.param("id"));
    const open = (patch.access ?? current.access) === "anyone";
    const widens =
      (patch.access === "anyone" && current.access !== "anyone") ||
      (open && patch.enabled === true && !current.enabled) ||
      (open && !!patch.agentIds?.some((id) => !current.agentIds.includes(id)));
    if (widens) requireGrant(c);
    return c.json(await updateConnection(c.req.param("id"), patch));
  });

  app.delete("/api/messaging/:id", async (c) => {
    await deleteConnection(c.req.param("id"));
    return c.json({ ok: true as const });
  });

  app.get("/api/messaging/:id/users", (c) => c.json(listUsers(c.req.param("id"))));

  app.patch("/api/messaging/:id/users/:userId", async (c) => {
    const patch = await body(
      c,
      z
        .object({ status: z.enum(["pending", "approved", "blocked"]).optional(), isOwner: z.boolean().optional() })
        .refine((v) => v.status !== undefined || v.isOwner !== undefined, "Nothing to change"),
    );
    const id = c.req.param("id");
    const userId = c.req.param("userId");
    let user = patch.status !== undefined ? await setUserStatus(id, userId, patch.status) : null;
    if (patch.isOwner !== undefined && (patch.isOwner ? user?.status !== "blocked" : true)) user = await setUserOwner(id, userId, patch.isOwner);
    return c.json(user);
  });

  app.delete("/api/messaging/:id/users/:userId", (c) => {
    deleteUser(c.req.param("id"), c.req.param("userId"));
    return c.json({ ok: true as const });
  });

  app.get("/api/messaging/:id/chats", (c) => c.json(listChats(c.req.param("id"))));

  app.get("/api/messaging/:id/teams-app", (c) => {
    const conn = getConnection(c.req.param("id"));
    if (conn.provider !== "teams" || !conn.config.appId) throw badRequest("Only Microsoft Teams bots have an app package");
    const zip = teamsAppPackage({ appId: conn.config.appId, name: conn.name, publicUrl: conn.config.publicUrl ?? "" });
    const file = `${conn.name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "godmode"}-teams-app.zip`;
    return c.body(zip, 200, { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${file}"` });
  });
}
