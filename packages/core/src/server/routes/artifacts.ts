import type { Hono } from "hono";
import {
  deleteArtifact,
  getArtifact,
  getArtifactVersion,
  listArtifacts,
  listArtifactVersions,
  messageArtifact,
  patchArtifact,
  refreshArtifact,
  restoreArtifactVersion,
  saveArtifactData,
  startArtifact,
} from "../../services/artifacts";
import { badRequest } from "../../util";
import { body, z } from "../validate";

const patchSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  description: z.string().max(1000).optional(),
  pinned: z.boolean().optional(),
  refreshPrompt: z.string().max(4000).optional(),
});

const dataSchema = z.object({ data: z.unknown().refine((v) => v !== undefined, "data is required"), version: z.number().int().optional() });
const messageSchema = z.object({ content: z.string().min(1).max(20_000), source: z.enum(["human", "app"]).optional() });
const restoreSchema = z.object({ version: z.number().int().min(1) });
const startSchema = z.object({
  prompt: z.string().min(1).max(20_000),
  agentId: z.string().max(100).optional(),
  workspaceId: z.string().max(100).nullable().optional(),
});

function versionParam(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw badRequest("Unknown version");
  return n;
}

export function registerArtifactRoutes(app: Hono): void {
  app.get("/api/artifacts", (c) =>
    c.json(
      listArtifacts({
        workspaceId: c.req.query("workspaceId") || undefined,
        agentId: c.req.query("agentId") || undefined,
        conversationId: c.req.query("conversationId") || undefined,
      }),
    ),
  );

  app.post("/api/artifacts/start", async (c) => c.json(await startArtifact(await body(c, startSchema)), 201));

  app.get("/api/artifacts/:id", (c) => c.json(getArtifact(c.req.param("id"))));

  app.patch("/api/artifacts/:id", async (c) => c.json(patchArtifact(c.req.param("id"), await body(c, patchSchema))));

  app.put("/api/artifacts/:id/data", async (c) => c.json(saveArtifactData(c.req.param("id"), (await body(c, dataSchema)).data)));

  app.get("/api/artifacts/:id/versions", (c) => c.json(listArtifactVersions(c.req.param("id"))));

  app.get("/api/artifacts/:id/versions/:version", (c) => c.json(getArtifactVersion(c.req.param("id"), versionParam(c.req.param("version")))));

  app.post("/api/artifacts/:id/restore", async (c) => c.json(restoreArtifactVersion(c.req.param("id"), (await body(c, restoreSchema)).version)));

  app.post("/api/artifacts/:id/message", async (c) => {
    const input = await body(c, messageSchema);
    return c.json(await messageArtifact(c.req.param("id"), input.content, input.source));
  });

  app.post("/api/artifacts/:id/refresh", async (c) => c.json(await refreshArtifact(c.req.param("id"))));

  app.delete("/api/artifacts/:id", (c) => {
    deleteArtifact(c.req.param("id"));
    return c.json({ ok: true });
  });
}
