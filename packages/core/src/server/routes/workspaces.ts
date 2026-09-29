import type { Hono } from "hono";
import { createWorkspace, deleteWorkspace, listWorkspaces, updateWorkspace } from "../../services/workspaces";
import { body, z } from "../validate";

const workspaceSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  description: z.string().max(2000).optional(),
  color: z.string().trim().max(32).optional(),
  icon: z.string().trim().max(64).optional(),
  instructions: z.string().max(20_000).optional(),
});

export function registerWorkspaceRoutes(app: Hono): void {
  app.get("/api/workspaces", (c) => c.json(listWorkspaces()));

  app.post("/api/workspaces", async (c) => c.json(createWorkspace(await body(c, workspaceSchema))));

  app.patch("/api/workspaces/:id", async (c) => c.json(updateWorkspace(c.req.param("id"), await body(c, workspaceSchema.partial()))));

  app.delete("/api/workspaces/:id", async (c) => {
    const force = ["1", "true"].includes(c.req.query("force") ?? "");
    await deleteWorkspace(c.req.param("id"), force);
    return c.json({ ok: true });
  });
}
