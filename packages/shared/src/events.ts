import type {
  Agent,
  AppNotification,
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
  | { type: "missing-login.created"; item: MissingLogin }
  | { type: "missing-login.updated"; item: MissingLogin }
  | { type: "notification"; notification: AppNotification }
  | { type: "vault.status"; status: VaultStatus }
  | { type: "browser.updated"; profile: BrowserProfile }
  | {
      type: "browser.frame";
      profileId: ID;
      /** base64 jpeg */
      data: string;
      url: string;
      title: string;
      width: number;
      height: number;
    }
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
  | "models";

/** Messages the UI may send over the WebSocket. */
export type ClientEvent =
  | { type: "ping" }
  /** `passive` viewers (e.g. the chat preview) get frames without keeping an idle browser running. */
  | { type: "browser.subscribe"; profileId: ID; passive?: boolean }
  | { type: "browser.unsubscribe"; profileId: ID };
