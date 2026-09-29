import type { Hono } from "hono";
import { MAX_TASK_DESCRIPTION_LENGTH, MAX_TASK_TITLE_LENGTH, TASK_STATUSES, TASK_TYPES } from "@godmode/shared";
import { createTask, deleteTask, getTask, listTasks, sendTaskMessage, updateTask } from "../../tasks/service";
import { body, z } from "../validate";

const id = z.string().trim().min(1).max(100);
const status = z.enum(TASK_STATUSES as [string, ...string[]]);
const type = z.enum(TASK_TYPES as [string, ...string[]]);

const createSchema = z.object({
  workspaceId: id.nullable().optional(),
  title: z.string().max(MAX_TASK_TITLE_LENGTH * 2),
  description: z.string().max(MAX_TASK_DESCRIPTION_LENGTH).optional(),
  type: type.optional(),
  status: status.optional(),
  agentId: id.nullable().optional(),
  repoUrl: z.string().max(1000).optional(),
  baseBranch: z.string().max(200).optional(),
});

const patchSchema = z.object({
  title: z.string().max(MAX_TASK_TITLE_LENGTH * 2).optional(),
  description: z.string().max(MAX_TASK_DESCRIPTION_LENGTH).optional(),
  type: type.optional(),
  status: status.optional(),
  beforeId: id.nullable().optional(),
  agentId: id.nullable().optional(),
  repoUrl: z.string().max(1000).optional(),
  baseBranch: z.string().max(200).optional(),
});

export function registerTaskRoutes(app: Hono): void {
  app.get("/api/tasks", (c) => c.json(listTasks({ workspaceId: c.req.query("workspaceId") || "all" })));

  app.get("/api/tasks/:id", (c) => c.json(getTask(c.req.param("id"))));

  app.post("/api/tasks", async (c) => c.json(createTask((await body(c, createSchema)) as Parameters<typeof createTask>[0])));

  app.patch("/api/tasks/:id", async (c) =>
    c.json(updateTask(c.req.param("id"), (await body(c, patchSchema)) as Parameters<typeof updateTask>[1])),
  );

  app.delete("/api/tasks/:id", async (c) => {
    await deleteTask(c.req.param("id"));
    return c.json({ ok: true as const });
  });

  app.post("/api/tasks/:id/messages", async (c) => {
    const { content } = await body(c, z.object({ content: z.string().min(1).max(100_000) }));
    return c.json(await sendTaskMessage(c.req.param("id"), content));
  });
}
