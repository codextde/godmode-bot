import type { Hono } from "hono";
import type { ConnectStatus, ConnectorCreated } from "@godmode/shared";
import { addToClaudeCode, claudeCodeInstalled, removeFromClaudeCode } from "../../connect/claudeCode";
import { connectorSetup, createConnector, listConnectors, removeConnector, setConnectorInstalled } from "../../connect/connectors";
import { connectorTools } from "../../mcp/tools";
import { body, z } from "../validate";

/** Connected apps: Claude Code and other MCP clients that may set Godmode up from outside (connect/connectors.ts). */
export function registerConnectorRoutes(app: Hono): void {
  app.get("/api/connectors", (c) => c.json({ connectors: listConnectors(), claudeCode: claudeCodeInstalled(), tools: connectorTools() } satisfies ConnectStatus));

  // The key is in the answer and nowhere else: Godmode keeps its hash.
  app.post("/api/connectors", async (c) => {
    const input = await body(
      c,
      z.object({
        name: z.string().trim().min(1).max(80),
        client: z.enum(["claude-code", "other"]),
        access: z.enum(["manage", "read"]),
        install: z.boolean().optional(),
      }),
    );
    const { connector, token } = createConnector(input);
    const setup = connectorSetup(token);
    if (!input.install || input.client !== "claude-code") return c.json({ connector, setup, install: null } satisfies ConnectorCreated, 201);
    const install = await addToClaudeCode(setup);
    const before = listConnectors().filter((old) => old.installed && old.id !== connector.id);
    if (!install.ok) {
      // Adding takes the earlier entry out first: whatever was in Claude Code is gone, and removing those apps later must not take out an entry pasted by hand.
      for (const old of before) setConnectorInstalled(old.id, false);
      return c.json({ connector, setup, install } satisfies ConnectorCreated, 201);
    }
    // Claude Code holds one entry for Godmode: the keys of the entries this one replaced open nothing anymore.
    for (const old of before) removeConnector(old.id);
    return c.json({ connector: setConnectorInstalled(connector.id, true), setup, install } satisfies ConnectorCreated, 201);
  });

  app.delete("/api/connectors/:id", async (c) => {
    const removed = removeConnector(c.req.param("id"));
    if (removed.installed) await removeFromClaudeCode();
    return c.json({ ok: true as const });
  });
}
