import type { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { EFFORT_OPTIONS, MAX_INSTRUCTIONS_LENGTH, RUN_STOPPED_BY_USER, isModelId } from "@godmode/shared";
import {
  createConversation,
  deleteConversation,
  getConversation,
  getConversationSummary,
  listConversations,
  markConversationsRead,
  sendMessage,
  startChat,
  updateConversation,
} from "../../services/conversations";
import { editQueued, removeQueued, sendQueuedNow, submitMessage } from "../../services/messageQueue";
import { answerByMessage } from "../../services/questions";
import { answererOf } from "./questions";
import { continueConversation, pauseConversation, setAutoContinue } from "../../services/pauses";
import { cancelRun, findRunLog, getRun, listRuns, untilAsked } from "../../runner/runner";
import { cancelFollowup, listFollowups, rescheduleFollowup, runFollowupNow } from "../../services/followups";
import { conflict, notFound } from "../../util";
import { getAgent } from "../../agents/service";
import { listAttention } from "../../services/attention";
import { awaySummary } from "../../services/away";
import { retryRun } from "../../services/retries";
import { body, computerTargetSchema, z } from "../validate";
import { shareComputer } from "../../computer/share";
import { validateTarget } from "../../computer/service";
import { startRemoteChat } from "../../remote/runners";

const attachmentSchema = z.object({
  name: z.string().min(1).max(255),
  mime: z.string().max(255).default("application/octet-stream"),
  data: z.string().min(1),
});

/** Per-chat model/effort/Ultracode. null or "" = use the agent's. */
const modelChoice = {
  model: z
    .string()
    .trim()
    .refine((v) => v === "" || isModelId(v), "Invalid model id")
    .nullable()
    .optional(),
  effort: z.enum(EFFORT_OPTIONS).nullable().optional(),
  ultracode: z.boolean().nullable().optional(),
};

const folder = z.string().trim().max(4096).nullable().optional();
const instructions = z.string().max(MAX_INSTRUCTIONS_LENGTH).optional();
/** macOS VM of the chat; null = the agent's (or workspace's). */
const vmId = z.string().trim().max(100).nullable().optional();
/** Browser profile of the chat; null = the agent's (or the default). */
const browserProfileId = z.string().trim().max(100).nullable().optional();
/** Workspace the chat is started in; a global agent browses with its default profile. */
const workspaceId = z.string().trim().max(100).nullable().optional();
/** SSH servers of the chat (the whole list); the agent's apply anyway. */
const sshServerIds = z.array(z.string().trim().min(1).max(100)).max(50).optional();

const sendSchema = z.object({
  content: z.string().max(200_000).default(""),
  attachments: z.array(attachmentSchema).optional(),
  voice: z.boolean().optional(),
  queue: z.boolean().optional(),
  queueId: z
    .string()
    .regex(/^qmsg_[A-Za-z0-9]{16}$/)
    .optional(),
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
        workspaceId: c.req.query("workspaceId") || undefined,
        search: c.req.query("search") || undefined,
        limit: num(c.req.query("limit")),
        archived: flag(c.req.query("archived")),
      }),
    ),
  );

  app.post("/api/conversations", async (c) => {
    const input = await body(
      c,
      z.object({ agentId: z.string().min(1), title: z.string().max(200).optional(), workingDirectory: folder, vmId, browserProfileId, workspaceId, sshServerIds, instructions, ...modelChoice }),
    );
    // A switched-off agent answers nothing: don't leave an empty chat behind.
    const agent = getAgent(input.agentId);
    if (!agent.enabled) throw conflict(`Agent "${agent.name}" is disabled`);
    return c.json(createConversation({ ...input, origin: "chat" }), 201);
  });

  app.get("/api/conversations/:id", (c) => c.json(getConversation(c.req.param("id"))));

  // The human has seen these chats ("Mark all read", or a client without a live socket).
  app.post("/api/conversations/read", async (c) => {
    const { ids } = await body(c, z.object({ ids: z.union([z.literal("all"), z.array(z.string().min(1).max(100)).max(500)]) }));
    return c.json({ read: markConversationsRead(ids) });
  });

  // Pick up a turn that ended early: continue where it stopped, or send it again.
  app.post("/api/conversations/:id/retry", async (c) => {
    const { runId } = await body(c, z.object({ runId: z.string().min(1).max(100) }));
    return c.json(await retryRun(c.req.param("id"), runId), 201);
  });

  // Everything that waits for the human, from live state.
  app.get("/api/attention", (c) => c.json(listAttention()));

  // What the team did since the human was last here (Home's "while you were away").
  app.get("/api/away", (c) => c.json(awaySummary(c.req.query("since") ?? "", c.req.query("until") || undefined)));

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
        vmId,
        browserProfileId,
        sshServerIds,
        instructions,
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
    const { queue, queueId, ...input } = await body(c, sendSchema);
    // The chat waits for the human's answer: this message is that answer, and the run that asked continues with it.
    await untilAsked(id);
    const answered = answerByMessage(id, input, answererOf(c));
    if (answered) return c.json(answered, 201);
    if (!queue) return c.json(await sendMessage(id, { ...input, trigger: "chat" }), 201);
    const outcome = await submitMessage(id, { ...input, queueId });
    return c.json(outcome, "queued" in outcome ? 202 : 201);
  });

  app.patch("/api/conversations/:id/queue/:messageId", async (c) => {
    const { content } = await body(c, z.object({ content: z.string().max(200_000) }));
    return c.json(editQueued(c.req.param("id"), c.req.param("messageId"), content));
  });

  app.delete("/api/conversations/:id/queue/:messageId", (c) => {
    removeQueued(c.req.param("id"), c.req.param("messageId"));
    return c.json({ ok: true as const });
  });

  // Stop what the agent is doing and start on the queue.
  app.post("/api/conversations/:id/queue/send", async (c) => {
    await sendQueuedNow(c.req.param("id"));
    return c.json({ ok: true as const });
  });

  // Make the chat's run stand still; it continues where it stopped.
  app.post("/api/conversations/:id/pause", async (c) => {
    await pauseConversation(c.req.param("id"));
    return c.json({ ok: true as const });
  });

  app.post("/api/conversations/:id/continue", (c) => c.json(continueConversation(c.req.param("id")), 201));

  // Whether a run that waits for Claude's usage limit continues by itself when the limit resets.
  app.patch("/api/conversations/:id/pause", async (c) => {
    const { auto } = await body(c, z.object({ auto: z.boolean() }));
    return c.json(setAutoContinue(c.req.param("id"), auto));
  });

  app.get("/api/followups", (c) => c.json(listFollowups({ agentId: c.req.query("agentId") || undefined })));

  app.patch("/api/conversations/:id/followup", async (c) => {
    const { dueAt } = await body(c, z.object({ dueAt: z.string().min(1).max(64) }));
    return c.json(rescheduleFollowup(c.req.param("id"), new Date(dueAt)));
  });

  app.delete("/api/conversations/:id/followup", (c) => {
    if (!cancelFollowup(c.req.param("id"))) throw notFound("Follow-up");
    return c.json({ ok: true as const });
  });

  app.post("/api/conversations/:id/followup/run", async (c) => c.json(await runFollowupNow(c.req.param("id")), 201));

  app.post("/api/chat", async (c) => {
    const input = await body(
      c,
      sendSchema.extend({
        agentId: z.string().min(1).optional(),
        workingDirectory: folder,
        computerTarget: computerTargetSchema.nullable().optional(),
        vmId,
        browserProfileId,
        workspaceId,
        sshServerIds,
        instructions,
        /** Work on this runner (another computer) instead of this one. */
        runnerId: z.string().trim().min(1).max(100).nullable().optional(),
        ...modelChoice,
      }),
    );
    if (input.runnerId) return c.json(await startRemoteChat(input.runnerId, input), 201);
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
        parentRunId: c.req.query("parentRunId") || undefined,
        limit: num(c.req.query("limit")),
      }),
    ),
  );

  app.get("/api/runs/:id", (c) => {
    const run = getRun(c.req.param("id"));
    return c.json({ ...run, logPath: findRunLog(run) });
  });

  app.post("/api/runs/:id/cancel", async (c) => {
    await cancelRun(c.req.param("id"), RUN_STOPPED_BY_USER, { byHuman: true });
    return c.json({ ok: true as const });
  });

  app.get("/api/runs/:id/log", (c) => {
    const run = getRun(c.req.param("id"));
    const path = findRunLog(run);
    if (!path || !existsSync(path)) throw notFound("Run log");
    return c.body(readFileSync(path, "utf8"), 200, { "Content-Type": "text/plain; charset=utf-8" });
  });
}
