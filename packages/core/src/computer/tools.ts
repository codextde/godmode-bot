/**
 * The `computer` MCP server (POST /mcp/computer, per-run bearer token): what a run may do with the screen, window or
 * browser tab the human shared. The main tool mirrors the action vocabulary Claude knows from computer use
 * (screenshot, left_click, type, key, scroll, zoom, …); coordinates are pixels of the latest screenshot and are mapped
 * back to the screen by Godmode. Window shares add the window's accessibility elements (`computer_ui`), desktop
 * shares add apps and windows.
 */
import { z } from "zod";
import type { ComputerTarget } from "@godmode/shared";
import { computerTargetLabel } from "@godmode/shared";
import { bus } from "../events/bus";
import { logger } from "../log";
import { audit } from "../services/audit";
import { getSettings } from "../services/settings";
import { sleep } from "../util";
import type { RunContext } from "../types";
import { EngineError, errorMessage, type Capture, type PointerOptions } from "./engine";
import { frameToImage, imageToFrame, inImage, regionToFrame, relativeInFrame, type Point, type Shot } from "./geometry";
import { KeyError, normalizeModifier, parseKeyCombo, parseKeySequence, type Modifier } from "./keys";
import { assertActive, isGodmodeWindow, RevokedError, runComputer, type RunComputer } from "./service";
import { sleepFor } from "./engine";
import { isGodmodeAppName } from "./self";

const log = logger("computer");

export interface ComputerToolResult {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
}

const ACTIONS = [
  "screenshot",
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "mouse_move",
  "left_click_drag",
  "scroll",
  "type",
  "key",
  "hold_key",
  "wait",
  "cursor_position",
  "zoom",
] as const;
type Action = (typeof ACTIONS)[number];

const coordinate = z.tuple([z.number(), z.number()]);

function computerSchema(kind: ComputerTarget["kind"], allowForeground: boolean) {
  return z.object({
    action: z.enum(ACTIONS),
    coordinate: coordinate.optional().describe("[x, y] in pixels of the latest screenshot (clicks, mouse_move, scroll position, drag end)"),
    start_coordinate: coordinate.optional().describe("left_click_drag: where the drag starts"),
    text: z
      .string()
      .max(20_000)
      .optional()
      .describe('type: the text to type. key / hold_key: keys like "Return", "ctrl+s", "cmd+shift+t" (several separated by spaces)'),
    modifiers: z.string().max(40).optional().describe('Keys held during a click or drag, e.g. "shift" or "cmd+shift"'),
    scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
    scroll_amount: z.number().int().min(1).max(30).optional().describe("Wheel notches (default 3)"),
    duration: z.number().min(0).max(30).optional().describe("Seconds, for wait and hold_key"),
    region: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().describe("zoom: [x1, y1, x2, y2] of the latest screenshot"),
    screenshot: z.boolean().optional().describe("Return a new screenshot after the action (default true)"),
    ...(kind === "desktop" ? { display: z.string().optional().describe("Display id (see computer_info). Default: the display of your latest screenshot") } : {}),
    ...(kind === "window"
      ? {
          element: z
            .string()
            .optional()
            .describe("Element token from computer_ui — click or type into that element through accessibility (most reliable in the background)"),
          ...(allowForeground ? { foreground: z.boolean().optional().describe("Bring the window to the front briefly for this action (only when a background action didn't work)") } : {}),
        }
      : {}),
  });
}

type ComputerArgs = z.infer<ReturnType<typeof computerSchema>> & { display?: string; element?: string; foreground?: boolean };

function describeTarget(target: ComputerTarget): string {
  switch (target.kind) {
    case "desktop":
      return "the human's entire desktop (every display) with the real mouse and keyboard — the human sees everything you do, and your actions go wherever the pointer and keyboard focus are";
    case "display":
      return `one display of the human's computer (${computerTargetLabel(target)}) with the real mouse and keyboard — stay on that display`;
    case "window":
      return `one app window the human shared (${computerTargetLabel(target)}). You work in the background: your input goes only to this window, the human keeps using their mouse and keyboard, and other apps are off limits`;
    case "tab":
      return `one browser tab the human shared (${computerTargetLabel(target)}), in the background`;
  }
}

function toolDescription(target: ComputerTarget, allowForeground: boolean): string {
  const lines = [
    `See and control ${describeTarget(target)}.`,
    `Start with {action:"screenshot"}. Coordinates are pixels of your latest screenshot${target.kind === "desktop" ? " of that display" : ""}; after every action you get a fresh screenshot (pass screenshot:false to skip it).`,
    'Actions: screenshot, left_click, right_click, middle_click, double_click, triple_click (coordinate; hold keys with modifiers:"shift"), mouse_move, left_click_drag (start_coordinate → coordinate), scroll (coordinate, scroll_direction, scroll_amount), type (text), key (text like "Return" or "cmd+c"), hold_key (text, duration), wait (duration), cursor_position, zoom (region — a sharper look; keep using full-screenshot coordinates for actions).',
  ];
  if (target.kind === "window") {
    lines.push(
      'Prefer elements: call computer_ui, then {action:"left_click", element:"<token>"} or {action:"type", element, text} — accessibility actions work even when the window is covered or on another Space. Keyboard shortcuts with cmd/ctrl may not reach a background window; use menus or elements instead.',
    );
    if (allowForeground) lines.push("If a background action did nothing, retry it with foreground:true — the window comes to the front briefly.");
  }
  if (target.kind === "desktop") lines.push("Several displays: pass display (see computer_info) to screenshot or act on another one.");
  lines.push("Never type passwords or 2FA codes — ask the human instead of guessing credentials. Never operate Godmode's own window.");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function text(t: string, isError = false): ComputerToolResult {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

function round(p: Point): string {
  return `(${Math.round(p.x)}, ${Math.round(p.y)})`;
}

async function resolveView(rc: RunComputer, display?: string): Promise<string> {
  if (rc.target.kind === "desktop") {
    if (display) {
      const views = await rc.engine.views();
      const wanted = display.startsWith("display:") ? display : `display:${display}`;
      const v = views.find((x) => x.view === wanted || x.label.toLowerCase() === display.toLowerCase());
      if (!v) throw new EngineError(`No display "${display}". Displays: ${views.map((x) => `${x.displayId} (${x.label})`).join(", ")}`, "bad_request");
      return v.view;
    }
    if (rc.view) return rc.view;
    const views = await rc.engine.views();
    return (views.find((v) => v.primary) ?? views[0])!.view;
  }
  if (rc.view) return rc.view;
  const views = await rc.engine.views();
  return views[0]!.view;
}

async function takeShot(rc: RunComputer, view: string): Promise<Capture> {
  const maxEdge = getSettings().computer.screenshotMaxSize;
  const cap = await rc.engine.capture(view, { maxEdge, purpose: "model", format: "jpeg", quality: 0.8 });
  rc.shots.set(view, { width: cap.width, height: cap.height, frame: cap.frame });
  rc.view = view;
  return cap;
}

function shotContent(cap: Capture, caption: string): ComputerToolResult {
  return {
    content: [
      { type: "image", data: cap.data, mimeType: cap.mime },
      { type: "text", text: `${caption}${caption ? " " : ""}Screenshot of ${cap.label} (${cap.width}×${cap.height} px).` },
    ],
  };
}

function toFrame(rc: RunComputer, view: string, coord: [number, number] | undefined, what = "coordinate"): Point {
  if (!coord) throw new EngineError(`${what} [x, y] is required for this action.`, "bad_request");
  const shot = rc.shots.get(view);
  if (!shot) throw new EngineError('Take a screenshot first ({action:"screenshot"}) — coordinates refer to your latest screenshot.', "bad_request");
  const [x, y] = coord;
  if (!inImage(shot, x, y)) throw new EngineError(`${what} [${x}, ${y}] is outside the screenshot (${shot.width}×${shot.height}).`, "bad_request");
  return imageToFrame(shot, x, y);
}

function parseModifiers(input?: string): Modifier[] {
  if (!input?.trim()) return [];
  const out: Modifier[] = [];
  for (const part of input.split(/[+\s,]+/).filter(Boolean)) {
    const m = normalizeModifier(part);
    if (!m) throw new EngineError(`Unknown modifier "${part}" (use shift, ctrl, alt/option, cmd/super).`, "bad_request");
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

function emitAction(rc: RunComputer, view: string, action: string, p?: Point) {
  const shot = rc.shots.get(view);
  const rel = p && shot ? relativeInFrame(shot.frame, p) : null;
  bus.emit({ type: "computer.action", view, runId: rc.runId, action, ...(rel ? { x: rel.x, y: rel.y } : {}) });
}

const TYPE_CHUNK = 200;

/** Seconds to let the UI settle before the follow-up screenshot. */
function settleMs(action: Action): number {
  if (action === "type" || action === "mouse_move") return 250;
  if (action === "scroll") return 350;
  return 450;
}

async function afterAction(rc: RunComputer, view: string, action: Action, detail: string, wantShot: boolean | undefined): Promise<ComputerToolResult> {
  if (wantShot === false || rc.revoked) return text(`${detail}.`);
  await sleep(settleMs(action));
  try {
    return shotContent(await takeShot(rc, view), `${detail}.`);
  } catch (err) {
    return text(`${detail}. (Couldn't take a new screenshot: ${errorMessage(err)})`);
  }
}

/* ------------------------------------------------------------------ */
/* computer                                                             */
/* ------------------------------------------------------------------ */

async function computerAction(rc: RunComputer, args: ComputerArgs): Promise<ComputerToolResult> {
  const engine = rc.engine;
  const view = await resolveView(rc, args.display);
  const foreground = args.foreground === true;
  const pointer = (button: PointerOptions["button"], count: number): PointerOptions => ({ button, count, modifiers: parseModifiers(args.modifiers), foreground });

  switch (args.action) {
    case "screenshot":
      return shotContent(await takeShot(rc, view), "");

    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click": {
      const button = args.action === "right_click" ? "right" : args.action === "middle_click" ? "middle" : "left";
      const count = args.action === "double_click" ? 2 : args.action === "triple_click" ? 3 : 1;
      if (args.element) {
        if (!engine.clickElement) throw new EngineError("element is only available for a shared window.", "bad_request");
        const out = await engine.clickElement(args.element, pointer(button, count));
        emitAction(rc, view, args.action);
        return afterAction(rc, view, args.action, out.detail, args.screenshot);
      }
      const p = toFrame(rc, view, args.coordinate);
      const out = await engine.click(view, p, pointer(button, count));
      emitAction(rc, view, args.action, p);
      return afterAction(rc, view, args.action, `${out.detail} at ${round({ x: args.coordinate![0], y: args.coordinate![1] })}`, args.screenshot);
    }

    case "mouse_move": {
      const p = toFrame(rc, view, args.coordinate);
      const out = await engine.move(view, p);
      emitAction(rc, view, args.action, p);
      return afterAction(rc, view, args.action, out.detail, args.screenshot);
    }

    case "left_click_drag": {
      const from = toFrame(rc, view, args.start_coordinate, "start_coordinate");
      const to = toFrame(rc, view, args.coordinate);
      const out = await engine.drag(view, from, to, pointer("left", 1));
      emitAction(rc, view, args.action, to);
      return afterAction(rc, view, args.action, out.detail, args.screenshot);
    }

    case "scroll": {
      const dir = args.scroll_direction ?? "down";
      const amount = args.scroll_amount ?? 3;
      const p = args.coordinate ? toFrame(rc, view, args.coordinate) : null;
      const dx = dir === "left" ? -amount : dir === "right" ? amount : 0;
      const dy = dir === "up" ? -amount : dir === "down" ? amount : 0;
      const out = await engine.scroll(view, p, dx, dy, { foreground });
      emitAction(rc, view, args.action, p ?? undefined);
      return afterAction(rc, view, args.action, `${out.detail} ${dir} ×${amount}`, args.screenshot);
    }

    case "type": {
      if (!args.text) throw new EngineError("text is required for type.", "bad_request");
      let out;
      if (args.element) {
        if (!engine.typeInto) throw new EngineError("element is only available for a shared window.", "bad_request");
        out = await engine.typeInto(args.element, args.text, { foreground });
      } else {
        // Long text goes in chunks, so stopping the share stops the typing.
        const chars = [...args.text];
        for (let i = 0; i < chars.length; i += TYPE_CHUNK) {
          assertActive(rc);
          out = await engine.type(view, chars.slice(i, i + TYPE_CHUNK).join(""), { foreground });
        }
        if (chars.length > TYPE_CHUNK) out = { detail: `Typed ${chars.length} characters` };
      }
      emitAction(rc, view, args.action);
      return afterAction(rc, view, args.action, out!.detail, args.screenshot);
    }

    case "key": {
      if (!args.text?.trim()) throw new EngineError('text is required for key, e.g. "Return" or "ctrl+s".', "bad_request");
      const combos = parseKeySequence(args.text);
      const out = await engine.keys(view, combos, { foreground });
      emitAction(rc, view, args.action);
      return afterAction(rc, view, args.action, `${out.detail} ${args.text.trim()}`, args.screenshot);
    }

    case "hold_key": {
      if (!args.text?.trim()) throw new EngineError("text is required for hold_key.", "bad_request");
      if (!engine.holdKeys) throw new EngineError("hold_key isn't available for this share.", "unsupported");
      const combo = parseKeyCombo(args.text.trim());
      const out = await engine.holdKeys(view, combo, Math.round((args.duration ?? 1) * 1000), rc.abort.signal);
      return afterAction(rc, view, args.action, `${out.detail} ${args.text.trim()}`, args.screenshot);
    }

    case "wait": {
      await sleepFor(Math.round((args.duration ?? 1) * 1000), rc.abort.signal);
      assertActive(rc);
      return afterAction(rc, view, args.action, `Waited ${args.duration ?? 1}s`, args.screenshot);
    }

    case "cursor_position": {
      if (!engine.cursor) throw new EngineError("There is no shared pointer — you work in the background, so only your own actions have a position.", "unsupported");
      const c = await engine.cursor();
      const shot = rc.shots.get(view);
      if (!shot) return text(`The pointer is at ${round(c)} (screen points). Take a screenshot to get it in screenshot pixels.`);
      const p = frameToImage(shot, c.x, c.y);
      return text(inImage(shot, p.x, p.y) ? `The pointer is at ${round(p)} in your latest screenshot.` : "The pointer is on another display (outside your latest screenshot).");
    }

    case "zoom": {
      if (!args.region) throw new EngineError("region [x1, y1, x2, y2] is required for zoom.", "bad_request");
      const shot = rc.shots.get(view);
      if (!shot) throw new EngineError("Take a screenshot first — the zoom region refers to it.", "bad_request");
      const [x1, y1, x2, y2] = args.region;
      if (!inImage(shot, x1, y1) || !inImage(shot, x2, y2)) throw new EngineError(`The region is outside the screenshot (${shot.width}×${shot.height}).`, "bad_request");
      const region = regionToFrame(shot, args.region);
      const cap = await engine.capture(view, { maxEdge: getSettings().computer.screenshotMaxSize, purpose: "model", format: "jpeg", quality: 0.85, region });
      return {
        content: [
          { type: "image", data: cap.data, mimeType: cap.mime },
          { type: "text", text: `Zoomed in on [${args.region.map(Math.round).join(", ")}] (${cap.width}×${cap.height} px). Keep using coordinates of the full screenshot for actions.` },
        ],
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* computer_ui / computer_info / desktop tools                          */
/* ------------------------------------------------------------------ */

async function uiElements(rc: RunComputer, query?: string): Promise<ComputerToolResult> {
  if (!rc.engine.elements) return text("computer_ui is only available for a shared window.", true);
  const view = await resolveView(rc);
  if (!rc.shots.get(view)) await takeShot(rc, view).catch(() => null);
  const shot: Shot | undefined = rc.shots.get(view);
  const { elements, note } = await rc.engine.elements(query);
  if (!elements.length) return text(note ?? (query ? `No elements match "${query}".` : "The window exposes no accessibility elements; use screenshots and coordinates."));
  const lines = elements.slice(0, 400).map((e) => {
    const indent = "  ".repeat(Math.min(e.depth, 8));
    const label = e.label ? ` "${e.label.slice(0, 80)}"` : "";
    const value = e.value && e.value !== e.label ? ` value="${e.value.replace(/\s+/g, " ").slice(0, 80)}"` : "";
    let where = "";
    if (e.frame && shot) {
      const a = frameToImage(shot, e.frame.x, e.frame.y);
      const b = frameToImage(shot, e.frame.x + e.frame.width, e.frame.y + e.frame.height);
      if (inImage(shot, (a.x + b.x) / 2, (a.y + b.y) / 2)) where = ` @(${Math.round((a.x + b.x) / 2)}, ${Math.round((a.y + b.y) / 2)})`;
    }
    return `${indent}[${e.token}] ${e.role}${label}${value}${where}`;
  });
  const more = elements.length > 400 ? `\n… ${elements.length - 400} more — pass a query to narrow it down.` : "";
  return text(
    `Elements of ${computerTargetLabel(rc.target)} — use a token as element in computer actions${shot ? "; @(x, y) is the element's center in your latest screenshot" : ""}. Tokens expire when you call computer_ui again.${note ? `\n${note}` : ""}\n${lines.join("\n")}${more}`,
  );
}

async function info(rc: RunComputer): Promise<ComputerToolResult> {
  const views = await rc.engine.views();
  const lines = [`Shared with you: ${describeTarget(rc.target)}.`];
  if (rc.target.kind === "desktop" || rc.target.kind === "display") {
    lines.push("Displays (screen points, top-left origin):");
    for (const v of views) {
      const f = v.frame;
      lines.push(`- display ${v.displayId}: ${v.label}, ${Math.round(f.width)}×${Math.round(f.height)} at (${Math.round(f.x)}, ${Math.round(f.y)})${v.primary ? ", primary" : ""}${rc.view === v.view ? " ← your latest screenshot" : ""}`);
    }
  } else {
    const f = views[0]!.frame;
    lines.push(`${views[0]!.label}: ${Math.round(f.width)}×${Math.round(f.height)}.`);
  }
  const shot = rc.view ? rc.shots.get(rc.view) : undefined;
  if (shot) lines.push(`Your latest screenshot is ${shot.width}×${shot.height} px.`);
  return text(lines.join("\n"));
}

async function windowsTool(rc: RunComputer, focus?: number): Promise<ComputerToolResult> {
  if (!rc.engine.windows || !rc.engine.focusWindow) return text("Listing windows isn't available here.", true);
  if (focus !== undefined) {
    const w = (await rc.engine.windows()).find((x) => x.id === focus);
    if (w && isGodmodeWindow(w)) return text("Godmode's own window is off limits.", true);
    return text(`${(await rc.engine.focusWindow(focus)).detail}.`);
  }
  const views = await rc.engine.views();
  const list = (await rc.engine.windows()).filter((w) => !isGodmodeWindow(w));
  const onDisplay = (w: { frame: { x: number; y: number; width: number; height: number } }) => {
    const cx = w.frame.x + w.frame.width / 2;
    const cy = w.frame.y + w.frame.height / 2;
    return views.find((v) => cx >= v.frame.x && cy >= v.frame.y && cx < v.frame.x + v.frame.width && cy < v.frame.y + v.frame.height);
  };
  const shown = rc.target.kind === "display" ? list.filter((w) => !!onDisplay(w)) : list;
  if (!shown.length) return text("No windows are open.");
  return text(
    [
      "Open windows (pass focus:<id> to bring one to the front):",
      ...shown.slice(0, 80).map((w) => {
        const d = onDisplay(w);
        return `- ${w.id}: ${w.app}${w.title ? ` — ${w.title.slice(0, 80)}` : ""}${w.frontmost ? " (frontmost app)" : ""}${!w.onScreen ? " (hidden/minimized)" : d ? ` on display ${d.displayId}` : ""}`;
      }),
    ].join("\n"),
  );
}

/* ------------------------------------------------------------------ */
/* Registry                                                             */
/* ------------------------------------------------------------------ */

interface ToolSpec {
  name: string;
  description: string;
  schema: z.ZodType;
  run: (rc: RunComputer, args: never) => Promise<ComputerToolResult>;
}

function toolsFor(rc: RunComputer): ToolSpec[] {
  const s = getSettings().computer;
  const kind = rc.target.kind;
  const allowForeground = kind === "window" && s.allowForeground;
  const tools: ToolSpec[] = [
    {
      name: "computer",
      description: toolDescription(rc.target, allowForeground),
      schema: computerSchema(kind, allowForeground),
      run: (r, args: ComputerArgs) => computerAction(r, args),
    },
    {
      name: "computer_info",
      description: "What is shared with you: the window, tab or displays (ids, sizes, arrangement) and your latest screenshot size.",
      schema: z.object({}),
      run: (r) => info(r),
    },
  ];
  if (kind === "window") {
    tools.push({
      name: "computer_ui",
      description:
        "Accessibility elements of the shared window (buttons, fields, menus, links…) with tokens for computer actions ({action:\"left_click\", element} / {action:\"type\", element, text}). Clicking by element works in the background even when the window is covered. Pass query to filter by role, label or value.",
      schema: z.object({ query: z.string().max(200).optional().describe('Filter, e.g. "Save" or "AXTextField"') }),
      run: (r, args: { query?: string }) => uiElements(r, args.query),
    });
  }
  if (kind === "desktop" || kind === "display") {
    tools.push(
      {
        name: "computer_windows",
        description: "List the open windows (app, title, display) or bring one to the front with focus:<id>.",
        schema: z.object({ focus: z.number().int().optional().describe("Window id to bring to the front") }),
        run: (r, args: { focus?: number }) => windowsTool(r, args.focus),
      },
      {
        name: "computer_open_app",
        description: "Open (or switch to) an app by name, e.g. \"Safari\", \"Notes\", \"Calculator\".",
        schema: z.object({ name: z.string().min(1).max(200) }),
        run: async (r, args: { name: string }) => {
          if (isGodmodeAppName(args.name)) return text("Godmode's own app is off limits.", true);
          if (!r.engine.openApp) return text("Opening apps isn't available here.", true);
          const out = await r.engine.openApp(args.name);
          await sleep(800);
          const view = await resolveView(r);
          return afterAction(r, view, "left_click", out.detail, true);
        },
      },
    );
  }
  return tools;
}

const schemaCache = new Map<string, Record<string, unknown>>();

function jsonSchema(key: string, schema: z.ZodType): Record<string, unknown> {
  let s = schemaCache.get(key);
  if (!s) {
    s = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    delete s.$schema;
    schemaCache.set(key, s);
  }
  return s;
}

export const COMPUTER_INSTRUCTIONS =
  "Computer use: see and control what the human shared with you (a window, a browser tab, a display or the whole desktop). " +
  "Take a screenshot first; coordinates are pixels of your latest screenshot.";

export function listComputerTools(ctx: RunContext): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  const rc = runComputer(ctx.runId);
  if (!rc) return [];
  const allowForeground = rc.target.kind === "window" && getSettings().computer.allowForeground;
  return toolsFor(rc).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: jsonSchema(`${t.name}:${rc.target.kind}:${allowForeground}`, t.schema),
  }));
}

export class UnknownComputerToolError extends Error {}

const audited = new Set<string>();

export async function callComputerTool(ctx: RunContext, name: string, args: unknown): Promise<ComputerToolResult> {
  const rc = runComputer(ctx.runId);
  if (!rc) return text("Nothing is shared with you in this run. Ask the human to share a window, tab or screen in the chat.", true);
  const tool = toolsFor(rc).find((t) => t.name === name);
  if (!tool) throw new UnknownComputerToolError(`Unknown tool: ${name}`);
  if (!getSettings().computer.enabled) return text("Computer use was turned off by the human.", true);
  // One call at a time per run: actions depend on the previous screenshot.
  const run = rc.queue.then(async () => {
    try {
      assertActive(rc);
      const parsed = tool.schema.parse(args ?? {});
      if (!audited.has(rc.runId)) {
        audited.add(rc.runId);
        setTimeout(() => audited.delete(rc.runId), 6 * 3600_000).unref?.();
        audit(`agent:${rc.agentId}`, "computer.control", computerTargetLabel(rc.target), { runId: rc.runId, kind: rc.target.kind });
      }
      return await tool.run(rc, parsed as never);
    } catch (err) {
      if (err instanceof z.ZodError) return text(`Invalid arguments: ${err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`, true);
      if (err instanceof KeyError) return text(err.message, true);
      if (err instanceof RevokedError) return text(err.message, true);
      if (err instanceof EngineError) return text(err.message, true);
      log.warn(`computer tool ${name} failed`, err);
      return text(`The action failed: ${errorMessage(err)}`, true);
    }
  });
  rc.queue = run.catch(() => undefined);
  return run;
}
