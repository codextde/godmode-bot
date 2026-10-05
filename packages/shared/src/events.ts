import type { ComputerView } from "./computer";
import type { Task, TaskEvent } from "./tasks";
import type { Vm } from "./vm";
import type { MobileDevice } from "./mobile";
import type { RemoteRunner } from "./remote";
import type {
  Agent,
  AgentQuestion,
  AppNotification,
  AutomationEvent,
  BrowserProfile,
  Conversation,
  ID,
  Message,
  MessageBlock,
  MissingLogin,
  QueuedMessage,
  Routine,
  Run,
  VaultStatus,
} from "./models";

/**
 * Real-time events pushed from the core daemon to connected UIs over the WebSocket at /api/ws.
 * Every event is a JSON object `{ type, ...payload }`.
 */
export type ServerEvent =
  /** activeRunIds: every queued or running run; a `run.started` for each follows right after. */
  | { type: "hello"; version: string; serverTime: string; activeRunIds?: ID[] }
  | { type: "run.started"; run: Run }
  | {
      type: "run.delta";
      runId: ID;
      conversationId: ID;
      messageId: ID;
      /**
       * Counts the deltas of a stretch of the run from 1. A paused run continues in a new stretch (`stream`), which
       * counts from 1 again. Older cores send neither.
       */
      stream?: string;
      seq?: number;
      /**
       * Full, current block list of the in-flight assistant message (the client replaces its copy). Sent to clients
       * that didn't ask for patches, and as the answer to `run.resync`.
       */
      blocks?: MessageBlock[];
      /**
       * Only what changed since the last delta, as `[index, block]` pairs; the list is `length` blocks long afterwards.
       * Sent instead of `blocks` to clients that asked for it (`deltas.patch`) — see `applyRunDelta`.
       */
      patch?: [number, MessageBlock][];
      length?: number;
      /** Incremental text appended since the last delta (for TTS / typing effects). */
      textDelta?: string;
    }
  | { type: "run.activity"; runId: ID; agentId: ID; label: string }
  /** The run stands still (`run.status` is "paused"); `run.started` follows when it continues. */
  | { type: "run.paused"; run: Run }
  | { type: "run.finished"; run: Run }
  | { type: "message.created"; message: Message }
  | { type: "message.updated"; message: Message }
  /** The messages waiting in a chat's queue changed (the whole queue, in order). */
  | { type: "queue.updated"; conversationId: ID; queue: QueuedMessage[] }
  | { type: "conversation.updated"; conversation: Conversation }
  | { type: "conversation.deleted"; id: ID }
  | { type: "agent.updated"; agent: Agent }
  | { type: "agent.deleted"; id: ID }
  | { type: "routine.updated"; routine: Routine }
  | { type: "routine.deleted"; id: ID }
  /** An automation event was received or changed status. */
  | { type: "automation.event"; event: AutomationEvent }
  | { type: "missing-login.created"; item: MissingLogin }
  | { type: "missing-login.updated"; item: MissingLogin }
  /** An agent asked the human something and its run stands still for the answer. */
  | { type: "question.created"; question: AgentQuestion }
  /** The question was answered or withdrawn. */
  | { type: "question.updated"; question: AgentQuestion }
  | { type: "notification"; notification: AppNotification }
  | { type: "vault.status"; status: VaultStatus }
  | { type: "browser.updated"; profile: BrowserProfile }
  | {
      type: "browser.frame";
      profileId: ID;
      /** Set when the frame shows one chat's tab (a chat-scoped subscription). */
      conversationId?: ID;
      /** base64 jpeg */
      data: string;
      url: string;
      title: string;
      width: number;
      height: number;
    }
  | {
      type: "computer.frame";
      /** Live view stream, e.g. "display:1" or "window:812:4711" (see computerView). */
      view: ComputerView;
      /** base64 image ("" when `error` is set) */
      data: string;
      mime: "image/jpeg" | "image/png";
      /** Frame size; takeover input uses this coordinate space. */
      width: number;
      height: number;
      /** e.g. "Safari — Apple" */
      label: string;
      /** Why no picture could be taken (missing permission, window closed, …). */
      error?: string;
    }
  | {
      /** An agent acted on a shared view (drawn as a ripple in the live view). x/y in frame coordinates, 0–1. */
      type: "computer.action";
      view: ComputerView;
      runId: ID;
      action: string;
      x?: number;
      y?: number;
    }
  | { type: "vm.updated"; vm: Vm }
  | { type: "vm.deleted"; id: ID }
  | { type: "task.updated"; task: Task }
  | { type: "task.deleted"; id: ID }
  /** Something was added to a ticket's timeline. */
  | { type: "task.event"; event: TaskEvent }
  /** A phone was paired (the pairing QR code was used). */
  | { type: "mobile.paired"; device: MobileDevice }
  /** A runner's connection, sync, health or settings changed. */
  | { type: "runner.updated"; runner: RemoteRunner }
  | { type: "runner.deleted"; id: ID }
  /** A runner was paired (its code arrived, or was entered by hand). */
  | { type: "runner.paired"; runner: RemoteRunner }
  | { type: "entity.changed"; entity: EntityName };

export type EntityName =
  | "workspaces"
  | "agents"
  | "routines"
  | "credentials"
  | "totp"
  | "mcp-servers"
  | "api-tools"
  | "composio"
  | "browser-profiles"
  | "missing-logins"
  | "questions"
  | "notifications"
  | "settings"
  | "runs"
  | "dreams"
  | "models"
  | "computer"
  | "vms"
  | "ssh-servers"
  | "mods"
  | "messaging"
  | "tasks"
  /** Goals: added, changed, deleted (their progress follows the tickets). */
  | "goals"
  | "followups"
  | "mobile"
  /** A connected app (Claude Code, another MCP client) was added, removed or used. */
  | "connectors"
  | "system"
  | "runners"
  /** The cloud link: state, account, plan or billing changed. */
  | "cloud"
  /** The licence: key, verification or whether runs are refused changed. */
  | "license";

/** Messages the UI may send over the WebSocket. */
export type ClientEvent =
  | { type: "ping" }
  /**
   * `passive` viewers (e.g. the chat preview) get frames without keeping an idle browser running. With
   * `conversationId` the frames show that chat's tab instead of the browser's active one.
   */
  | { type: "browser.subscribe"; profileId: ID; conversationId?: ID; passive?: boolean }
  | { type: "browser.unsubscribe"; profileId: ID; conversationId?: ID }
  /** Computer live view frames (see computerView). */
  | { type: "computer.subscribe"; view: ComputerView }
  | { type: "computer.unsubscribe"; view: ComputerView }
  /**
   * Phones only get `run.delta` (the streaming reply) for conversations they have open; other clients get all of them.
   */
  | { type: "conversation.subscribe"; conversationId: ID }
  /** The chat this client shows right now in a visible, focused window (null = none): it is read, and its runs don't notify. */
  | { type: "conversation.view"; conversationId: ID | null }
  | { type: "conversation.unsubscribe"; conversationId: ID }
  /** This client applies `run.delta` patches (`applyRunDelta`): send it what changed instead of the whole list. */
  | { type: "deltas.patch" }
  /** The client missed a delta of this run (or joined while it ran): send its whole block list once. */
  | { type: "run.resync"; runId: ID };

export type RunDelta = Extract<ServerEvent, { type: "run.delta" }>;

/** What a client holds of a run's in-flight message: its blocks and the last delta it applied. */
export interface RunDeltaState {
  blocks: MessageBlock[];
  seq: number;
  stream?: string;
}

/**
 * The client's copy after a `run.delta`, or null when the delta can't be applied to it (one was missed, or the client
 * joined mid-run): the client then asks for the whole list with `run.resync` and keeps what it shows meanwhile.
 */
export function applyRunDelta(have: RunDeltaState | null | undefined, delta: RunDelta): RunDeltaState | null {
  if (delta.blocks) return { blocks: delta.blocks, seq: delta.seq ?? 0, stream: delta.stream };
  if (!delta.patch || delta.seq === undefined || delta.length === undefined) return null;
  // What the client has of another stretch counts for nothing: the first delta of a stretch carries every block.
  const base = have && have.stream === delta.stream ? have : null;
  if (delta.seq !== (base?.seq ?? 0) + 1) return null;
  const blocks = (base?.blocks ?? []).slice(0, delta.length);
  for (const [index, block] of delta.patch) {
    if (index < delta.length) blocks[index] = block;
  }
  if (blocks.length !== delta.length) return null;
  for (let i = 0; i < blocks.length; i++) if (!blocks[i]) return null;
  return { blocks, seq: delta.seq, stream: delta.stream };
}
