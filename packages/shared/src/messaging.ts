/**
 * Messaging: people talk to agents from Slack, Telegram or Microsoft Teams through a bot the human connects.
 * Every chat on the platform maps to a Godmode conversation with one of the bot's agents.
 */
import type { ID, ISODate } from "./models";

export type MessagingProvider = "slack" | "telegram" | "teams";

export const MESSAGING_PROVIDERS: readonly MessagingProvider[] = ["slack", "telegram", "teams"];

export const MESSAGING_PROVIDER_LABELS: Record<MessagingProvider, string> = {
  slack: "Slack",
  telegram: "Telegram",
  teams: "Microsoft Teams",
};

/** `approved`: only people the human approved (unknown senders ask for access) · `anyone`: everyone who can reach the bot. */
export type MessagingAccess = "approved" | "anyone";

export type MessagingState = "connecting" | "connected" | "error" | "off";

export interface MessagingStatus {
  state: MessagingState;
  /** Why it is not connected, human readable. */
  message: string | null;
  lastEventAt: ISODate | null;
}

/** The bot as the platform knows it. */
export interface MessagingBot {
  id: string;
  name: string;
  /** Telegram @username. */
  username: string | null;
  /** Slack workspace or Teams tenant. */
  team: string | null;
  /** Opens a chat with the bot. */
  url: string | null;
}

/** Settings that are not secret. */
export interface MessagingConfig {
  /** Teams: Microsoft App ID of the Azure bot. */
  appId?: string;
  /** Teams: Microsoft Entra tenant of the (single-tenant) bot. */
  tenantId?: string;
  /** Teams: public https address that reaches this Godmode (tunnel or server), e.g. "https://godmode.example.com". */
  publicUrl?: string;
}

export interface MessagingConnection {
  id: ID;
  provider: MessagingProvider;
  name: string;
  enabled: boolean;
  bot: MessagingBot;
  config: MessagingConfig;
  /** Agents people can talk to through this bot. */
  agentIds: ID[];
  /** Where a new chat starts. */
  defaultAgentId: ID | null;
  access: MessagingAccess;
  status: MessagingStatus;
  /**
   * Teams: the secret path the Azure bot delivers messages to, e.g. "/hooks/messaging/msg_…" (relative to
   * `config.publicUrl`). null for other platforms and while the vault is locked.
   */
  endpointPath: string | null;
  pendingUsers: number;
  chats: number;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export type MessagingUserStatus = "pending" | "approved" | "blocked";

/** Someone who wrote to a bot. */
export interface MessagingUser {
  id: ID;
  connectionId: ID;
  /** Platform user id. */
  externalId: string;
  name: string;
  username: string | null;
  status: MessagingUserStatus;
  /**
   * "This is me": the human who owns this Godmode, writing from this platform account. Only they get an agent's
   * questions and approval requests in their chat and can answer them there; everyone else is told the agent is
   * checking with the owner. Marking someone as the owner also approves them.
   */
  isOwner: boolean;
  lastSeenAt: ISODate | null;
  createdAt: ISODate;
}

/** `status` and/or `isOwner`. Blocking someone takes the owner mark away. */
export interface MessagingUserPatch {
  status?: MessagingUserStatus;
  isOwner?: boolean;
}

/** A chat on the platform (direct message, group, channel thread) and the conversation it continues. */
export interface MessagingChat {
  id: ID;
  connectionId: ID;
  kind: "direct" | "group";
  title: string;
  agentId: ID | null;
  conversationId: ID | null;
  lastMessageAt: ISODate | null;
  createdAt: ISODate;
}

/** Write-only: tokens are sealed in the vault and never returned. */
export type MessagingCredentials =
  | { provider: "telegram"; botToken: string }
  | { provider: "slack"; botToken: string; appToken: string }
  | { provider: "teams"; appId: string; appPassword: string; tenantId: string };

export interface MessagingConnectionInput {
  credentials: MessagingCredentials;
  /** Default: the bot's name. */
  name?: string;
  agentIds: ID[];
  /** Default: the first of `agentIds`. */
  defaultAgentId?: ID | null;
  access?: MessagingAccess;
  /** Teams: public address of this Godmode. */
  publicUrl?: string;
}

export interface MessagingConnectionPatch {
  name?: string;
  enabled?: boolean;
  agentIds?: ID[];
  defaultAgentId?: ID | null;
  access?: MessagingAccess;
  /** New tokens for the same bot. */
  credentials?: MessagingCredentials;
  publicUrl?: string;
}

export interface MessagingVerifyResult {
  bot: MessagingBot;
  /** Things to know before connecting (e.g. a Telegram webhook that will be replaced). */
  warnings: string[];
}

/** Slash command the Slack app registers (its subcommands mirror the chat commands of the other platforms). */
export const SLACK_COMMAND = "/godmode";

export const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "channels:read",
  "chat:write",
  "commands",
  "files:read",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "reactions:write",
  "users:read",
];

/** Slack app manifest for "Create New App → From a manifest". */
export function slackManifest(name: string): Record<string, unknown> {
  const display = name.trim().slice(0, 35) || "Godmode";
  return {
    display_information: { name: display, description: "Talk to your Godmode agents", background_color: "#1c1c1c" },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: display, always_online: true },
      slash_commands: [
        {
          command: SLACK_COMMAND,
          description: "Switch agents, start over or stop an answer",
          usage_hint: "agents · agent <name> · new · stop · help",
          should_escape: false,
        },
      ],
    },
    oauth_config: { scopes: { bot: SLACK_BOT_SCOPES } },
    settings: {
      event_subscriptions: { bot_events: ["app_mention", "message.im"] },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}
