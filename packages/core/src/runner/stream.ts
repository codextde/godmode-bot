import { toolActivity, type ActivityNames } from "@godmode/shared";
/**
 * Pure parser for Claude Code `--output-format stream-json` events.
 *
 * One StreamAccumulator builds the MessageBlock[] of ONE assistant UI message spanning a whole run
 * (every API turn of the run appends blocks). It understands:
 *  - partial deltas (`stream_event` with --include-partial-messages)
 *  - full `assistant` messages (the CLI emits one per content block, repeating the message id; older
 *    versions repeat the cumulative content) — reconciled against what the deltas already produced
 *  - `user` tool results (matched to their tool_use block)
 *  - background work a tool call started (`task_started`, `task_progress`, … — a workflow), kept on its tool_use block
 *  - the final `result` (one per turn: a workflow that ends later starts another turn in the same process)
 * Subagent output (events with `parent_tool_use_id`) is kept but flagged with `parentToolUseId`.
 * Slash commands that Claude Code runs locally (`/context`, `/model sonnet`…) become `command` blocks;
 * `/clear` and `/compact` become notices, and so does what a mod posts (`ui_log`, `ui_toast`, `ui_status`).
 */
import type { MessageBlock, QueuedMessage, RunUsage, ToolTask, ToolTaskAgent } from "@godmode/shared";

/** Longest tool result text kept per tool_use block (UI + DB). */
export const MAX_TOOL_RESULT_CHARS = 20_000;
/** Largest base64 image kept on a tool_use block (~1.5 MB decoded). */
export const MAX_TOOL_IMAGE_BASE64 = 2_000_000;
/** Notes one stretch of a run keeps from its mods, and how long one may be: a mod can log in a loop. */
export const MAX_MOD_NOTES = 200;
const MAX_MOD_NOTE_CHARS = 2000;
const MOD_FAILURE = /^hooks module did not load: |^[\w.]+ hook skipped: /;

export interface StreamFinal {
  text: string;
  isError: boolean;
  /** "success" | "error_max_turns" | "error_during_execution" | "error_max_budget_usd" | … */
  subtype: string | null;
  /** Claude Code's total for the whole Claude session: on a resumed session the runs before this one are in it. */
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  usage: RunUsage | null;
  sessionId: string | null;
  /** Error strings reported by the CLI (e.g. "No conversation found with session ID: …"). */
  errors: string[];
  /** HTTP status of the API error that ended the run (429 when a limit was reached). */
  apiErrorStatus: number | null;
}

type ToolUseBlock = Extract<MessageBlock, { type: "tool_use" }>;
type TextLikeBlock = Extract<MessageBlock, { type: "text" | "thinking" }>;
type TrackedType = "text" | "thinking" | "tool_use";

interface BlockRef {
  blockIdx: number;
  type: TrackedType;
  /** Content confirmed by a full `assistant` event. */
  confirmed: boolean;
}

interface StreamState {
  messageId: string | null;
  /** stream content block index → index in `blocks` */
  indexMap: Map<number, number>;
  /** stream content block index → accumulated input_json_delta */
  jsonBuf: Map<number, string>;
}

type Json = Record<string, unknown>;

/** A usage limit Claude reported as reached (`rate_limit_event`). */
export interface StreamLimit {
  /** Claude's key for the limit window: "five_hour", "seven_day", … */
  type: string | null;
  /** Unix seconds; null when Claude didn't say. */
  resetsAt: number | null;
}

/** What Claude Code answers when a usage limit ends the run: "You've hit your session limit · resets 3pm". */
export const LIMIT_TEXT = /you['’]ve hit your [^\n]{0,80}|\busage limit reached\b/i;

const TOOL_USE_TYPES = new Set(["tool_use", "server_tool_use", "mcp_tool_use"]);

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function kTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** "mcp__browser__browser_navigate" → "browser_navigate" */
export function displayToolName(name: string): string {
  const m = /^mcp__.+?__(.+)$/.exec(name);
  return m ? m[1]! : name;
}

function truncateResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n… (truncated, ${text.length - MAX_TOOL_RESULT_CHARS} more characters)`;
}

/** Normalize tool_result content (string | content block array) into text + first image. */
export function toolResultContent(content: unknown): { text: string; image?: string } {
  if (typeof content === "string") return { text: content };
  if (!Array.isArray(content)) return { text: content == null ? "" : JSON.stringify(content) };
  const parts: string[] = [];
  let image: string | undefined;
  for (const item of content) {
    if (!isObj(item)) continue;
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if (item.type === "image") {
      const source = isObj(item.source) ? item.source : null;
      const data = source && source.type === "base64" ? str(source.data) : null;
      if (data && !image) {
        if (data.length <= MAX_TOOL_IMAGE_BASE64) image = data;
        else parts.push("[image omitted: too large]");
      }
    } else parts.push(JSON.stringify(item));
  }
  return { text: parts.join("\n"), ...(image ? { image } : {}) };
}

export function mapUsage(u: unknown): RunUsage | null {
  if (!isObj(u)) return null;
  return {
    inputTokens: num(u.input_tokens) ?? 0,
    outputTokens: num(u.output_tokens) ?? 0,
    cacheReadTokens: num(u.cache_read_input_tokens) ?? 0,
    cacheWriteTokens: num(u.cache_creation_input_tokens) ?? 0,
  };
}

function plus(a: number | null | undefined, b: number | null): number | null {
  return a == null ? b : a + (b ?? 0);
}

/** How a task ended, from Claude Code's status for it; null while that ends nothing ("pending", "running", "paused"). */
function taskEnd(status: unknown): ToolTask["status"] | null {
  if (status === "completed" || status === "failed") return status;
  return typeof status !== "string" || status === "pending" || status === "running" || status === "paused" ? null : "stopped";
}

/** The agents of a workflow as its `workflow_progress` lists them; null when the event carries no list. */
function workflowAgents(progress: unknown): ToolTaskAgent[] | null {
  if (!Array.isArray(progress)) return null;
  const agents: ToolTaskAgent[] = [];
  for (const p of progress) {
    if (!isObj(p) || p.type !== "workflow_agent") continue;
    const lastTool = str(p.lastToolName);
    const tokens = num(p.tokens);
    agents.push({
      label: str(p.label) ?? "",
      phase: str(p.phaseTitle) ?? "",
      state: p.state === "done" ? "done" : p.state === "error" || p.state === "failed" ? "failed" : p.startedAt == null ? "queued" : "running",
      ...(lastTool ? { lastTool } : {}),
      ...(tokens !== null ? { tokens } : {}),
    });
  }
  return agents;
}

export function addUsage(a: RunUsage | null, b: RunUsage | null): RunUsage | null {
  if (!a || !b) return a ?? b;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export class StreamAccumulator {
  readonly blocks: MessageBlock[];
  sessionId: string | null = null;
  model: string | null = null;
  final: StreamFinal | null = null;
  /** `result` events seen: one per turn of the process. */
  results = 0;
  /** Raw names of every tool the run called (including subagents). */
  readonly toolsCalled = new Set<string>();
  /** The usage limit Claude last reported as reached; null while requests go through. */
  limit: StreamLimit | null = null;
  /** Claude Code's own line saying a usage limit ended the run. */
  limitLine: string | null = null;
  /** The model answered: the prompt of this stretch of the run is in the Claude session. */
  answered = false;
  /** A slash command Claude Code handled locally, without a model turn (e.g. `/model sonnet`). */
  localCommand: { name: string; args: string; output: string } | null = null;
  /** `/clear` replaced the Claude session with an empty one. */
  contextCleared = false;
  /** The session was compacted: earlier turns are only a summary now. */
  compacted = false;
  private compacting = false;

  private streams = new Map<string, StreamState>();
  private messages = new Map<string, BlockRef[]>();
  /** Background work this stretch of the run started, by Claude Code's task id (the same objects as on the blocks). */
  private tasks = new Map<string, ToolTask>();
  private modStatus = new Map<string, string>();
  private modNotes = 0;
  private pendingTextDelta = "";

  /** `blocks`: what the run already produced before it was paused. */
  constructor(blocks: MessageBlock[] = []) {
    this.blocks = blocks;
    for (const b of blocks) if (b.type === "tool_use") this.toolsCalled.add(b.name);
  }

  /** Consume one parsed stream-json event. Returns true when the visible blocks changed. */
  push(event: unknown): boolean {
    if (!isObj(event)) return false;
    switch (event.type) {
      case "system":
        return this.onSystem(event);
      case "stream_event":
        return this.onStreamEvent(event);
      case "assistant":
        return this.onAssistant(event);
      case "user":
        return this.onUser(event);
      case "result":
        this.onResult(event);
        return true;
      case "conversation_reset":
        this.contextCleared = true;
        this.addNotice("info", "Context cleared — your next message starts a fresh session.");
        return true;
      case "rate_limit_event": {
        const info = isObj(event.rate_limit_info) ? event.rate_limit_info : null;
        const was = this.limit !== null;
        // While usage credits pay for the requests, the limit of the plan stops nothing.
        this.limit = info?.status === "rejected" && info.isUsingOverage !== true ? { type: str(info.rateLimitType), resetsAt: num(info.resetsAt) } : null;
        return was !== (this.limit !== null);
      }
      default:
        return false;
    }
  }

  /** Claude Code is compacting the conversation (it writes nothing meanwhile). */
  get isCompacting(): boolean {
    return this.compacting;
  }

  /** Text appended to top-level (non-subagent) text blocks since the last call. */
  takeTextDelta(): string {
    const d = this.pendingTextDelta;
    this.pendingTextDelta = "";
    return d;
  }

  /** Short human label for what the run is doing right now. */
  /** What the run is doing right now, in plain words (`names` resolves agent and login ids, and masks secrets). */
  activityLabel(names?: ActivityNames): string {
    if (this.final) return this.final.isError ? "Failed" : "Done";
    if (this.limit) return "Waiting for rate limit…";
    if (this.compacting) return "Compacting conversation…";
    const last = this.blocks[this.blocks.length - 1];
    if (!last) return "Starting…";
    const background = this.backgroundWork();
    if (background) return background;
    switch (last.type) {
      case "tool_use":
        return last.result === undefined ? toolActivity(last.name, last.input, names) : "Thinking…";
      case "thinking":
        return "Thinking…";
      case "text":
        return "Writing…";
      default:
        return "Working…";
    }
  }

  /** Final answer text: the result text, else the top-level text of the last assistant turn. */
  finalText(): string {
    if (this.final?.text) return this.final.text;
    return this.lastTurnText();
  }

  /** Append a Godmode-generated notice (e.g. "browser tools unavailable"). */
  addNotice(level: "info" | "warning" | "success", text: string) {
    this.blocks.push({ type: "notice", level, text });
  }

  /** A message from the chat's queue joins the turn at this point. */
  addUserMessage(message: QueuedMessage) {
    this.blocks.push({ type: "user_message", id: message.id, text: message.content, attachments: message.attachments, sentAt: message.createdAt });
  }

  addError(text: string) {
    this.blocks.push({ type: "error", text });
  }

  /**
   * The run stands still from here. What the Claude session doesn't hold goes: text and tool calls the model was still
   * writing (it writes them again when the run continues), and Claude Code's own line about the limit.
   */
  markPause(pause: Extract<MessageBlock, { type: "pause" }>) {
    const partial = new Set<number>();
    for (const refs of this.messages.values()) for (const r of refs) if (!r.confirmed) partial.add(r.blockIdx);
    for (let i = this.blocks.length - 1; i >= 0; i--) if (partial.has(i)) this.blocks.splice(i, 1);
    // A mod may have posted after Claude Code's line about the limit (a recap at the turn's end).
    let at = this.blocks.length - 1;
    while (at >= 0 && this.blocks[at]!.type === "notice" && (this.blocks[at] as Extract<MessageBlock, { type: "notice" }>).mod) at--;
    const last = this.blocks[at];
    if (pause.reason === "limit" && last?.type === "text" && !last.parentToolUseId && last.text.length < 300 && LIMIT_TEXT.test(last.text)) this.blocks.splice(at, 1);
    this.messages.clear();
    this.streams.clear();
    // Background work ends with the process; the run that continues streams these blocks again.
    for (const b of this.blocks) if (b.type === "tool_use" && b.task?.status === "running") b.task.status = "stopped";
    this.blocks.push(pause);
  }

  /* ---------------------------------------------------------------- */

  private onSystem(e: Json): boolean {
    if (e.subtype === "init") {
      this.sessionId = str(e.session_id) ?? this.sessionId;
      this.model = str(e.model) ?? this.model;
    } else if (e.subtype === "status") {
      this.compacting = e.status === "compacting";
    } else if (e.subtype === "compact_boundary") {
      this.compacted = true;
      const meta = isObj(e.compact_metadata) ? e.compact_metadata : {};
      const pre = num(meta.pre_tokens);
      const post = num(meta.post_tokens);
      this.addNotice("success", `Conversation compacted${pre !== null && post !== null ? ` · ${kTokens(pre)} → ${kTokens(post)} tokens` : ""}`);
      return true;
    } else if (e.subtype === "task_started" || e.subtype === "task_progress" || e.subtype === "task_updated" || e.subtype === "task_notification") {
      return this.onTask(e);
    } else if (e.subtype === "ui_log" || e.subtype === "ui_toast" || e.subtype === "ui_status") {
      return this.onModNote(e);
    }
    return false;
  }

  /**
   * What a mod shows the person (`$.ui.log`, `$.ui.toast`, `$.ui.status`) becomes a note from that mod. A status is
   * repeated by the engine as long as it stands: only a new one is a note.
   */
  private onModNote(e: Json): boolean {
    const mod = str(e.plugin);
    const text = str(e.text)?.trim();
    if (!mod) return false;
    if (e.subtype === "ui_status") {
      if (!text) this.modStatus.delete(mod);
      if (!text || this.modStatus.get(mod) === text) return false;
      this.modStatus.set(mod, text);
    }
    if (!text || this.modNotes > MAX_MOD_NOTES) return false;
    this.modNotes++;
    if (this.modNotes > MAX_MOD_NOTES) this.addNotice("info", "More notes from mods aren't shown in this turn.");
    else {
      // The engine's own lines about a mod: its module didn't load, or one of its hooks threw and was skipped.
      const level = e.subtype === "ui_log" && MOD_FAILURE.test(text) ? "warning" : "info";
      this.blocks.push({ type: "notice", level, text: text.length > MAX_MOD_NOTE_CHARS ? `${text.slice(0, MAX_MOD_NOTE_CHARS)}…` : text, mod });
    }
    return true;
  }

  /** Background work of a tool call: started, then progress (for a workflow with its agents), then how it ended. */
  private onTask(e: Json): boolean {
    const id = str(e.task_id);
    if (!id) return false;
    if (e.subtype === "task_started") {
      // A subagent resumed with SendMessage starts again under its id: its own card shows it, not the SendMessage call.
      const resumed = this.tasks.get(id);
      const idx = resumed ? this.blocks.findIndex((b) => b.type === "tool_use" && b.task === resumed) : this.findToolUse(str(e.tool_use_id) ?? "");
      if (idx < 0) return false;
      const task: ToolTask = {
        id,
        kind: str(e.task_type) ?? "task",
        status: "running",
        description: str(e.description) ?? "",
        activity: "",
        totalTokens: 0,
        toolUses: 0,
        durationMs: 0,
        agents: [],
        startedAt: Date.now(),
        ...(e.is_backgrounded === true ? { background: true } : {}),
      };
      (this.blocks[idx] as ToolUseBlock).task = task;
      this.tasks.set(id, task);
      return true;
    }
    const task = this.tasks.get(id);
    if (!task) return false;
    const before = JSON.stringify(task);
    if (e.subtype === "task_progress") {
      task.activity = str(e.description) ?? task.activity;
      // Not every progress event lists the agents.
      task.agents = workflowAgents(e.workflow_progress) ?? task.agents;
      const lastTool = str(e.last_tool_name);
      if (lastTool && task.kind === "local_agent") task.lastTool = lastTool;
    } else {
      const patch = isObj(e.patch) ? e.patch : null;
      if (patch?.is_backgrounded === true && task.kind === "local_agent") task.background = true;
      task.status = taskEnd(e.subtype === "task_updated" ? patch?.status : e.status) ?? task.status;
      const summary = str(e.summary);
      if (e.subtype === "task_notification" && task.kind === "local_agent" && summary) task.summary = truncateResult(summary);
    }
    const usage = isObj(e.usage) ? e.usage : {};
    task.totalTokens = num(usage.total_tokens) ?? task.totalTokens;
    task.toolUses = num(usage.tool_uses) ?? task.toolUses;
    task.durationMs = num(usage.duration_ms) ?? task.durationMs;
    return JSON.stringify(task) !== before;
  }

  /** What runs in the background (a workflow, subagents) while no top-level tool call waits for its result. */
  private backgroundWork(): string | null {
    let workflow: ToolTask | null = null;
    const agents: ToolTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.status !== "running") continue;
      if (task.kind === "local_workflow") workflow = task;
      else if (task.kind === "local_agent" && task.background) agents.push(task);
    }
    if (!workflow && agents.length === 0) return null;
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i]!;
      // Steps an earlier stretch of the run left cut off don't count.
      if (b.type === "pause") break;
      if (b.type === "tool_use" && !b.parentToolUseId && b.result === undefined) return null;
    }
    if (workflow) return `Running workflow · ${workflow.activity || workflow.description}`;
    return agents.length === 1 ? `Subagent working · ${agents[0]!.description}` : `${agents.length} subagents working`;
  }

  private stream(parent: string | null): StreamState {
    const key = parent ?? "";
    let s = this.streams.get(key);
    if (!s) {
      s = { messageId: null, indexMap: new Map(), jsonBuf: new Map() };
      this.streams.set(key, s);
    }
    return s;
  }

  private refs(messageId: string): BlockRef[] {
    let r = this.messages.get(messageId);
    if (!r) {
      r = [];
      this.messages.set(messageId, r);
    }
    return r;
  }

  private addBlock(block: MessageBlock, messageId: string | null, confirmed: boolean): number {
    this.blocks.push(block);
    const idx = this.blocks.length - 1;
    if (messageId && (block.type === "text" || block.type === "thinking" || block.type === "tool_use")) {
      this.refs(messageId).push({ blockIdx: idx, type: block.type, confirmed });
    }
    if (block.type === "tool_use") this.toolsCalled.add(block.name);
    return idx;
  }

  private onStreamEvent(e: Json): boolean {
    const ev = isObj(e.event) ? e.event : null;
    if (!ev) return false;
    const parent = str(e.parent_tool_use_id);
    const s = this.stream(parent);
    const index = num(ev.index);

    switch (ev.type) {
      case "message_start": {
        const msg = isObj(ev.message) ? ev.message : null;
        this.answered = true;
        s.messageId = str(msg?.id) ?? null;
        s.indexMap.clear();
        s.jsonBuf.clear();
        if (msg && str(msg.model)) this.model = str(msg.model);
        return false;
      }
      case "content_block_start": {
        const cb = isObj(ev.content_block) ? ev.content_block : null;
        if (!cb || index === null) return false;
        let block: MessageBlock | null = null;
        if (cb.type === "text") block = { type: "text", text: str(cb.text) ?? "", ...(parent ? { parentToolUseId: parent } : {}) };
        else if (cb.type === "thinking" || cb.type === "redacted_thinking")
          block = { type: "thinking", text: str(cb.thinking) ?? "", ...(parent ? { parentToolUseId: parent } : {}) };
        else if (TOOL_USE_TYPES.has(String(cb.type))) {
          block = {
            type: "tool_use",
            id: str(cb.id) ?? `tool_${this.blocks.length}`,
            name: str(cb.name) ?? "tool",
            input: isObj(cb.input) ? cb.input : {},
            parentToolUseId: parent,
          };
          s.jsonBuf.set(index, "");
        }
        if (!block) return false;
        if (!parent && block.type === "text" && block.text) this.pendingTextDelta += block.text;
        s.indexMap.set(index, this.addBlock(block, s.messageId, false));
        return true;
      }
      case "content_block_delta": {
        if (index === null) return false;
        const blockIdx = s.indexMap.get(index);
        const delta = isObj(ev.delta) ? ev.delta : null;
        if (blockIdx === undefined || !delta) return false;
        const block = this.blocks[blockIdx]!;
        if (delta.type === "text_delta" && block.type === "text") {
          const t = str(delta.text) ?? "";
          if (!t) return false;
          block.text += t;
          if (!parent) this.pendingTextDelta += t;
          return true;
        }
        if (delta.type === "thinking_delta" && block.type === "thinking") {
          const t = str(delta.thinking) ?? "";
          if (!t) return false;
          block.text += t;
          return true;
        }
        if (delta.type === "input_json_delta" && block.type === "tool_use") {
          s.jsonBuf.set(index, (s.jsonBuf.get(index) ?? "") + (str(delta.partial_json) ?? ""));
          return false;
        }
        return false;
      }
      case "content_block_stop": {
        if (index === null) return false;
        const blockIdx = s.indexMap.get(index);
        const buf = s.jsonBuf.get(index);
        s.jsonBuf.delete(index);
        if (blockIdx === undefined || buf === undefined || buf.trim() === "") return false;
        const block = this.blocks[blockIdx]!;
        if (block.type !== "tool_use") return false;
        try {
          block.input = JSON.parse(buf);
        } catch {
          block.input = { _raw: buf };
        }
        return true;
      }
      default:
        return false;
    }
  }

  private onAssistant(e: Json): boolean {
    const msg = isObj(e.message) ? e.message : null;
    if (!msg || !Array.isArray(msg.content)) return false;
    const parent = str(e.parent_tool_use_id);
    const messageId = str(msg.id);
    const local = isObj(e.local_command_run) ? e.local_command_run : null;
    if (local) {
      const output = msg.content
        .map((c) => (isObj(c) && c.type === "text" ? (str(c.text) ?? "") : ""))
        .join("\n")
        .trim();
      this.localCommand = { name: str(local.command) ?? "", args: str(local.args) ?? "", output };
      this.blocks.push({ type: "command", ...this.localCommand });
      return true;
    }
    // Claude Code's own lines (an API error, a reached limit) come as messages of a "<synthetic>" model.
    const synthetic = str(msg.model) === "<synthetic>";
    if (!synthetic) this.answered = true;
    else {
      const line = msg.content.map((c) => (isObj(c) && c.type === "text" ? (str(c.text) ?? "") : "")).join("\n");
      if (LIMIT_TEXT.test(line)) this.limitLine = line.trim();
    }
    if (str(msg.model) && !synthetic) this.model = str(msg.model);
    let changed = false;

    for (const c of msg.content) {
      if (!isObj(c)) continue;
      if (TOOL_USE_TYPES.has(String(c.type))) {
        const id = str(c.id);
        const existingIdx = id ? this.findToolUse(id) : -1;
        if (existingIdx >= 0) {
          const block = this.blocks[existingIdx] as ToolUseBlock;
          block.name = str(c.name) ?? block.name;
          if (c.input !== undefined) block.input = c.input;
          const ref = messageId ? this.refs(messageId).find((r) => r.blockIdx === existingIdx) : undefined;
          if (ref) ref.confirmed = true;
        } else {
          this.addBlock(
            {
              type: "tool_use",
              id: id ?? `tool_${this.blocks.length}`,
              name: str(c.name) ?? "tool",
              input: c.input ?? {},
              parentToolUseId: parent,
            },
            messageId,
            true,
          );
        }
        changed = true;
        continue;
      }

      const type: "text" | "thinking" | null =
        c.type === "text" ? "text" : c.type === "thinking" || c.type === "redacted_thinking" ? "thinking" : null;
      if (!type) continue;
      const text = (type === "text" ? str(c.text) : str(c.thinking)) ?? "";
      const refs = messageId ? this.refs(messageId) : [];
      const open = refs.find((r) => r.type === type && !r.confirmed);
      if (open) {
        const block = this.blocks[open.blockIdx] as TextLikeBlock;
        // The full event is authoritative, unless it carries less than the deltas did (redacted thinking display).
        if (text && text !== block.text && text.length >= block.text.length) {
          if (type === "text" && !parent && text.startsWith(block.text)) this.pendingTextDelta += text.slice(block.text.length);
          block.text = text;
          changed = true;
        }
        open.confirmed = true;
        continue;
      }
      // Older CLIs repeat the cumulative content of the message: skip blocks we already confirmed.
      const duplicate = refs.some(
        (r) => r.type === type && r.confirmed && (this.blocks[r.blockIdx] as TextLikeBlock).text === text,
      );
      if (duplicate) continue;
      this.addBlock({ type, text, ...(parent ? { parentToolUseId: parent } : {}) }, messageId, true);
      if (type === "text" && !parent) this.pendingTextDelta += text;
      changed = true;
    }
    return changed;
  }

  private onUser(e: Json): boolean {
    const msg = isObj(e.message) ? e.message : null;
    if (!msg || !Array.isArray(msg.content)) return false;
    let changed = false;
    for (const c of msg.content) {
      if (!isObj(c) || c.type !== "tool_result") continue;
      const id = str(c.tool_use_id);
      if (!id) continue;
      const idx = this.findToolUse(id);
      if (idx < 0) continue;
      const block = this.blocks[idx] as ToolUseBlock;
      const { text, image } = toolResultContent(c.content);
      block.result = truncateResult(text);
      block.isError = c.is_error === true;
      if (image) block.image = image;
      changed = true;
    }
    return changed;
  }

  private onResult(e: Json): void {
    const subtype = str(e.subtype);
    const errors = Array.isArray(e.errors) ? e.errors.filter((x): x is string => typeof x === "string") : [];
    const resultText = str(e.result);
    this.sessionId = str(e.session_id) ?? this.sessionId;
    // Claude Code can end more than once in one process: a workflow or a background task that outlives its turn starts
    // another turn, with a result of its own. Time, turns and tokens are per result, so they add up; the cost is the
    // session's so far.
    const prev = this.final;
    this.results++;
    this.final = {
      text: resultText ?? this.lastTurnText(),
      isError: e.is_error === true || (subtype !== null && subtype !== "success"),
      subtype,
      costUsd: num(e.total_cost_usd) ?? prev?.costUsd ?? null,
      durationMs: plus(prev?.durationMs, num(e.duration_ms)),
      numTurns: plus(prev?.numTurns, num(e.num_turns)),
      usage: addUsage(prev?.usage ?? null, mapUsage(e.usage)),
      sessionId: this.sessionId,
      errors,
      apiErrorStatus: num(e.api_error_status),
    };
  }

  private findToolUse(id: string): number {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i]!;
      if (b.type === "tool_use" && b.id === id) return i;
    }
    return -1;
  }

  /** Top-level text blocks after the last top-level tool_use (i.e. the final turn's answer). */
  lastTurnText(): string {
    const parts: string[] = [];
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i]!;
      if (b.type === "tool_use" && !b.parentToolUseId) break;
      if (b.type === "text" && !b.parentToolUseId && b.text.trim()) parts.unshift(b.text);
    }
    return parts.join("\n\n");
  }
}

/* ------------------------------------------------------------------ */
/* Redaction helpers                                                   */
/* ------------------------------------------------------------------ */

function redactDeep(value: unknown, redact: (s: string) => string, depth = 0): unknown {
  if (typeof value === "string") return redact(value);
  if (depth > 20 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact, depth + 1));
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, redact, depth + 1);
  return out;
}

/** The password an agent hands to `vault_save_login` is never kept with the call, whatever masking is set to. */
function withoutSavedPassword(name: string, input: unknown): unknown {
  if (displayToolName(name) !== "vault_save_login" || typeof input !== "object" || input === null || !("password" in input)) return input;
  return { ...input, password: "••••••••" };
}

/** Copy of `block` with every string (text, tool input, results) passed through `redact`. */
export function redactBlock(b: MessageBlock, redact: (s: string) => string): MessageBlock {
  switch (b.type) {
    case "tool_use":
      return {
        ...b,
        input: redactDeep(withoutSavedPassword(b.name, b.input), redact),
        ...(b.result !== undefined ? { result: redact(b.result) } : {}),
        ...(b.task
          ? {
              task: {
                ...b.task,
                description: redact(b.task.description),
                activity: redact(b.task.activity),
                agents: b.task.agents.map((a) => ({ ...a, label: redact(a.label), phase: redact(a.phase) })),
                ...(b.task.summary !== undefined ? { summary: redact(b.task.summary) } : {}),
              },
            }
          : {}),
      };
    case "text":
    case "thinking":
    case "error":
    case "notice":
    case "user_message":
      return { ...b, text: redact(b.text) };
    case "command":
      return { ...b, args: redact(b.args), output: redact(b.output) };
    case "question":
      return {
        ...b,
        title: redact(b.title),
        body: redact(b.body),
        affects: redact(b.affects),
        options: b.options.map((o) => ({ ...o, label: redact(o.label), ...(o.description ? { description: redact(o.description) } : {}) })),
        ...(b.answer ? { answer: { ...b.answer, text: redact(b.answer.text) } } : {}),
        ...(b.closedReason ? { closedReason: redact(b.closedReason) } : {}),
      };
    default:
      return b;
  }
}

export function redactBlocks(blocks: MessageBlock[], redact: (s: string) => string): MessageBlock[] {
  return blocks.map((b) => redactBlock(b, redact));
}

/* ------------------------------------------------------------------ */
/* Missing-login heuristic                                             */
/* ------------------------------------------------------------------ */

const LOGIN_FAILURE_PATTERNS: RegExp[] = [
  // "couldn't log in", "unable to sign in", "failed to authenticate", "was not able to log into"
  /\b(?:couldn['’]?t|could not|can['’]?t|cannot|unable to|failed to|wasn['’]?t able to|was not able to|not able to|weren['’]?t able to)\s+(?:successfully\s+|properly\s+|automatically\s+)?(?:log\s?in|sign\s?in|log\s+into|sign\s+into|authenticate|access\s+(?:my|the|your)\s+account)\b/i,
  // "login failed", "authentication was unsuccessful"
  /\b(?:login|log-in|sign-in|signin|authentication)\s+(?:attempt\s+)?(?:failed|was rejected|was unsuccessful|unsuccessful|did not work|didn['’]?t work)\b/i,
  // "invalid password", "wrong credentials"
  /\b(?:invalid|incorrect|wrong|expired)\s+(?:username or password|username\/password|password|credentials?|login(?: details)?)\b/i,
  // "no saved credentials for", "missing login for", "no account found"
  /\b(?:no|missing)\s+(?:saved\s+|stored\s+|valid\s+|matching\s+)?(?:credentials?|logins?|login details|passwords?|accounts?)\s+(?:for|found|available|saved|stored|exists?|in the vault|on file)\b/i,
  // "I don't have an account for"
  /\b(?:don['’]?t|do not|doesn['’]?t|does not)\s+have\s+(?:an?\s+|the\s+|any\s+)?(?:account|login|credentials?|password)\s+(?:for|on|at|to|with)\b/i,
  // "2FA code required", "verification code is needed but not available"
  /\b(?:2fa|two[- ]factor|mfa|multi[- ]factor|verification code|one[- ]time (?:code|password)|authenticator code|totp)\b.{0,60}?\b(?:required|needed|missing|not available|unavailable|not (?:set up|configured|linked|saved))\b/i,
  /\b(?:no|missing)\s+(?:2fa|totp|mfa|two[- ]factor|authenticator)\b/i,
];

/**
 * If the final answer says a login failed / is missing, return the sentence that says so (≤300 chars).
 * Used when the run did not call report_missing_login itself.
 */
export function detectLoginFailure(text: string): string | null {
  if (!text) return null;
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^[\s>*#\-–•\d.)]+/, "").trim())
    .filter(Boolean);
  for (const sentence of sentences) {
    if (LOGIN_FAILURE_PATTERNS.some((re) => re.test(sentence))) {
      return sentence.length > 300 ? `${sentence.slice(0, 299)}…` : sentence;
    }
  }
  return null;
}
