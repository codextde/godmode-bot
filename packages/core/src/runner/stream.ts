/**
 * Pure parser for Claude Code `--output-format stream-json` events.
 *
 * One StreamAccumulator builds the MessageBlock[] of ONE assistant UI message spanning a whole run
 * (every API turn of the run appends blocks). It understands:
 *  - partial deltas (`stream_event` with --include-partial-messages)
 *  - full `assistant` messages (the CLI emits one per content block, repeating the message id; older
 *    versions repeat the cumulative content) — reconciled against what the deltas already produced
 *  - `user` tool results (matched to their tool_use block)
 *  - the final `result`
 * Subagent output (events with `parent_tool_use_id`) is kept but flagged with `parentToolUseId`.
 * Slash commands that Claude Code runs locally (`/context`, `/model sonnet`…) become `command` blocks;
 * `/clear` and `/compact` become notices.
 */
import type { MessageBlock, QueuedMessage, RunUsage } from "@godmode/shared";

/** Longest tool result text kept per tool_use block (UI + DB). */
export const MAX_TOOL_RESULT_CHARS = 20_000;
/** Largest base64 image kept on a tool_use block (~1.5 MB decoded). */
export const MAX_TOOL_IMAGE_BASE64 = 2_000_000;

export interface StreamFinal {
  text: string;
  isError: boolean;
  /** "success" | "error_max_turns" | "error_during_execution" | "error_max_budget_usd" | … */
  subtype: string | null;
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  usage: RunUsage | null;
  sessionId: string | null;
  /** Error strings reported by the CLI (e.g. "No conversation found with session ID: …"). */
  errors: string[];
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

export class StreamAccumulator {
  readonly blocks: MessageBlock[] = [];
  sessionId: string | null = null;
  model: string | null = null;
  final: StreamFinal | null = null;
  /** Raw names of every tool the run called (including subagents). */
  readonly toolsCalled = new Set<string>();
  /** Set when the CLI reports a rejected rate limit (the CLI waits and retries by itself). */
  rateLimited = false;
  /** A slash command Claude Code handled locally, without a model turn (e.g. `/model sonnet`). */
  localCommand: { name: string; args: string; output: string } | null = null;
  /** `/clear` replaced the Claude session with an empty one. */
  contextCleared = false;
  /** The session was compacted: earlier turns are only a summary now. */
  compacted = false;
  private compacting = false;

  private streams = new Map<string, StreamState>();
  private messages = new Map<string, BlockRef[]>();
  private pendingTextDelta = "";

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
        const limited = info?.status === "rejected";
        const changed = limited !== this.rateLimited;
        this.rateLimited = limited;
        return changed;
      }
      default:
        return false;
    }
  }

  /** Text appended to top-level (non-subagent) text blocks since the last call. */
  takeTextDelta(): string {
    const d = this.pendingTextDelta;
    this.pendingTextDelta = "";
    return d;
  }

  /** Short human label for what the run is doing right now. */
  activityLabel(): string {
    if (this.final) return this.final.isError ? "Failed" : "Done";
    if (this.rateLimited) return "Waiting for rate limit…";
    if (this.compacting) return "Compacting conversation…";
    const last = this.blocks[this.blocks.length - 1];
    if (!last) return "Starting…";
    switch (last.type) {
      case "tool_use":
        return last.result === undefined ? `Using ${displayToolName(last.name)}` : "Thinking…";
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
    }
    return false;
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
    if (str(msg.model)) this.model = str(msg.model);
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
    this.final = {
      text: resultText ?? this.lastTurnText(),
      isError: e.is_error === true || (subtype !== null && subtype !== "success"),
      subtype,
      costUsd: num(e.total_cost_usd),
      durationMs: num(e.duration_ms),
      numTurns: num(e.num_turns),
      usage: mapUsage(e.usage),
      sessionId: this.sessionId,
      errors,
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
  private lastTurnText(): string {
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

/** Copy of `blocks` with every string (text, tool input, results) passed through `redact`. */
export function redactBlocks(blocks: MessageBlock[], redact: (s: string) => string): MessageBlock[] {
  return blocks.map((b) => {
    switch (b.type) {
      case "tool_use":
        return {
          ...b,
          input: redactDeep(b.input, redact),
          ...(b.result !== undefined ? { result: redact(b.result) } : {}),
        };
      case "text":
      case "thinking":
      case "error":
      case "notice":
      case "user_message":
        return { ...b, text: redact(b.text) };
      case "command":
        return { ...b, args: redact(b.args), output: redact(b.output) };
      default:
        return b;
    }
  });
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
