import type { Context, Hono } from "hono";
import { MAX_TASK_ATTACHMENT_BYTES, MAX_TASK_DESCRIPTION_LENGTH, MAX_TASK_TITLE_LENGTH, TASK_STATUSES, TASK_TYPES } from "@godmode/shared";
import { archiveTasks, createTask, deleteTask, getTask, listTasks, pushTaskBranch, sendTaskMessage, updateTask } from "../../tasks/service";
import { readTaskAttachment, saveTaskAttachment } from "../../tasks/attachments";
import { HttpError, badRequest } from "../../util";
import { body, z } from "../validate";

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
});

const archiveSchema = z.object({ ids: z.array(id).min(1).max(1000), archived: z.boolean().default(true) });

const attachmentSchema = z.object({
  name: z.string().min(1).max(255),
  mime: z.string().max(255).default("application/octet-stream"),
  data: z.string().min(1),
});

export function registerTaskRoutes(app: Hono): void {
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

  app.delete("/api/tasks/:id", async (c) => {
    await deleteTask(c.req.param("id"));
    return c.json({ ok: true as const });
  });

  app.post("/api/tasks/:id/messages", async (c) => {
    const { content, attachments } = await body(
      c,
      z.object({ content: z.string().max(100_000).default(""), attachments: z.array(attachmentSchema).max(20).optional() }),
    );
    return c.json(await sendTaskMessage(c.req.param("id"), content, attachments));
  });

  app.post("/api/tasks/:id/push", async (c) => c.json(await pushTaskBranch(c.req.param("id"), { pullRequest: false })));

  app.post("/api/tasks/:id/pull-request", async (c) => c.json(await pushTaskBranch(c.req.param("id"), { pullRequest: true })));
}
