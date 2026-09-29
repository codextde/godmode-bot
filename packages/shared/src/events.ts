import type { ComputerView } from "./computer";
import type { Task } from "./tasks";
import type { Vm } from "./vm";
import type {
  Agent,
  AppNotification,
  AutomationEvent,
  BrowserProfile,
  Conversation,
  ID,
  Message,
  MessageBlock,
  MissingLogin,
  Routine,
  Run,
  VaultStatus,
} from "./models";

/**
 * Real-time events pushed from the core daemon to connected UIs over the WebSocket at /api/ws.
 * Every event is a JSON object `{ type, ...payload }`.
 */
export type ServerEvent =
  | { type: "hello"; version: string; serverTime: string }
  | { type: "run.started"; run: Run }
  | {
      type: "run.delta";
      runId: ID;
      conversationId: ID;
      messageId: ID;
      /** Full, current block list of the in-flight assistant message (UI replaces its copy). */
      blocks: MessageBlock[];
      /** Incremental text appended since the last delta (for TTS / typing effects). */
      textDelta?: string;
    }
  | { type: "run.activity"; runId: ID; agentId: ID; label: string }
  | { type: "run.finished"; run: Run }
  | { type: "message.created"; message: Message }
  | { type: "message.updated"; message: Message }
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
  | { type: "entity.changed"; entity: EntityName };

export type EntityName =
  | "workspaces"
  | "agents"
  | "routines"
  | "credentials"
  | "totp"
  | "mcp-servers"
  | "composio"
  | "browser-profiles"
  | "missing-logins"
  | "notifications"
  | "settings"
  | "runs"
  | "dreams"
  | "models"
  | "computer"
  | "vms"
  | "messaging"
  | "tasks"
  | "followups";

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
  | { type: "computer.unsubscribe"; view: ComputerView };
