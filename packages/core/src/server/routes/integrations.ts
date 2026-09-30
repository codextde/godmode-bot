import type { Hono } from "hono";
import type { McpServerInput } from "@godmode/shared";
import { body, z } from "../validate";
import { badRequest } from "../../util";
import { createMcpServer, deleteMcpServer, listMcpServers, updateMcpServer, TRANSPORTS } from "../../integrations/mcpServers";
import { probeMcpServer } from "../../integrations/mcpProbe";
import * as composio from "../../integrations/composio";
import { getTriggerType, listTriggerTypes } from "../../integrations/composioTriggers";
import { apiToolKey, apiToolPatchNeedsGrant, createApiTool, deleteApiTool, getApiTool, listApiTools, updateApiTool } from "../../integrations/apiTools";
import { testApiToolKey } from "../../integrations/apiToolRequest";
import { requireGrant } from "../grants";

const transport = z.enum(TRANSPORTS as [McpServerInput["transport"], ...McpServerInput["transport"][]]);
const secretMap = z.record(z.string().max(256), z.string().max(16_384));

const mcpFields = {
  workspaceId: z.string().min(1).nullable(),
  agentId: z.string().min(1).nullable(),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000),
  transport,
  command: z.string().max(1024),
  args: z.array(z.string().max(8192)).max(200),
  url: z.string().max(4096),
  env: secretMap,
  headers: secretMap,
  enabled: z.boolean(),
};

const createSchema = z.object({
  ...mcpFields,
  workspaceId: mcpFields.workspaceId.optional().default(null),
  agentId: mcpFields.agentId.optional().default(null),
  description: mcpFields.description.optional(),
  command: mcpFields.command.optional(),
  args: mcpFields.args.optional(),
  url: mcpFields.url.optional(),
  env: mcpFields.env.optional(),
  headers: mcpFields.headers.optional(),
  enabled: mcpFields.enabled.optional(),
});

const patchSchema = z.object(mcpFields).partial();

const connectSchema = z.object({
  toolkit: z.string().trim().min(1).max(100),
  workspaceId: z.string().min(1).nullable().optional().default(null),
  agentId: z.string().min(1).nullable().optional().default(null),
});

const keySchema = z.object({ apiKey: z.string().max(512).nullable() });

const apiToolFields = {
  workspaceId: z.string().min(1).nullable(),
  agentId: z.string().min(1).nullable(),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000),
  docs: z.string().max(100_000),
  docsUrl: z.string().max(2048),
  baseUrl: z.string().max(2048),
  auth: z.object({ in: z.enum(["header", "query"]), name: z.string().max(100), prefix: z.string().max(64) }),
  testPath: z.string().max(2048),
  envVar: z.string().max(100).nullable(),
  preset: z.string().max(40).nullable(),
  apiKey: z.string().max(16_384),
  enabled: z.boolean(),
};

const apiToolCreateSchema = z.object(apiToolFields).partial().required({ name: true });
const apiToolPatchSchema = z.object(apiToolFields).partial();

export function registerIntegrationRoutes(app: Hono): void {
  /* ---------------------------- MCP servers ---------------------------- */

  app.get("/api/mcp-servers", (c) =>
    c.json(listMcpServers({ workspaceId: c.req.query("workspaceId") || "all", agentId: c.req.query("agentId") || null })),
  );

  app.post("/api/mcp-servers", async (c) => {
    const input = await body(c, createSchema);
    return c.json(await createMcpServer(input), 201);
  });

  app.patch("/api/mcp-servers/:id", async (c) => {
    const patch = await body(c, patchSchema);
    return c.json(await updateMcpServer(c.req.param("id"), patch));
  });

  app.delete("/api/mcp-servers/:id", (c) => {
    deleteMcpServer(c.req.param("id"));
    return c.json({ ok: true as const });
  });

  app.post("/api/mcp-servers/:id/test", async (c) => c.json(await probeMcpServer(c.req.param("id"))));

  /* ------------------------------ API tools ---------------------------- */

  app.get("/api/api-tools", (c) =>
    c.json(listApiTools({ workspaceId: c.req.query("workspaceId") || "all", agentId: c.req.query("agentId") || null })),
  );

  app.post("/api/api-tools", async (c) => {
    const input = await body(c, apiToolCreateSchema);
    return c.json(createApiTool(input), 201);
  });

  app.patch("/api/api-tools/:id", async (c) => {
    const id = c.req.param("id");
    const patch = await body(c, apiToolPatchSchema);
    // A saved key only reaches new places (runs' environment, another address) with the vault passphrase.
    if (apiToolPatchNeedsGrant(getApiTool(id), patch)) requireGrant(c);
    return c.json(updateApiTool(id, patch));
  });

  app.delete("/api/api-tools/:id", (c) => {
    deleteApiTool(c.req.param("id"));
    return c.json({ ok: true as const });
  });

  app.post("/api/api-tools/:id/test", async (c) => {
    const tool = getApiTool(c.req.param("id"));
    return c.json(await testApiToolKey(tool, tool.hasKey ? apiToolKey(tool.id) : null));
  });

  /* ------------------------------ Composio ----------------------------- */

  app.get("/api/composio/status", async (c) => c.json(await composio.getStatus(c.req.query("refresh") === "1")));

  app.put("/api/composio/key", async (c) => {
    const { apiKey } = await body(c, keySchema);
    return c.json(await composio.setApiKey(apiKey));
  });

  app.get("/api/composio/toolkits", async (c) =>
    c.json(
      await composio.listToolkits({
        search: c.req.query("search") || undefined,
        category: c.req.query("category") || undefined,
        cursor: c.req.query("cursor") || undefined,
      }),
    ),
  );

  app.get("/api/composio/connections", (c) => c.json(composio.listConnections()));

  app.get("/api/composio/trigger-types", async (c) => {
    const toolkit = c.req.query("toolkit")?.trim();
    if (!toolkit) throw badRequest("Pass the app (toolkit) whose events you want");
    return c.json(await listTriggerTypes(toolkit));
  });

  app.get("/api/composio/trigger-types/:slug", async (c) => c.json(await getTriggerType(c.req.param("slug"))));

  app.post("/api/composio/connect", async (c) => {
    const input = await body(c, connectSchema);
    return c.json(await composio.connect(input));
  });

  app.post("/api/composio/connections/:id/refresh", async (c) => c.json(await composio.refreshConnection(c.req.param("id"))));

  app.delete("/api/composio/connections/:id", async (c) => {
    await composio.disconnect(c.req.param("id"));
    return c.json({ ok: true as const });
  });
}
