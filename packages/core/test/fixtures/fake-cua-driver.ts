/**
 * Fake `cua-driver mcp` for computer-use tests (newline-delimited JSON-RPC over stdio). Its first argument is a state
 * directory: every tools/call is appended to `calls.jsonl` there. It answers like the real driver where Godmode
 * depends on it:
 *  - get_window_state returns a 1600×1200 screenshot of an 800×600 window at (100, 50), unless include_screenshot is
 *    false,
 *  - double_click / right_click refuse a per-call `target` (invalid_action_target),
 *  - an action at pixels is refused with screenshot_context_missing while the file `refuse-pixels` in the state
 *    directory holds a count above 0 (each refusal takes one off) — what the real driver answers once it has dropped
 *    the window's screenshot.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2]!;
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function send(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function refused(code: string, text: string) {
  return { isError: true, content: [{ type: "text", text }], structuredContent: { code } };
}

function call(name: string, args: Record<string, unknown>) {
  if ((name === "double_click" || name === "right_click") && args.target) return refused("invalid_action_target", `${name} does not accept a per-call target`);
  if (name === "get_window_state" && args.include_screenshot !== false) {
    return {
      content: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }],
      structuredContent: { screenshot_width: 1600, screenshot_height: 1200, window_bounds: { x: 100, y: 50, width: 800, height: 600 } },
    };
  }
  const pending = join(dir, "refuse-pixels");
  if (("x" in args || "from_x" in args) && existsSync(pending)) {
    const left = Number(readFileSync(pending, "utf8"));
    if (left > 0) {
      writeFileSync(pending, String(left - 1));
      return refused("screenshot_context_missing", "No current snapshot for this window contains a screenshot owned by this session.");
    }
  }
  return { content: [], structuredContent: {} };
}

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
    const msg = JSON.parse(line) as { id?: number; method?: string; params?: { name: string; arguments: Record<string, unknown> } };
    if (msg.id === undefined) continue;
    if (msg.method === "tools/call") {
      const { name, arguments: args } = msg.params!;
      appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ name, ...args }) + "\n");
      send({ jsonrpc: "2.0", id: msg.id, result: call(name, args) });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cua-driver", version: "fake" } } });
    }
  }
}
