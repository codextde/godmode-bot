import type { Hono } from "hono";
import { getAgent } from "../../agents/service";
import { appForTool, callAppTool, readAppResource } from "../../integrations/mcpApps";
import { getConversationSummary } from "../../services/conversations";
import { body, z } from "../validate";

const agentOf = (conversationId: string) => getAgent(getConversationSummary(conversationId).agentId);

const callSchema = z.object({
  server: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()).optional().default({}),
});

const readSchema = z.object({
  server: z.string().min(1).max(200),
  uri: z.string().min(1).max(4096),
});

export function registerMcpAppRoutes(app: Hono): void {
  app.get("/api/conversations/:id/mcp-app", async (c) => {
    const tool = c.req.query("tool") ?? "";
    return c.json({ app: tool ? await appForTool(agentOf(c.req.param("id")), tool) : null });
  });

  app.post("/api/conversations/:id/mcp-app/call", async (c) => {
    const input = await body(c, callSchema);
    return c.json(await callAppTool(agentOf(c.req.param("id")), input.server, input.name, input.arguments));
  });

  app.post("/api/conversations/:id/mcp-app/read", async (c) => {
    const input = await body(c, readSchema);
    return c.json(await readAppResource(agentOf(c.req.param("id")), input.server, input.uri));
  });
}
