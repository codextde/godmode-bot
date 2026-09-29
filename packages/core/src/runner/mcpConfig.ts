/**
 * Builds the `--mcp-config` file for a run: the Godmode gateway (per-run bearer token), the browser
 * (browser-use MCP bound to the agent's Chromium profile), computer use (when a screen, window or tab is shared),
 * the macOS VM tools (when the run works in a VM) and the agent's external MCP servers.
 * The file contains the run token and decrypted MCP secrets, so it is written 0600 and deleted after the run.
 */
import { rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@godmode/shared";
import { BROWSER_MCP_NAME, COMPUTER_MCP_NAME, GODMODE_MCP_NAME, VM_MCP_NAME } from "@godmode/shared";
import { config, isLoopbackHost } from "../config";
import { browserMcpServer } from "../browser/manager";
import { mcpServersForAgent } from "../integrations/mcpServers";
import { getSettings } from "../services/settings";
import { logger } from "../log";
import type { McpConfigFile, McpServerJson } from "../types";

const log = logger("runner");

/** URL Claude uses to reach the gateway. Wildcard/loopback binds are reached over 127.0.0.1. */
export function gatewayUrl(): string {
  const cfg = config();
  const host = cfg.host;
  const wildcard = host === "0.0.0.0" || host === "::" || host === "[::]" || host === "";
  const reachable = wildcard || isLoopbackHost(host) ? "127.0.0.1" : host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${reachable}:${cfg.port}/mcp`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function buildMcpConfig(
  agent: Agent,
  runToken: string,
  opts: { onNotice?: (text: string) => void; computer?: boolean; vm?: boolean; gatewayOnly?: boolean } = {},
): Promise<McpConfigFile> {
  const servers: Record<string, McpServerJson> = {};
  // Dreams get the Godmode gateway only: no integrations, browser or computer.
  if (opts.gatewayOnly) {
    servers[GODMODE_MCP_NAME] = { type: "http", url: gatewayUrl(), headers: { Authorization: `Bearer ${runToken}` } };
    return { mcpServers: servers };
  }

  try {
    const external = await mcpServersForAgent(agent);
    for (const [name, server] of Object.entries(external)) {
      if (name === GODMODE_MCP_NAME || name === BROWSER_MCP_NAME || name === COMPUTER_MCP_NAME || name === VM_MCP_NAME) {
        log.warn(`MCP server name "${name}" is reserved; skipping it for agent ${agent.id}`);
        opts.onNotice?.(`The MCP server "${name}" was skipped because its name is reserved by Godmode.`);
        continue;
      }
      servers[name] = server;
    }
  } catch (err) {
    log.warn(`could not load MCP servers for agent ${agent.id}`, err);
    opts.onNotice?.(`Some integrations (MCP servers) are unavailable for this run: ${errorText(err)}`);
  }

  if (agent.browser.enabled && getSettings().browser.enabled) {
    try {
      const browser = await browserMcpServer(agent);
      if (browser) servers[BROWSER_MCP_NAME] = browser;
    } catch (err) {
      log.warn(`browser tools unavailable for agent ${agent.id}`, err);
      opts.onNotice?.(`Browser tools are unavailable for this run: ${errorText(err)}`);
    }
  }

  servers[GODMODE_MCP_NAME] = {
    type: "http",
    url: gatewayUrl(),
    headers: { Authorization: `Bearer ${runToken}` },
  };

  // Computer use: the screen, window or tab the human shared (served by the gateway, scoped by the run token).
  if (opts.computer) {
    servers[COMPUTER_MCP_NAME] = {
      type: "http",
      url: `${gatewayUrl()}/computer`,
      headers: { Authorization: `Bearer ${runToken}` },
    };
  }

  // macOS VM: shell and file tools inside the VM the run works in (scoped by the run token).
  if (opts.vm) {
    servers[VM_MCP_NAME] = {
      type: "http",
      url: `${gatewayUrl()}/vm`,
      headers: { Authorization: `Bearer ${runToken}` },
    };
  }

  return { mcpServers: servers };
}

export function mcpConfigPath(runId: string): string {
  return join(tmpdir(), `godmode-mcp-${runId}.json`);
}

/** Write the config (0600) and return its path. */
export function writeMcpConfigFile(runId: string, file: McpConfigFile): string {
  const path = mcpConfigPath(runId);
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
  try {
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
  return path;
}

export function removeMcpConfigFile(path: string | null) {
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch (err) {
    log.warn(`could not delete ${path}`, err);
  }
}
