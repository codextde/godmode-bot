import type { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { EFFORT_OPTIONS, MAX_INSTRUCTIONS_LENGTH, RUN_STOPPED_BY_USER, isModelId } from "@godmode/shared";
import {
  createConversation,
  deleteConversation,
  discardPrivateChat,
  getConversation,
  getConversationSummary,
  listConversations,
  listMessagePage,
  messageImage,
  messageWindow,
  markConversationsRead,
  markConversationsUnread,
  sendMessage,
  startChat,
  updateConversation,
} from "../../services/conversations";
import { editQueued, removeQueued, sendQueuedNow, submitMessage } from "../../services/messageQueue";
import { liteMessage } from "../../services/liteMessage";
import { answerByMessage } from "../../services/questions";
import { answererOf } from "./questions";
import { replySettles } from "../../services/humanTasks";
import { continueConversation, pauseConversation, setAutoContinue } from "../../services/pauses";
import { cancelRun, findRunLog, getRun, listRuns, untilAsked } from "../../runner/runner";
import { cancelFollowup, listFollowups, rescheduleFollowup, runFollowupNow } from "../../services/followups";
import { badRequest, conflict, notFound } from "../../util";
import { getAgent } from "../../agents/service";
import { listAttention } from "../../services/attention";
import { awaySummary } from "../../services/away";
import { retryRun } from "../../services/retries";
import { requestDevice } from "../auth";
import { autoRetryOf } from "../../services/resume";
import { body, computerTargetSchema, z } from "../validate";
import { shareComputer } from "../../computer/share";
import { validateTarget } from "../../computer/service";
import { sshPlacement, startRemoteChat } from "../../remote/runners";
import { selfDeviceId } from "../../remote/group";
import { search } from "../../services/search";

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
/** Project the chat works on; null = the agent's. */
const projectId = z.string().trim().max(100).nullable().optional();
/** SSH servers of the chat (the whole list); the agent's apply anyway. */
const sshServerIds = z.array(z.string().trim().min(1).max(100)).max(50).optional();
const androidDeviceIds = z.array(z.string().trim().min(1).max(100)).max(50).optional();

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
  app.get("/api/search", async (c) => c.json(await search(c.req.query("q") ?? "", { limit: num(c.req.query("limit")), notes: c.req.query("notes") !== "0" })));

  app.get("/api/conversations", (c) =>
    c.json(
      listConversations({
        agentId: c.req.query("agentId") || undefined,
        workspaceId: c.req.query("workspaceId") || undefined,
        projectId: c.req.query("projectId") || undefined,
        search: c.req.query("search") || undefined,
        limit: num(c.req.query("limit")),
        archived: flag(c.req.query("archived")),
        ongoing: flag(c.req.query("ongoing")),
      }),
    ),
  );

  app.post("/api/conversations", async (c) => {
    const input = await body(
      c,
      z.object({ agentId: z.string().min(1), title: z.string().max(200).optional(), workingDirectory: folder, vmId, browserProfileId, workspaceId, projectId, sshServerIds, androidDeviceIds, instructions, ...modelChoice }),
    );
    // A switched-off agent answers nothing: don't leave an empty chat behind.
    const agent = getAgent(input.agentId);
    if (!agent.enabled) throw conflict(`Agent "${agent.name}" is disabled`);
    return c.json(createConversation({ ...input, origin: "chat" }), 201);
  });

  app.get("/api/conversations/:id", (c) => c.json(getConversation(c.req.param("id"), messageWindow((name) => c.req.query(name)))));

  // Older messages of a chat, a page at a time (the chat itself answers with the latest ones when asked for `limit`).
  app.get("/api/conversations/:id/messages", (c) => {
    const id = c.req.param("id");
    getConversationSummary(id);
    const { limit, lite } = messageWindow((name) => c.req.query(name));
    const page = listMessagePage(id, { limit: limit ?? 50, before: c.req.query("before") || undefined });
    return c.json(lite ? { ...page, messages: page.messages.map(liteMessage) } : page);
  });

  // A picture a tool returned (a screenshot), for light answers that leave it out of the message.
  app.get("/api/conversations/:id/messages/:messageId/images/:toolUseId", (c) => {
    const { data, mime } = messageImage(c.req.param("id"), c.req.param("messageId"), c.req.param("toolUseId"));
    return c.body(new Uint8Array(data), 200, {
      "Content-Type": mime,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=31536000, immutable",
    });
  });

  // The human has seen these chats ("Mark all read", or a client without a live socket).
  app.post("/api/conversations/read", async (c) => {
    const { ids } = await body(c, z.object({ ids: z.union([z.literal("all"), z.array(z.string().min(1).max(100)).max(500)]) }));
    return c.json({ read: markConversationsRead(ids) });
  });

  // "Mark as unread" from a chat's menu: it shows as new again until it is opened.
  app.post("/api/conversations/unread", async (c) => {
    const { ids } = await body(c, z.object({ ids: z.array(z.string().min(1).max(100)).min(1).max(500) }));
    return c.json({ unread: markConversationsUnread(ids) });
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
        projectId,
        sshServerIds,
        androidDeviceIds,
        instructions,
      }),
    );
    const { computerTarget, ...rest } = patch;
    if (computerTarget !== undefined) await shareComputer(c.req.param("id"), computerTarget);
    return c.json(updateConversation(c.req.param("id"), rest));
  });

  app.delete("/api/conversations/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await discardPrivateChat(id))) await deleteConversation(id);
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
    const settle = replySettles(id, input.content);
    if (!queue) {
      const sent = await sendMessage(id, { ...input, trigger: "chat" });
      settle();
      return c.json(sent, 201);
    }
    const outcome = await submitMessage(id, { ...input, queueId });
    settle();
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
        projectId,
        sshServerIds,
        androidDeviceIds,
        instructions,
        /** Work on this runner (another computer) instead of this one. */
        runnerId: z.string().trim().min(1).max(100).nullable().optional(),
        private: z.boolean().optional(),
        ...modelChoice,
      }),
    );
    if (input.private && input.runnerId && input.runnerId !== selfDeviceId()) throw badRequest("A private chat stays on this computer");
    // A secondary names itself by its id in the primary's list: a chat for it starts here.
    if (input.runnerId && input.runnerId === selfDeviceId()) input.runnerId = null;
    const onServer = await sshPlacement(input);
    if (onServer) return c.json(await startRemoteChat(onServer.runnerId, { ...input, ...onServer }), 201);
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
    const retry = autoRetryOf(run.id);
    // A phone reads the log through /log; where it lies on this computer stays here.
    return c.json({ ...run, logPath: requestDevice(c) ? null : findRunLog(run), retryAt: retry?.at ?? null, retryCause: retry?.cause ?? null });
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
