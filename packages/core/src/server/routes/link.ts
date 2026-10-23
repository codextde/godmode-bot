import type { Context, Hono } from "hono";
import type { RunnerFixResult } from "@godmode/shared";
import { importChromeSession } from "../../browser/manager";
import { config } from "../../config";
import { logger } from "../../log";
import { acceptedCookies } from "../../remote/browserSessions";
import { readHandover } from "../../remote/handover";
import { fixCheck, runnerHealth } from "../../remote/health";
import { forgetController, runnerInfo } from "../../remote/linkServer";
import { readMemoryState, writeMemoryState } from "../../remote/memorySync";
import { storeMemoryBase } from "../../remote/runners";
import { MAX_UPDATE_BYTES, applyUpdate, downloadUpdate, receiveChunk } from "../../remote/selfUpdate";
import { applySnapshot, type ConfigSnapshot } from "../../remote/snapshot";
import { audit } from "../../services/audit";
import { installUpdates } from "../../services/maintenance";
import { checkUpdates } from "../../services/updates";
import { runCommand, toolPath } from "../../services/doctor";
import { HttpError, badRequest, childEnv, notFound } from "../../util";
import { acceptJoin, adoptPushedChat, chatsTakenFrom, deviceIdOf, deviceState, groupForSecondary, makeInvite, peerAway, peerHello, peerLeft, releaseChatsTo } from "../../remote/devices";
import { ackFrom, changesFor } from "../../remote/replica";
import { isSecondary } from "../../remote/group";
import { callForDevice } from "../../remote/deviceTools";
import { welcomeFor } from "../ws";
import { get } from "../../db";
import { getConversationSummary, sendMessage } from "../../services/conversations";
import type { MessageBlock, RunTrigger } from "@godmode/shared";
import { cancelRun } from "../../runner/runner";
import { body, z } from "../validate";

const log = logger("link");

const EXEC_DEFAULT_MS = 120_000;
const EXEC_MAX_MS = 15 * 60_000;
const EXEC_MAX_OUTPUT = 200_000;

/**
 * What the controller asks a runner over the encrypted link. These routes exist only on that channel: the link
 * listener (remote/linkServer.ts) forwards a paired controller's requests with the master token and tags them; the
 * same paths asked any other way (the loopback API, a dashboard, a phone) are not found.
 */
function viaLink(c: Context): string | null {
  const env = c.env as { channel?: string; controllerId?: string } | undefined;
  return env?.channel === "runner-link" ? (env.controllerId ?? "") : null;
}

export function registerLinkRoutes(app: Hono): void {
  app.use("/api/link/*", async (c, next) => {
    if (viaLink(c) === null) throw notFound("Route");
    await next();
  });

  app.get("/api/link/info", (c) => c.json(runnerInfo()));

  app.post("/api/link/sync", async (c) => {
    const snapshot = (await c.req.json()) as ConfigSnapshot;
    const result = await applySnapshot(snapshot);
    for (const w of result.warnings) log.warn(w);
    return c.json(result);
  });

  app.get("/api/link/health", async (c) => c.json(await runnerHealth(c.req.query("refresh") === "1")));

  app.post("/api/link/health/fix", async (c) => {
    const { id } = await body(c, z.object({ id: z.string().min(1).max(64) }));
    const result = await fixCheck(id);
    audit("controller", "runner.fix", id, { ok: result.ok });
    return c.json({ ...result, health: await runnerHealth(true) } satisfies RunnerFixResult);
  });

  app.get("/api/link/agents/:id/memory", (c) => c.json(readMemoryState(c.req.param("id"))));

  app.put("/api/link/agents/:id/memory", async (c) => {
    const input = await body(c, z.object({ snapshot: z.object({ files: z.record(z.string(), z.unknown()) }).passthrough() }));
    const state = await writeMemoryState(c.req.param("id"), input.snapshot as never, "Memory from Godmode");
    // A device of the group: this side knows the agreed state too (and that the agent's memory came over).
    const peer = deviceIdOf(viaLink(c) ?? "");
    if (peer) storeMemoryBase(peer, c.req.param("id"), state);
    return c.json(state);
  });

  // A chat of this runner moves to the controller: its Claude session and transcript go along.
  app.get("/api/link/conversations/:id/handover", (c) => c.json(readHandover(c.req.param("id"))));
  app.get("/api/link/conversations/:id/handover/size", (c) => c.json({ bytes: Buffer.byteLength(JSON.stringify(readHandover(c.req.param("id")))) }));

  // The sessions the controller copies here (remote/browserSessions.ts); one from before sends no mode and replaces.
  app.post("/api/link/browser/:profileId/cookies", async (c) => {
    const { cookies, mode = "replace" } = await body(c, z.object({ cookies: z.array(z.unknown()).max(20_000), mode: z.enum(["seed", "replace"]).optional() }));
    return c.json(await importChromeSession(c.req.param("profileId"), { cookiesJson: JSON.stringify(cookies) }, (incoming, existing) => acceptedCookies(incoming, mode, existing)));
  });

  // Commands for the "fix with Claude" chat on the controller: its agent diagnoses and repairs the runner from there.
  app.post("/api/link/exec", async (c) => {
    const input = await body(
      c,
      z.object({ command: z.string().min(1).max(20_000), cwd: z.string().max(4096).optional(), timeoutMs: z.number().int().positive().max(EXEC_MAX_MS).optional() }),
    );
    const shell = process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
    audit("controller", "runner.exec", null, { command: input.command.slice(0, 500), cwd: input.cwd ?? null });
    const res = await runCommand([shell, "-lc", input.command], {
      timeoutMs: input.timeoutMs ?? EXEC_DEFAULT_MS,
      // The runner's data dir by default: its logs are in logs/.
      cwd: input.cwd ?? config().dataDir,
      env: childEnv({ PATH: toolPath() }),
      maxOutput: EXEC_MAX_OUTPUT,
    });
    return c.json(res);
  });

  // A new Godmode from the controller, in pieces (remote/selfUpdate.ts), then installed once nothing works.
  app.put("/api/link/update/chunk", async (c) => {
    const offset = Number(c.req.query("offset"));
    const total = Number(c.req.query("total"));
    if (!Number.isInteger(offset) || offset < 0 || offset > MAX_UPDATE_BYTES) throw badRequest("offset");
    return c.json(receiveChunk(offset, total, new Uint8Array(await c.req.arrayBuffer())));
  });

  const target = z.object({ version: z.string().min(1).max(64), build: z.string().max(128) });

  app.post("/api/link/update/apply", async (c) => {
    const input = await body(c, z.object({ sha256: z.string().regex(/^[0-9a-fA-F]{64}$/), size: z.number().int().positive().max(MAX_UPDATE_BYTES), target }));
    return c.json(await applyUpdate(input));
  });

  app.post("/api/link/update/download", async (c) => {
    const input = await body(c, z.object({ key: z.string().min(1).max(200), target, site: z.string().url().max(200).optional() }));
    return c.json(await downloadUpdate(input));
  });

  app.get("/api/link/updates", async (c) => c.json(await checkUpdates(c.req.query("refresh") === "1")));

  app.post("/api/link/updates/install", async (c) => c.json(await installUpdates()));

  /* ---------------- Device groups (remote/devices.ts) ---------------- */

  // The group as the primary sees it, for a secondary's Settings → Devices.
  app.get("/api/link/devices/list", (c) => c.json(groupForSecondary()));

  // A secondary hands out its primary's invite: whoever joins pairs with the primary.
  app.post("/api/link/devices/invite", async (c) => {
    if (isSecondary()) throw new HttpError(409, "Invites come from the primary.", "not_primary");
    return c.json(await makeInvite());
  });

  // A computer that paired with this one's invite gives its own code, so this one pairs back with it.
  app.post("/api/link/devices/join", async (c) => {
    const { code } = await body(c, z.object({ code: z.string().min(10).max(4000) }));
    return c.json(await acceptJoin(code));
  });

  app.get("/api/link/devices/whoami", (c) => c.json({ id: deviceIdOf(viaLink(c) ?? "") }));

  const groupPeer = (c: Context): string => {
    const peer = deviceIdOf(viaLink(c) ?? "");
    if (!peer) throw new HttpError(403, "Only computers of this device group take part in that.", "not_in_group");
    return peer;
  };

  // What changed in the shared data since `after` (remote/replica.ts); asking after N also says everything up to N arrived.
  app.get("/api/link/replica/changes", (c) => {
    const peer = groupPeer(c);
    const after = Number(c.req.query("after") ?? 0);
    const limit = Number(c.req.query("limit") ?? 0);
    return c.json(changesFor(peer, Number.isFinite(after) && after >= 0 ? after : 0, { setup: c.req.query("setup") !== "0", ...(limit > 0 ? { limit } : {}) }));
  });

  app.post("/api/link/replica/ack", async (c) => {
    const peer = groupPeer(c);
    const { after } = await body(c, z.object({ after: z.number().int().min(0) }));
    ackFrom(peer, after);
    return c.json({ ok: true as const });
  });

  // Chats of this computer that the calling one took over while this one was away: they live there now.
  app.post("/api/link/devices/release-chats", async (c) => {
    const peer = groupPeer(c);
    const { ids } = await body(c, z.object({ ids: z.array(z.string().min(1).max(100)).max(2000) }));
    return c.json(await releaseChatsTo(peer, ids));
  });

  // The calling computer is back: which of its chats this one continued meanwhile.
  app.get("/api/link/devices/taken", (c) => c.json(chatsTakenFrom(groupPeer(c))));

  app.get("/api/link/devices/state", (c) => {
    groupPeer(c);
    return c.json(deviceState());
  });

  // The calling computer (the primary) is back: connect to it now.
  app.post("/api/link/devices/hello", (c) => {
    peerHello(groupPeer(c));
    return c.json({ ok: true as const });
  });

  // The calling computer goes away right now (Godmode quits there).
  app.post("/api/link/devices/away", (c) => {
    peerAway(groupPeer(c));
    return c.json({ ok: true as const });
  });

  app.post("/api/link/devices/leave", (c) => {
    peerLeft(viaLink(c) ?? "");
    return c.json({ ok: true as const });
  });

  // A chat another computer of the group hands over: it becomes this computer's own.
  app.post("/api/link/devices/adopt-chat", async (c) => {
    const input = (await c.req.json()) as Record<string, unknown>;
    return c.json(adoptPushedChat({ conversation: input.conversation, messages: input.messages, runs: input.runs, handover: input.handover, followup: input.followup }));
  });

  // What a new window of a secondary needs to show what works right now (server/ws.ts).
  app.get("/api/link/devices/welcome", (c) => c.json(welcomeFor()));

  // A Godmode tool an agent on a secondary calls about what is shared (remote/deviceTools.ts).
  app.post("/api/link/devices/tool", async (c) => {
    const input = await body(
      c,
      z.object({ name: z.string().min(1).max(100), args: z.unknown(), runId: z.string().max(100), agentId: z.string().max(100), conversationId: z.string().max(100), depth: z.number().int().min(0).max(50) }),
    );
    return c.json(await callForDevice(viaLink(c) ?? "", input));
  });

  // A run of this computer stops because its chat moves to another computer: the chat says why.
  app.post("/api/link/runs/:id/stop", async (c) => {
    const { reason } = await body(c, z.object({ reason: z.string().min(1).max(300) }));
    await cancelRun(c.req.param("id"), reason, { byHuman: true });
    return c.json({ ok: true as const });
  });

  // A turn in one of this computer's chats that another computer starts (a moved chat continuing, a human task's answer).
  const TRIGGERS: readonly RunTrigger[] = ["chat", "followup", "manual", "api", "task", "delegation"];
  app.post("/api/link/conversations/:id/send", async (c) => {
    const input = await body(
      c,
      z.object({ content: z.string().max(200_000), prompt: z.string().max(400_000).optional(), marker: z.array(z.record(z.string(), z.unknown())).max(20).optional(), trigger: z.string().optional() }),
    );
    const id = c.req.param("id");
    const row = get<{ runner_id: string | null }>("SELECT runner_id FROM conversations WHERE id = ?", id);
    if (!row) throw notFound("Conversation");
    // Never handed on again: a chat this computer only mirrors is answered by the computer it lives on.
    if (row.runner_id) throw new HttpError(409, "This chat works on another computer.", "not_here");
    const trigger = TRIGGERS.includes(input.trigger as RunTrigger) ? (input.trigger as RunTrigger) : "chat";
    const result = await sendMessage(id, {
      content: input.content,
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(input.marker?.length ? { marker: input.marker as unknown as MessageBlock[] } : {}),
      trigger,
    });
    return c.json({ ...result, conversation: getConversationSummary(id) });
  });

  app.post("/api/link/forget", (c) => {
    const controllerId = viaLink(c);
    // Answered first: forgetting closes the link this answer travels on.
    if (controllerId) setTimeout(() => forgetController(controllerId), 50);
    return c.json({ ok: true as const });
  });
}
