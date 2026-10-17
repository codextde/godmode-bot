import type { Hono } from "hono";
import { MAX_INSTRUCTIONS_LENGTH } from "@godmode/shared";
import { createWorkspace, deleteWorkspace, listWorkspaces, updateWorkspace } from "../../services/workspaces";
import { MAX_SOURCES, syncSource } from "../../services/workspaceSources";
import { createProject, deleteProject, getProject, listProjects, updateProject } from "../../services/projects";
import { SCOPE_ITEMS, VAULT_ITEMS, moveProject, moveWorkspace } from "../../services/scopeMoves";
import { get } from "../../db";
import { conflict } from "../../util";
import { requestDevice } from "../auth";
import { requireGrant } from "../grants";
import { isInitialized } from "../../vault/vault";
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
  autoMerge: z.boolean().optional(),
  sources: z.array(sourceSchema).max(MAX_SOURCES, `A workspace can have up to ${MAX_SOURCES} folders and repositories.`).optional(),
});

const projectSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  description: z.string().max(2000).optional(),
  color: z.string().trim().max(32).optional(),
  icon: z.string().trim().max(64).optional(),
  instructions: z.string().max(MAX_INSTRUCTIONS_LENGTH).optional(),
  browserProfileId: z.string().trim().max(100).nullable().optional(),
  sources: z.array(sourceSchema).max(MAX_SOURCES, `A project can have up to ${MAX_SOURCES} folders and repositories.`).optional(),
});

const ids = z.array(z.string().trim().min(1).max(100)).max(100_000);

const projectMoveSchema = z.object({
  workspaceId: z.string().trim().min(1).max(100).nullable(),
  restore: z
    .object({
      items: z.partialRecord(z.enum(Object.keys(SCOPE_ITEMS) as [keyof typeof SCOPE_ITEMS, ...(keyof typeof SCOPE_ITEMS)[]]), ids),
      projectIds: ids,
      vmId: z.string().trim().max(100).nullable(),
      autoMerge: z.boolean(),
    })
    .optional(),
  contextReviewed: z.boolean().optional(),
});

/** Logins, 2FA codes, passkeys and cards going to other agents: like changing their workspace, that takes the passphrase. */
const movesVaultItems = (workspaceId: string) =>
  VAULT_ITEMS.some((kind) => get(`SELECT 1 FROM ${SCOPE_ITEMS[kind].table} WHERE workspace_id = ? LIMIT 1`, workspaceId));

export function registerWorkspaceRoutes(app: Hono): void {
  app.get("/api/workspaces", (c) => c.json(listWorkspaces()));

  app.post("/api/workspaces", async (c) => c.json(createWorkspace(await body(c, workspaceSchema))));

  app.patch("/api/workspaces/:id", async (c) => c.json(updateWorkspace(c.req.param("id"), await body(c, workspaceSchema.partial()))));

  app.post("/api/workspaces/:id/sources/:sourceId/sync", (c) => c.json(syncSource(c.req.param("id"), c.req.param("sourceId"))));

  app.get("/api/projects", (c) => c.json(listProjects(c.req.query("workspaceId") || undefined)));

  app.post("/api/projects", async (c) =>
    c.json(createProject(await body(c, projectSchema.extend({ workspaceId: z.string().trim().min(1).max(100) }))), 201),
  );

  app.patch("/api/projects/:id", async (c) => {
    const id = c.req.param("id");
    const patch = await body(c, projectSchema.partial());
    if (patch.instructions === undefined) return c.json(updateProject(id, patch));
    // The human saved its instructions: what an agent wrote there is theirs now. Raw secrets for its runs take the passphrase.
    if (getProject(id).fillOnly && isInitialized()) requireGrant(c);
    return c.json(updateProject(id, patch, { fillOnly: false, offComputer: false }));
  });

  app.post("/api/projects/:id/sources/:sourceId/sync", (c) => {
    const project = getProject(c.req.param("id"));
    return c.json(syncSource(project.workspaceId, c.req.param("sourceId"), project.id));
  });

  app.post("/api/projects/:id/move", async (c) => {
    const id = c.req.param("id");
    const input = await body(c, projectMoveSchema);
    // Its context becomes a workspace's, which every run there gets: like saving it, that takes the passphrase.
    const promotesFillOnly = input.workspaceId === null && !input.restore && getProject(id).fillOnly;
    const restoresVault = VAULT_ITEMS.some((kind) => input.restore?.items[kind]?.length);
    if ((promotesFillOnly || restoresVault) && isInitialized()) requireGrant(c);
    return c.json(await moveProject(id, input));
  });

  app.post("/api/workspaces/:id/move", async (c) => {
    const id = c.req.param("id");
    const input = await body(c, z.object({ workspaceId: z.string().trim().min(1).max(100) }));
    if (movesVaultItems(id) && isInitialized()) requireGrant(c);
    return c.json(await moveWorkspace(id, input));
  });

  app.delete("/api/projects/:id", async (c) => {
    await deleteProject(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.delete("/api/workspaces/:id", async (c) => {
    const force = ["1", "true"].includes(c.req.query("force") ?? "");
    // Goals go with an otherwise empty workspace; from the phone that is only done on the computer.
    if (requestDevice(c) && get<{ c: number }>("SELECT COUNT(*) AS c FROM goals WHERE workspace_id = ?", c.req.param("id"))?.c) {
      throw conflict("This workspace has goals. Delete it on your computer.");
    }
    await deleteWorkspace(c.req.param("id"), force);
    return c.json({ ok: true });
  });
}
