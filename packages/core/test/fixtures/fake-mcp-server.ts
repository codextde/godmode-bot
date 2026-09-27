/**
 * Minimal stdio MCP server for probe tests (newline-delimited JSON-RPC).
 *
 * Env:
 *   FAKE_TOOL_PREFIX  prefix of the advertised tool names (default "tool")
 *   FAKE_MODE         "exit" → print FAKE_SECRET to stderr and exit 3 before answering
 *                     "hang" → never answer
 *                     "init-error" → answer initialize with a JSON-RPC error
 */
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
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line) as { id?: number | string; method?: string; params?: { cursor?: string; protocolVersion?: string } };
    if (mode === "hang") continue;
    if (msg.method === "initialize") {
      if (mode === "init-error") {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "initialization refused" } });
        continue;
      }
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
