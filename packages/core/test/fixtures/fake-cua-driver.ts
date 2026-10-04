/**
 * Fake `cua-driver mcp` for computer-use tests (newline-delimited JSON-RPC over stdio). Its first argument is a state
 * directory: every tools/call is appended to `calls.jsonl` there. It answers like the real driver where Godmode
 * depends on it:
 *  - get_window_state returns a 1600×1200 screenshot of an 800×600 window at (100, 50), unless include_screenshot is
 *    false,
 *  - double_click / right_click refuse a per-call `target` (invalid_action_target),
 *  - an action at pixels is refused with screenshot_context_missing while the file `refuse-pixels` in the state
 *    directory holds a count above 0 (each refusal takes one off) — what the real driver answers once it has dropped
 *    the window's screenshot,
 *  - get_desktop_state captures a 1920×1080 primary display downsized to `max_image_dimension`, and the coordinates
 *    of later desktop actions are scaled by how much the last capture was downsized (desktop_capture_scale.rs:
 *    record_desktop_state / map_desktop_args), then truncated to whole pixels as on Windows (`as i32`). The
 *    coordinates an action ends up at are logged as `effective`,
 *  - it notes its pid in `started` when it starts, and answers `initialize` only after the milliseconds in the file
 *    `init-delay-ms` (if there is one).
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2]!;
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const SCREEN = { width: 1920, height: 1080 };
const COORDINATES = ["x", "y", "from_x", "from_y", "to_x", "to_y"];

/** The session's factor from the last desktop capture's pixels to native ones (null = 1:1). */
let desktopScale: { x: number; y: number } | null = null;

function send(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function refused(code: string, text: string) {
  return { isError: true, content: [{ type: "text", text }], structuredContent: { code } };
}

function desktopState(args: Record<string, unknown>) {
  const max = typeof args.max_image_dimension === "number" ? args.max_image_dimension : 0;
  const fit = max > 0 ? Math.min(1, max / Math.max(SCREEN.width, SCREEN.height)) : 1;
  const width = Math.round(SCREEN.width * fit);
  const height = Math.round(SCREEN.height * fit);
  const x = SCREEN.width / width;
  const y = SCREEN.height / height;
  desktopScale = x !== 1 || y !== 1 ? { x, y } : null;
  return {
    content: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }],
    structuredContent: { screenshot_width: width, screenshot_height: height, screenshot_original_width: SCREEN.width, screenshot_original_height: SCREEN.height },
  };
}

/** Where a desktop action's coordinates end up once the driver has scaled them. */
function effective(args: Record<string, unknown>): Record<string, number> | null {
  const target = args.target as { kind?: string } | undefined;
  const desktop = target?.kind === "desktop" || args.scope === "desktop" || args.coordinate_frame === "desktop";
  const out: Record<string, number> = {};
  for (const key of COORDINATES) {
    if (typeof args[key] !== "number") continue;
    const factor = !desktop || args.capture_id || !desktopScale ? 1 : key.endsWith("x") ? desktopScale.x : desktopScale.y;
    out[key] = Math.trunc((args[key] as number) * factor);
  }
  return desktop && Object.keys(out).length ? out : null;
}

function call(name: string, args: Record<string, unknown>) {
  if ((name === "double_click" || name === "right_click") && args.target) return refused("invalid_action_target", `${name} does not accept a per-call target`);
  if (name === "get_desktop_state") return desktopState(args);
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

appendFileSync(join(dir, "started"), `${process.pid}\n`);
const initDelay = existsSync(join(dir, "init-delay-ms")) ? Number(readFileSync(join(dir, "init-delay-ms"), "utf8")) : 0;

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
      const at = effective(args);
      appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ name, ...args, ...(at ? { effective: at } : {}) }) + "\n");
      send({ jsonrpc: "2.0", id: msg.id, result: call(name, args) });
    } else {
      if (msg.method === "initialize" && initDelay) await Bun.sleep(initDelay);
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cua-driver", version: "fake" } } });
    }
  }
}
