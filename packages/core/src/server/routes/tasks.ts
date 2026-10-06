import type { Context, Hono } from "hono";
import { requestDevice } from "../auth";
import { MAX_GOAL_TITLE_LENGTH, MAX_GOAL_WHY_LENGTH, MAX_TASK_ATTACHMENT_BYTES, MAX_TASK_DESCRIPTION_LENGTH, MAX_TASK_TITLE_LENGTH, TASK_PRIORITIES, TASK_STATUSES, TASK_TYPES } from "@godmode/shared";
import { approveTask, archiveTasks, createTask, deleteTask, getTask, listTaskEvents, listTasks, pushTaskBranch, sendTaskMessage, updateTask } from "../../tasks/service";
import { readTaskAttachment, saveTaskAttachment } from "../../tasks/attachments";
import { HttpError, badRequest } from "../../util";
import { body, z } from "../validate";
import { expectSlow } from "../../mcp/http";
import { createGoal, deleteGoal, listGoals, updateGoal } from "../../tasks/goals";

/** Shown in the app (images, PDFs, plain text); anything else is only downloaded. */
const INLINE = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|application\/pdf|text\/plain)$/i;

async function attachmentUpload(c: Context): Promise<File> {
  const tooLarge = () => new HttpError(413, `The file is larger than ${MAX_TASK_ATTACHMENT_BYTES / 1024 / 1024} MB`, "too_large");
  if (Number(c.req.header("content-length") ?? 0) > MAX_TASK_ATTACHMENT_BYTES + 1024 * 1024) throw tooLarge();
  if (!(c.req.header("content-type") ?? "").includes("multipart/form-data")) throw badRequest("Upload the file as multipart/form-data with a `file` field");
  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    throw badRequest("Could not read the uploaded file");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw badRequest("Choose a file to attach");
  if (file.size > MAX_TASK_ATTACHMENT_BYTES) throw tooLarge();
  return file;
}

const id = z.string().trim().min(1).max(100);
const status = z.enum(TASK_STATUSES as [string, ...string[]]);
const type = z.enum(TASK_TYPES as [string, ...string[]]);
const ticket = {
  goalId: id.nullable().optional(),
  waitsFor: z.array(id).max(10).optional(),
  priority: z.enum(TASK_PRIORITIES as [string, ...string[]]).optional(),
  dueDate: z.string().max(10).nullable().optional(),
  labels: z.array(z.string().max(100)).max(50).optional(),
};

const createSchema = z.object({
  workspaceId: id.nullable().optional(),
  title: z.string().max(MAX_TASK_TITLE_LENGTH * 2),
  description: z.string().max(MAX_TASK_DESCRIPTION_LENGTH).optional(),
  type: type.optional(),
  status: status.optional(),
  agentId: id.nullable().optional(),
  repoUrl: z.string().max(1000).optional(),
  repoPath: z.string().max(4096).optional(),
  baseBranch: z.string().max(200).optional(),
  /** A part of this ticket (it waits for it). */
  parentId: id.nullable().optional(),
  ...ticket,
});

const patchSchema = z.object({
  title: z.string().max(MAX_TASK_TITLE_LENGTH * 2).optional(),
  description: z.string().max(MAX_TASK_DESCRIPTION_LENGTH).optional(),
  type: type.optional(),
  status: status.optional(),
  beforeId: id.nullable().optional(),
  agentId: id.nullable().optional(),
  repoUrl: z.string().max(1000).optional(),
  repoPath: z.string().max(4096).optional(),
  baseBranch: z.string().max(200).optional(),
  archived: z.boolean().optional(),
  ...ticket,
  blockedReason: z.string().max(2000).optional(),
});

const archiveSchema = z.object({ ids: z.array(id).min(1).max(1000), archived: z.boolean().default(true) });

const attachmentSchema = z.object({
  name: z.string().min(1).max(255),
  mime: z.string().max(255).default("application/octet-stream"),
  data: z.string().min(1),
});

const goalSchema = z.object({
  title: z.string().max(MAX_GOAL_TITLE_LENGTH * 2),
  why: z.string().max(MAX_GOAL_WHY_LENGTH * 2).optional(),
  workspaceId: id.nullable().optional(),
  targetDate: z.string().max(10).nullable().optional(),
  status: z.enum(["active", "achieved", "dropped"]).optional(),
});

export function registerTaskRoutes(app: Hono): void {
  // Goals: what the work is for.
  app.get("/api/goals", (c) => c.json(listGoals({ workspaceId: c.req.query("workspaceId") || "all" })));
  app.post("/api/goals", async (c) => c.json(createGoal(await body(c, goalSchema)), 201));
  app.patch("/api/goals/:id", async (c) => c.json(updateGoal(c.req.param("id"), await body(c, goalSchema.partial()))));
  app.delete("/api/goals/:id", (c) => {
    deleteGoal(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/api/tasks", (c) =>
    c.json(listTasks({ workspaceId: c.req.query("workspaceId") || "all", archived: ["1", "true"].includes(c.req.query("archived") ?? "") })),
  );

  app.post("/api/tasks/archive", async (c) => {
    const { ids, archived } = await body(c, archiveSchema);
    return c.json(archiveTasks(ids, archived));
  });

  // Files for task descriptions: uploaded first, then linked from the Markdown.
  app.post("/api/tasks/attachments", async (c) => {
    const file = await attachmentUpload(c);
    return c.json(saveTaskAttachment({ name: file.name || "file", mime: file.type, data: new Uint8Array(await file.arrayBuffer()) }));
  });

  // The name in the url is only for readable links: the id finds the file.
  app.get("/api/tasks/attachments/:id/:name", (c) => {
    const { attachment, data } = readTaskAttachment(c.req.param("id"));
    const inline = INLINE.test(attachment.mime);
    return c.body(new Uint8Array(data), 200, {
      "Content-Type": inline ? attachment.mime : "application/octet-stream",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=31536000, immutable",
    });
  });

  app.get("/api/tasks/:id", (c) => c.json(getTask(c.req.param("id"))));

  app.post("/api/tasks", async (c) => c.json(createTask((await body(c, createSchema)) as Parameters<typeof createTask>[0])));

  app.patch("/api/tasks/:id", async (c) =>
    c.json(updateTask(c.req.param("id"), (await body(c, patchSchema)) as Parameters<typeof updateTask>[1])),
  );

  // A ticket's timeline, oldest first (the newest `limit` rows).
  app.get("/api/tasks/:id/events", (c) => {
    const limit = Number(c.req.query("limit") ?? 300);
    return c.json(listTaskEvents(c.req.param("id"), Number.isFinite(limit) ? limit : 300));
  });

  app.delete("/api/tasks/:id", async (c) => {
    await deleteTask(c.req.param("id"));
    return c.json({ ok: true as const });
  });

  app.post("/api/tasks/:id/messages", async (c) => {
    const { content, attachments } = await body(
      c,
      z.object({ content: z.string().max(100_000).default(""), attachments: z.array(attachmentSchema).optional() }),
    );
    // From a phone the answer to a question counts as given from the phone.
    return c.json(await sendTaskMessage(c.req.param("id"), content, attachments, { actor: "user", via: requestDevice(c) ? "phone" : "task" }));
  });

  app.post("/api/tasks/:id/approve", async (c) => {
    expectSlow(c);
    return c.json(await approveTask(c.req.param("id")));
  });

  app.post("/api/tasks/:id/push", async (c) => {
    expectSlow(c);
    return c.json(await pushTaskBranch(c.req.param("id"), { pullRequest: false }));
  });

  app.post("/api/tasks/:id/pull-request", async (c) => {
    expectSlow(c);
    return c.json(await pushTaskBranch(c.req.param("id"), { pullRequest: true }));
  });
}
