import type { Hono } from "hono";
import { generateKeyPair, listLocalKeys } from "../../ssh/keys";
import { assignServer, createServer, deleteServer, execForHuman, getServer, listServers, testServer, tryServer, updateServer } from "../../ssh/service";
import { disableIdleTimeout } from "../../mcp/http";
import { body, z } from "../validate";

const hostKey = z.object({ type: z.string().trim().max(60), fingerprint: z.string().trim().max(100) });

const fields = {
  name: z.string().max(100),
  host: z.string().max(300),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().max(100),
  auth: z.enum(["password", "key"]),
  password: z.string().max(1000).optional(),
  privateKey: z.string().max(64 * 1024).optional(),
  privateKeyPath: z.string().max(4096).optional(),
  passphrase: z.string().max(1000).optional(),
  description: z.string().max(4000).optional(),
  hostKey: hostKey.nullable().optional(),
};

const serverSchema = z.object(fields);
const patchSchema = z.object(fields).partial();

export function registerSshRoutes(app: Hono): void {
  app.get("/api/ssh/servers", (c) => c.json(listServers()));

  app.post("/api/ssh/servers", async (c) => c.json(createServer(await body(c, serverSchema)), 201));

  app.get("/api/ssh/servers/:id", (c) => c.json(getServer(c.req.param("id"))));

  app.patch("/api/ssh/servers/:id", async (c) => c.json(updateServer(c.req.param("id"), await body(c, patchSchema))));

  app.delete("/api/ssh/servers/:id", (c) => {
    deleteServer(c.req.param("id"));
    return c.json({ ok: true as const });
  });

  /** Sign in to a saved server (pins its host key the first time). */
  app.post("/api/ssh/servers/:id/test", async (c) => {
    disableIdleTimeout(c);
    return c.json(await testServer(c.req.param("id")));
  });

  /** Try settings before saving them; `id` fills in the secrets of a saved server. */
  app.post("/api/ssh/test", async (c) => {
    const input = await body(c, serverSchema.extend({ id: z.string().max(100).optional() }));
    disableIdleTimeout(c);
    return c.json(await tryServer(input));
  });

  app.post("/api/ssh/servers/:id/exec", async (c) => {
    const input = await body(c, z.object({ command: z.string().min(1).max(100_000), timeoutSeconds: z.number().int().min(1).max(600).optional() }));
    disableIdleTimeout(c);
    return c.json(await execForHuman(c.req.param("id"), input));
  });

  app.post("/api/ssh/servers/:id/assign", async (c) => {
    const input = await body(c, z.object({ kind: z.enum(["agent", "conversation"]), id: z.string().min(1).max(100), assigned: z.boolean() }));
    return c.json(await assignServer(c.req.param("id"), input));
  });

  /** Private keys in ~/.ssh on the computer running Godmode (to import one without copying it around). */
  app.get("/api/ssh/local-keys", (c) => c.json(listLocalKeys()));

  app.post("/api/ssh/keys", async (c) => {
    const input = await body(c, z.object({ comment: z.string().trim().max(100).optional() }));
    return c.json(generateKeyPair(input.comment || "godmode"));
  });
}
