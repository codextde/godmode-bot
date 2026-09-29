import type { Hono } from "hono";
import { MAX_INSTRUCTIONS_LENGTH } from "@godmode/shared";
import { createWorkspace, deleteWorkspace, listWorkspaces, updateWorkspace } from "../../services/workspaces";
import { MAX_SOURCES, syncSource } from "../../services/workspaceSources";
import { body, z } from "../validate";

const sourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("folder"), path: z.string().max(4096) }),
  z.object({ kind: z.literal("git"), url: z.string().max(2048), branch: z.string().max(200).nullable().optional() }),
]);

const workspaceSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  description: z.string().max(2000).optional(),
  color: z.string().trim().max(32).optional(),
  icon: z.string().trim().max(64).optional(),
  instructions: z.string().max(MAX_INSTRUCTIONS_LENGTH).optional(),
  vmId: z.string().trim().max(100).nullable().optional(),
  browserProfileId: z.string().trim().max(100).nullable().optional(),
  sources: z.array(sourceSchema).max(MAX_SOURCES, `A workspace can have up to ${MAX_SOURCES} folders and repositories.`).optional(),
});

export function registerWorkspaceRoutes(app: Hono): void {
  app.get("/api/workspaces", (c) => c.json(listWorkspaces()));

  app.post("/api/workspaces", async (c) => c.json(createWorkspace(await body(c, workspaceSchema))));

  app.patch("/api/workspaces/:id", async (c) => c.json(updateWorkspace(c.req.param("id"), await body(c, workspaceSchema.partial()))));

  app.post("/api/workspaces/:id/sources/:sourceId/sync", (c) => c.json(syncSource(c.req.param("id"), c.req.param("sourceId"))));

  app.delete("/api/workspaces/:id", async (c) => {
    const force = ["1", "true"].includes(c.req.query("force") ?? "");
    await deleteWorkspace(c.req.param("id"), force);
    return c.json({ ok: true });
  });
}
