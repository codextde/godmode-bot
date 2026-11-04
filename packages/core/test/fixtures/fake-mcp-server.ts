/**
 * Minimal stdio MCP server for probe tests (newline-delimited JSON-RPC).
 *
 * Env:
 *   FAKE_TOOL_PREFIX  prefix of the advertised tool names (default "tool")
 *   FAKE_MODE         "exit" → print FAKE_SECRET to stderr and exit 3 before answering
 *                     "hang" → never answer
 *                     "init-error" → answer initialize with a JSON-RPC error
 */
export {};

const prefix = process.env.FAKE_TOOL_PREFIX ?? "tool";
const mode = process.env.FAKE_MODE ?? "";

function send(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

if (mode === "exit") {
  process.stderr.write(`fatal: missing token (got ${process.env.FAKE_SECRET ?? "nothing"})\n`);
  process.exit(3);
}

// Real servers sometimes log to stdout; the client must skip non-JSON lines.
process.stdout.write("fake-mcp-server starting\n");

const decoder = new TextDecoder();
const reader = Bun.stdin.stream().getReader();
let buf = "";
let uiClient = false;
const APP_HTML = "<!doctype html><html><body><div id=app>order card</div></body></html>";
const appTools = () => [
  ...(uiClient ? [{ name: "show_order", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: "ui://orders/card" } } }] : []),
  { name: "refresh_order", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, _meta: { ui: { visibility: ["app"] } } },
  { name: "create_delivery", inputSchema: { type: "object" } },
  { name: "model_only", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["model"] } } },
  { name: "legacy_view", inputSchema: { type: "object" }, _meta: { "ui/resourceUri": "ui://orders/card" } },
];
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line) as {
      id?: number | string;
      method?: string;
      params?: { cursor?: string; protocolVersion?: string; capabilities?: { extensions?: Record<string, unknown> }; name?: string; arguments?: unknown; uri?: string };
    };
    if (mode === "hang") continue;
    if (msg.method === "initialize") {
      if (mode === "init-error") {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "initialization refused" } });
        continue;
      }
      uiClient = !!msg.params?.capabilities?.extensions?.["io.modelcontextprotocol/ui"];
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "1.0.0" },
        },
      });
      // A server → client request the client must answer (or ignore) without getting confused.
      send({ jsonrpc: "2.0", id: "srv-ping", method: "ping" });
    } else if (mode === "app" && msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: appTools() } });
    } else if (mode === "app" && msg.method === "resources/read") {
      if (msg.params?.uri !== "ui://orders/card") send({ jsonrpc: "2.0", id: msg.id, error: { code: -32002, message: "Resource not found" } });
      else
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            contents: [
              {
                uri: "ui://orders/card",
                mimeType: "text/html;profile=mcp-app",
                text: APP_HTML,
                _meta: { ui: { csp: { connectDomains: ["https://api.example.com", "javascript:alert(1)"], resourceDomains: ["https://cdn.example.com"] }, prefersBorder: true } },
              },
            ],
          },
        });
    } else if (mode === "app" && msg.method === "tools/call") {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `${msg.params?.name} ${JSON.stringify(msg.params?.arguments)} pid ${process.pid}` }] } });
    } else if (msg.method === "tools/list") {
      const second = msg.params?.cursor === "page-2";
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: second
          ? { tools: [{ name: `${prefix}_c`, inputSchema: { type: "object" } }] }
          : {
              tools: [
                { name: `${prefix}_b`, inputSchema: { type: "object" } },
                { name: `${prefix}_a`, inputSchema: { type: "object" } },
              ],
              nextCursor: "page-2",
            },
      });
    } else if (msg.method && msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
    }
  }
}
