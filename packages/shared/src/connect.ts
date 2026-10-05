/**
 * Connected apps: Claude Code and other AI tools that speak MCP set Godmode up from outside — create and change
 * agents, automations and tasks, and look at their work. Each app has its own key, which opens the management tools of
 * the Godmode MCP gateway and nothing else.
 */
import type { ID, ISODate } from "./models";

export const CONNECT_TOKEN_PREFIX = "gmc_";
/** Where `godmode mcp`, `godmode tools` and `godmode call` read the key from. */
export const CONNECT_TOKEN_ENV = "GODMODE_CONNECT_TOKEN";

/** `manage`: set up and steer (create, change, delete, start) · `read`: look only. */
export type ConnectorAccess = "manage" | "read";
export type ConnectorClient = "claude-code" | "other";

export interface Connector {
  id: ID;
  name: string;
  client: ConnectorClient;
  access: ConnectorAccess;
  /** Godmode added it to Claude Code on this computer (and takes it out again when the app is removed). */
  installed: boolean;
  calls: number;
  lastTool: string | null;
  lastUsedAt: ISODate | null;
  createdAt: ISODate;
}

/** A tool a connected app may call. */
export interface ConnectorTool {
  name: string;
  description: string;
  access: ConnectorAccess;
}

/** How an app reaches Godmode with a new key. Holds the key: shown once, never stored. */
export interface ConnectorSetup {
  token: string;
  /** The MCP server as a program (stdio): works in every MCP client on this computer, whichever port Godmode listens on. */
  command: string;
  args: string[];
  env: Record<string, string>;
  /** The MCP server over HTTP, for apps that take a URL and a header. */
  url: string;
  /** One line for a terminal: adds the server to Claude Code for every project. */
  claudeCommand: string;
  /** `{ "mcpServers": { "godmode": … } }` for apps configured with a JSON file. */
  json: string;
  /** Shell lines that try the key with the `godmode` command line. */
  cli: string;
}

export interface ConnectorCreated {
  connector: Connector;
  setup: ConnectorSetup;
  /** What adding it to Claude Code came to; null when that wasn't asked for. */
  install: { ok: boolean; detail: string } | null;
}

/** GET /api/connectors */
export interface ConnectStatus {
  connectors: Connector[];
  /** Claude Code is installed on this computer, so Godmode can add itself to it. */
  claudeCode: boolean;
  /** What a connected app can call, read-only tools first. */
  tools: ConnectorTool[];
}

export interface ConnectorInput {
  name: string;
  client: ConnectorClient;
  access: ConnectorAccess;
  /** Add it to Claude Code on this computer right away (`client: "claude-code"` only). */
  install?: boolean;
}
