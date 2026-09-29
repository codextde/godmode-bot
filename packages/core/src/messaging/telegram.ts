/**
 * Telegram bot over the Bot API with long polling (`getUpdates`): no public address needed.
 * https://core.telegram.org/bots/api
 */
import type { MessagingVerifyResult } from "@godmode/shared";
import { logger } from "../log";
import { sleep } from "../util";
import { sleepFor } from "../computer/engine";
import { toPlainText, toTelegramHtml, splitMessage } from "./format";
import {
  fetchWithTimeout,
  MessagingError,
  readLimited,
  type AdapterContext,
  type ChatTarget,
  type InboundFile,
  type MessagingAdapter,
  type Secrets,
} from "./types";

const log = logger("telegram");

const API = "https://api.telegram.org";
/** Bot API downloads are limited to 20 MB. */
export const TELEGRAM_MAX_FILE = 20 * 1024 * 1024;
const MESSAGE_LIMIT = 3800;
const POLL_SECONDS = 30;
const TYPING_EVERY_MS = 4500;
const MAX_BACKOFF_MS = 60_000;
const TELEGRAM_SERVICE_ACCOUNT = 777000;

export const TELEGRAM_COMMANDS = [
  { command: "new", description: "Start a fresh conversation" },
  { command: "agents", description: "Agents you can talk to" },
  { command: "agent", description: "Switch agent: /agent <name>" },
  { command: "stop", description: "Stop the current answer" },
  { command: "help", description: "What this bot can do" },
];

class TelegramApiError extends MessagingError {
  constructor(
    public code: number,
    message: string,
    public retryAfter?: number,
  ) {
    super(message, code === 401 || code === 404);
  }
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TgFileRef {
  file_id: string;
  file_size?: number;
  mime_type?: string;
  file_name?: string;
}

interface TgMessage {
  message_id: number;
  sender_chat?: { id: number };
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: TgUser;
  chat: { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string; first_name?: string; last_name?: string };
  text?: string;
  caption?: string;
  reply_to_message?: { from?: TgUser };
  photo?: (TgFileRef & { width: number; height: number })[];
  document?: TgFileRef;
  voice?: TgFileRef;
  audio?: TgFileRef;
  video?: TgFileRef;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

async function call<T>(token: string, method: string, body: unknown = {}, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  // The token is part of the URL: fetchWithTimeout only ever reports the host.
  const res = await fetchWithTimeout(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  });
  let json: TgResponse<T>;
  try {
    json = (await res.json()) as TgResponse<T>;
  } catch {
    throw new TelegramApiError(res.status, `Telegram answered ${res.status}`);
  }
  if (!json.ok) {
    const code = json.error_code ?? res.status;
    const message =
      code === 401 || code === 404 ? "Telegram doesn't accept this bot token. Copy it again from @BotFather." : (json.description ?? `Telegram answered ${code}`);
    throw new TelegramApiError(code, message, json.parameters?.retry_after);
  }
  return json.result as T;
}

export async function verifyTelegram(secrets: Secrets<"telegram">): Promise<MessagingVerifyResult> {
  const token = secrets.botToken.trim();
  if (!/^\d{5,}:[\w-]{30,}$/.test(token)) throw new MessagingError("That doesn't look like a bot token. It looks like 123456789:AAE…", true);
  const me = await call<TgUser & { can_join_groups?: boolean; can_read_all_group_messages?: boolean }>(token, "getMe");
  const warnings: string[] = [];
  try {
    const hook = await call<{ url: string }>(token, "getWebhookInfo");
    if (hook.url) {
      warnings.push(`This bot delivers its messages to a webhook (${new URL(hook.url).host}). Connecting switches it to Godmode, and that webhook stops receiving messages.`);
    }
  } catch (err) {
    log.debug("getWebhookInfo failed", err);
  }
  return {
    bot: {
      id: String(me.id),
      name: [me.first_name, me.last_name].filter(Boolean).join(" "),
      username: me.username ?? null,
      team: null,
      url: me.username ? `https://t.me/${me.username}` : null,
    },
    warnings,
  };
}

function fullName(u: { first_name?: string; last_name?: string }): string {
  return [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
}

export class TelegramAdapter implements MessagingAdapter {
  private stopped = false;
  private abort = new AbortController();
  private offset: number;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly ctx: AdapterContext,
    private readonly secrets: Secrets<"telegram">,
  ) {
    this.offset = typeof ctx.state.offset === "number" ? ctx.state.offset : 0;
  }

  private get token() {
    return this.secrets.botToken.trim();
  }

  private get username(): string {
    return (this.ctx.bot.username ?? "").toLowerCase();
  }

  start(): void {
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    await this.loop?.catch(() => undefined);
  }

  private async prepare() {
    const hook = await call<{ url: string }>(this.token, "getWebhookInfo");
    if (hook.url) await call(this.token, "deleteWebhook", { drop_pending_updates: false });
    await call(this.token, "setMyCommands", { commands: TELEGRAM_COMMANDS }).catch((err) => log.debug("setMyCommands failed", err));
  }

  private async run() {
    this.ctx.onStatus("connecting");
    let failures = 0;
    let prepared = false;
    while (!this.stopped) {
      try {
        if (!prepared) {
          await this.prepare();
          prepared = true;
          this.ctx.onStatus("connected");
        }
        const updates = await call<TgUpdate[]>(
          this.token,
          "getUpdates",
          { offset: this.offset || undefined, timeout: POLL_SECONDS, allowed_updates: ["message"] },
          { signal: this.abort.signal, timeoutMs: (POLL_SECONDS + 15) * 1000 },
        );
        failures = 0;
        this.ctx.onStatus("connected");
        for (const update of updates) {
          this.offset = update.update_id + 1;
          if (update.message) this.handle(update.message);
        }
        if (updates.length) this.ctx.saveState({ offset: this.offset });
      } catch (err) {
        if (this.stopped) break;
        failures++;
        if (err instanceof TelegramApiError && err.fatal) {
          this.ctx.onStatus("error", err.message);
          return;
        }
        let wait = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures, 6));
        if (err instanceof TelegramApiError && err.code === 409) {
          prepared = false;
          wait = 30_000;
          this.ctx.onStatus("error", "Another program is receiving this bot's messages (a webhook or a second Godmode). Retrying…");
        } else if (err instanceof TelegramApiError && err.retryAfter) {
          wait = err.retryAfter * 1000;
        } else {
          this.ctx.onStatus("connecting", err instanceof Error ? err.message : String(err));
        }
        log.debug(`poll failed, retrying in ${wait} ms`, err instanceof Error ? err.message : err);
        await sleepFor(wait, this.abort.signal);
      }
    }
  }

  private addressed(m: TgMessage, text: string): boolean {
    if (m.chat.type === "private") return true;
    if (m.reply_to_message?.from?.id !== undefined && String(m.reply_to_message.from.id) === this.ctx.bot.id) return true;
    const command = /^\/\w+(?:@(\w+))?/.exec(text);
    if (command) return !command[1] || command[1].toLowerCase() === this.username;
    return !!this.username && text.toLowerCase().includes(`@${this.username}`);
  }

  private handle(m: TgMessage) {
    // Posts on behalf of a channel (and the "Telegram" service account forwarding them) are nobody's to approve.
    if (!m.from || m.from.is_bot || m.from.id === TELEGRAM_SERVICE_ACCOUNT || m.sender_chat || m.chat.type === "channel") return;
    const raw = m.text ?? m.caption ?? "";
    if (!this.addressed(m, raw)) return;
    let text = raw.replace(/^\/(\w+)@\w+/, "/$1");
    if (this.username) text = text.replace(new RegExp(`@${this.username}\\b`, "gi"), "").trim();
    const direct = m.chat.type === "private";
    const thread = m.is_topic_message ? m.message_thread_id : undefined;
    this.ctx.onMessage({
      chatKey: thread ? `${m.chat.id}:${thread}` : String(m.chat.id),
      target: { chatId: String(m.chat.id), reply: thread ? { threadId: thread } : {} },
      kind: direct ? "direct" : "group",
      chatTitle: direct ? fullName(m.from) || "Direct message" : (m.chat.title ?? "Group"),
      user: { id: String(m.from.id), name: fullName(m.from) || m.from.username || String(m.from.id), username: m.from.username ?? null },
      messageId: String(m.message_id),
      text,
      files: this.files(m),
    });
  }

  private files(m: TgMessage): InboundFile[] {
    const out: InboundFile[] = [];
    const add = (ref: TgFileRef | undefined, name: string, mime: string) => {
      if (!ref) return;
      out.push({ name: ref.file_name || name, mime: ref.mime_type || mime, size: ref.file_size ?? null, download: () => this.download(ref.file_id) });
    };
    const photo = m.photo?.[m.photo.length - 1];
    add(photo, `photo-${m.message_id}.jpg`, "image/jpeg");
    add(m.document, `file-${m.message_id}`, "application/octet-stream");
    add(m.voice, `voice-${m.message_id}.ogg`, "audio/ogg");
    add(m.audio, `audio-${m.message_id}.mp3`, "audio/mpeg");
    add(m.video, `video-${m.message_id}.mp4`, "video/mp4");
    return out;
  }

  private async download(fileId: string): Promise<Uint8Array> {
    const file = await call<{ file_path?: string; file_size?: number }>(this.token, "getFile", { file_id: fileId });
    if (!file.file_path) throw new MessagingError("Telegram only hands bots files up to 20 MB");
    const res = await fetchWithTimeout(`${API}/file/bot${this.token}/${file.file_path}`, { timeoutMs: 120_000 });
    if (!res.ok) throw new MessagingError(`Telegram answered ${res.status} for the file`);
    return readLimited(res, TELEGRAM_MAX_FILE);
  }

  async send(target: ChatTarget, markdown: string): Promise<void> {
    const threadId = typeof target.reply.threadId === "number" ? target.reply.threadId : undefined;
    const replyTo = typeof target.reply.replyTo === "string" ? Number(target.reply.replyTo) : undefined;
    let first = true;
    for (const chunk of splitMessage(markdown, MESSAGE_LIMIT)) {
      const base = {
        chat_id: target.chatId,
        ...(threadId ? { message_thread_id: threadId } : {}),
        ...(first && replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
        link_preview_options: { is_disabled: true },
      };
      const html = toTelegramHtml(chunk);
      const plain = toPlainText(chunk);
      if (!html.trim() || !plain.trim()) continue;
      first = false;
      await this.sendOne({ ...base, text: html, parse_mode: "HTML" }, { ...base, text: plain });
    }
  }

  private async sendOne(formatted: Record<string, unknown>, plain: Record<string, unknown>, attempt = 0): Promise<void> {
    try {
      await call(this.token, "sendMessage", formatted);
    } catch (err) {
      if (err instanceof TelegramApiError && err.retryAfter && attempt < 2) {
        await sleep(err.retryAfter * 1000);
        return this.sendOne(formatted, plain, attempt + 1);
      }
      // Formatting Telegram refuses (unbalanced tags) must not swallow the answer.
      if (err instanceof TelegramApiError && err.code === 400 && formatted !== plain) return this.sendOne(plain, plain, attempt);
      throw err;
    }
  }

  async working(target: ChatTarget): Promise<() => Promise<void>> {
    if (this.stopped) return async () => {};
    const threadId = typeof target.reply.threadId === "number" ? target.reply.threadId : undefined;
    const ping = () =>
      call(this.token, "sendChatAction", { chat_id: target.chatId, action: "typing", ...(threadId ? { message_thread_id: threadId } : {}) }).catch(() => undefined);
    void ping();
    const timer = setInterval(() => (this.stopped ? clearInterval(timer) : void ping()), TYPING_EVERY_MS);
    return async () => clearInterval(timer);
  }
}
