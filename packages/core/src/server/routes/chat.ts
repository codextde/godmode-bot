import type { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { EFFORT_OPTIONS, isModelId } from "@godmode/shared";
import {
  createConversation,
  deleteConversation,
  getConversation,
  getConversationSummary,
  listConversations,
  sendMessage,
  startChat,
  updateConversation,
} from "../../services/conversations";
import { cancelRun, findRunLog, getRun, listRuns } from "../../runner/runner";
import { notFound } from "../../util";
import { body, computerTargetSchema, z } from "../validate";
import { shareComputer } from "../../computer/share";
import { validateTarget } from "../../computer/service";

const attachmentSchema = z.object({
  name: z.string().min(1).max(255),
  mime: z.string().max(255).default("application/octet-stream"),
  data: z.string().min(1),
});

/** Per-chat model/effort. null or "" = use the agent's. */
const modelChoice = {
  model: z
    .string()
    .trim()
    .refine((v) => v === "" || isModelId(v), "Invalid model id")
    .nullable()
    .optional(),
  effort: z.enum(EFFORT_OPTIONS).nullable().optional(),
};

const folder = z.string().trim().max(4096).nullable().optional();

const sendSchema = z.object({
  content: z.string().max(200_000).default(""),
  attachments: z.array(attachmentSchema).max(20).optional(),
  voice: z.boolean().optional(),
});

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function flag(v: string | undefined): boolean | undefined {
  if (v === undefined || v === "") return undefined;
  return v === "true" || v === "1";
}

export function registerChatRoutes(app: Hono): void {
  app.get("/api/conversations", (c) =>
    c.json(
      listConversations({
        agentId: c.req.query("agentId") || undefined,
        search: c.req.query("search") || undefined,
        limit: num(c.req.query("limit")),
        archived: flag(c.req.query("archived")),
      }),
    ),
  );

  app.post("/api/conversations", async (c) => {
    const input = await body(c, z.object({ agentId: z.string().min(1), title: z.string().max(200).optional(), workingDirectory: folder, ...modelChoice }));
    return c.json(createConversation({ ...input, origin: "chat" }), 201);
  });

  app.get("/api/conversations/:id", (c) => c.json(getConversation(c.req.param("id"))));

  app.patch("/api/conversations/:id", async (c) => {
    const patch = await body(
      c,
      z.object({
        title: z.string().min(1).max(200).optional(),
        pinned: z.boolean().optional(),
        archived: z.boolean().optional(),
        ...modelChoice,
        workingDirectory: folder,
        computerTarget: computerTargetSchema.nullable().optional(),
      }),
    );
    const { computerTarget, ...rest } = patch;
    if (computerTarget !== undefined) await shareComputer(c.req.param("id"), computerTarget);
    return c.json(updateConversation(c.req.param("id"), rest));
  });

  app.delete("/api/conversations/:id", async (c) => {
    await deleteConversation(c.req.param("id"));
    return c.json({ ok: true as const });
  });

  app.post("/api/conversations/:id/messages", async (c) => {
    const id = c.req.param("id");
    getConversationSummary(id); // 404 early, before parsing a potentially large body
    const input = await body(c, sendSchema);
    return c.json(await sendMessage(id, { ...input, trigger: "chat" }), 201);
  });

  app.post("/api/chat", async (c) => {
    const input = await body(
      c,
      sendSchema.extend({ agentId: z.string().min(1).optional(), workingDirectory: folder, computerTarget: computerTargetSchema.nullable().optional(), ...modelChoice }),
    );
    // Check the shared window/screen/tab before the chat exists, so a stale pick doesn't leave an empty chat.
    const computerTarget = input.computerTarget ? await validateTarget(input.computerTarget) : null;
    return c.json(await startChat({ ...input, computerTarget, origin: "chat" }), 201);
  });

  app.get("/api/runs", (c) =>
    c.json(
      listRuns({
        agentId: c.req.query("agentId") || undefined,
        status: c.req.query("status") || undefined,
        conversationId: c.req.query("conversationId") || undefined,
        limit: num(c.req.query("limit")),
      }),
    ),
  );

  app.get("/api/runs/:id", (c) => {
    const run = getRun(c.req.param("id"));
    return c.json({ ...run, logPath: findRunLog(run) });
  });

  app.post("/api/runs/:id/cancel", async (c) => {
    await cancelRun(c.req.param("id"), "Cancelled by user");
    return c.json({ ok: true as const });
  });

  app.get("/api/runs/:id/log", (c) => {
    const run = getRun(c.req.param("id"));
    const path = findRunLog(run);
    if (!path || !existsSync(path)) throw notFound("Run log");
    return c.body(readFileSync(path, "utf8"), 200, { "Content-Type": "text/plain; charset=utf-8" });
  });
}
