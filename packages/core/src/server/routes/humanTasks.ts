import type { Hono } from "hono";
import { closeHumanTask, createOwnHumanTask, deleteHumanTask, getHumanTask, listHumanTasks, updateHumanTask, type HumanTaskFilter } from "../../services/humanTasks";
import { badRequest } from "../../util";
import { body, z } from "../validate";

const FILTERS: readonly HumanTaskFilter[] = ["active", "closed", "all"];

const attachmentSchema = z.object({
  name: z.string().min(1).max(255),
  mime: z.string().max(255).default("application/octet-stream"),
  data: z.string().min(1),
});

const createSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(6000).optional(),
  url: z.string().max(2000).nullable().optional(),
  priority: z.enum(["normal", "high"]).optional(),
  workspaceId: z.string().max(100).nullable().optional(),
});

const patchSchema = z.object({
  status: z.enum(["open", "doing"]).optional(),
  beforeId: z.string().max(100).nullable().optional(),
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(6000).optional(),
  url: z.string().max(2000).nullable().optional(),
  priority: z.enum(["normal", "high"]).optional(),
});

const closeSchema = z.object({
  outcome: z.enum(["done", "declined"]),
  note: z.string().max(20_000).optional(),
  attachments: z.array(attachmentSchema).max(10).optional(),
});

export function registerHumanTaskRoutes(app: Hono): void {
  app.get("/api/human-tasks", (c) => {
    const status = (c.req.query("status") || "all") as HumanTaskFilter;
    if (!FILTERS.includes(status)) throw badRequest(`Unknown status "${status}"`);
    return c.json(listHumanTasks({ status, conversationId: c.req.query("conversationId") || undefined, agentId: c.req.query("agentId") || undefined }));
  });

  app.post("/api/human-tasks", async (c) => c.json(createOwnHumanTask(await body(c, createSchema)), 201));

  app.get("/api/human-tasks/:id", (c) => c.json(getHumanTask(c.req.param("id"))));

  app.patch("/api/human-tasks/:id", async (c) => c.json(updateHumanTask(c.req.param("id"), await body(c, patchSchema))));

  app.post("/api/human-tasks/:id/close", async (c) => c.json(await closeHumanTask(c.req.param("id"), await body(c, closeSchema))));

  app.delete("/api/human-tasks/:id", (c) => {
    deleteHumanTask(c.req.param("id"));
    return c.json({ ok: true });
  });
}
