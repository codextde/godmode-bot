/**
 * Slack app over Socket Mode (a WebSocket the app opens): no public address needed. The bot answers direct messages
 * and mentions in channels (in the thread), and takes commands through the `/godmode` slash command.
 * https://api.slack.com/apis/socket-mode
 */
import type { MessagingVerifyResult } from "@godmode/shared";
import { SLACK_BOT_SCOPES } from "@godmode/shared";
import { logger } from "../log";
import { sleep } from "../util";
import { fromSlackText, splitMessage, toSlackMrkdwn } from "./format";
import {
  fetchWithTimeout,
  MessagingError,
  readLimited,
  type AdapterContext,
  type ChatTarget,
  type InboundFile,
  type InboundMessage,
  type MessagingAdapter,
  type Secrets,
} from "./types";

const log = logger("slack");

const API = "https://slack.com/api";
const MAX_FILE = 25 * 1024 * 1024;
const MESSAGE_LIMIT = 3500;
const MAX_BACKOFF_MS = 60_000;
const WORKING_REACTION = "eyes";
/** A socket that doesn't answer a ping within this long is dead (sleep, network change) and is replaced. */
const PING_EVERY_MS = 30_000;

const REQUIRED_SCOPES = ["chat:write", "im:history"];

class SlackApiError extends MessagingError {
  constructor(
    public code: string,
    message: string,
    public retryAfter?: number,
  ) {
    super(message, ["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "not_allowed_token_type"].includes(code));
  }
}

function explain(code: string, needed?: string): string {
  switch (code) {
    case "invalid_auth":
    case "not_authed":
    case "token_revoked":
    case "token_expired":
    case "account_inactive":
      return "Slack doesn't accept this token. Copy it again from your Slack app.";
    case "not_allowed_token_type":
      return "That's the wrong kind of token: the bot token starts with xoxb-, the app-level token with xapp-.";
    case "missing_scope":
      return `The Slack app is missing the “${needed ?? "required"}” permission. Add it under OAuth & Permissions and reinstall the app.`;
    case "ratelimited":
      return "Slack is rate limiting the bot — slowing down.";
    default:
      return `Slack answered “${code}”`;
  }
}

type SlackResult = Record<string, unknown> & { ok: boolean; error?: string; needed?: string };

async function slack<T extends SlackResult>(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  opts: { json?: boolean } = {},
): Promise<T & { scopes: string[] | null }> {
  const body = opts.json
    ? JSON.stringify(params)
    : new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
      ).toString();
  const res = await fetchWithTimeout(`${API}/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": opts.json ? "application/json; charset=utf-8" : "application/x-www-form-urlencoded",
    },
    body,
  });
  if (res.status === 429) throw new SlackApiError("ratelimited", explain("ratelimited"), Number(res.headers.get("retry-after") ?? "5"));
  let json: T;
  try {
    json = (await res.json()) as T;
  } catch {
    throw new SlackApiError(`http_${res.status}`, `Slack answered ${res.status}`);
  }
  if (!json.ok) throw new SlackApiError(json.error ?? "unknown_error", explain(json.error ?? "unknown_error", json.needed));
  const header = res.headers.get("x-oauth-scopes");
  return { ...json, scopes: header === null ? null : header.split(",").map((s) => s.trim()).filter(Boolean) };
}

export async function verifySlack(secrets: Secrets<"slack">): Promise<MessagingVerifyResult> {
  const botToken = secrets.botToken.trim();
  const appToken = secrets.appToken.trim();
  if (!botToken.startsWith("xoxb-")) throw new MessagingError("The bot token starts with xoxb- (OAuth & Permissions → Bot User OAuth Token).", true);
  if (!appToken.startsWith("xapp-")) throw new MessagingError("The app-level token starts with xapp- (Basic Information → App-Level Tokens).", true);
  const auth = await slack<SlackResult & { url: string; team: string; team_id: string; user: string; user_id: string; bot_id: string }>(botToken, "auth.test");
  try {
    await slack(appToken, "apps.connections.open");
  } catch (err) {
    if (err instanceof SlackApiError && err.code === "invalid_auth") throw new MessagingError("Slack doesn't accept the app-level token. Create one with the connections:write scope.", true);
    if (err instanceof SlackApiError && err.code === "not_allowed_token_type") throw new MessagingError("The app-level token must start with xapp- and have the connections:write scope.", true);
    if (err instanceof SlackApiError && /socket/i.test(err.code)) throw new MessagingError("Turn on Socket Mode for the Slack app (Settings → Socket Mode).", true);
    throw err;
  }
  const missing = auth.scopes ? REQUIRED_SCOPES.filter((s) => !auth.scopes!.includes(s)) : [];
  if (missing.length) {
    throw new MessagingError(`The Slack app is missing ${missing.map((s) => `“${s}”`).join(" and ")}. Add ${missing.length > 1 ? "them" : "it"} under OAuth & Permissions and reinstall the app.`, true);
  }
  const warnings: string[] = [];
  const optional = auth.scopes ? SLACK_BOT_SCOPES.filter((s) => !REQUIRED_SCOPES.includes(s) && !auth.scopes!.includes(s)) : [];
  if (optional.length) warnings.push(`Some permissions are missing (${optional.join(", ")}): mentions, files or names may not work. Easiest fix: create the app from the manifest.`);
  let name = auth.user;
  let appId: string | null = null;
  try {
    const info = await slack<SlackResult & { bot?: { name?: string; app_id?: string } }>(botToken, "bots.info", { bot: auth.bot_id });
    name = info.bot?.name || name;
    appId = info.bot?.app_id ?? null;
  } catch (err) {
    log.debug("bots.info failed", err);
  }
  return {
    bot: {
      id: auth.user_id,
      name,
      username: auth.user,
      team: auth.team,
      url: appId ? `https://slack.com/app_redirect?app=${appId}&team=${auth.team_id}` : auth.url,
    },
    warnings,
  };
}

interface SlackFile {
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
}

interface SlackEvent {
  type: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  channel: string;
  channel_type?: string;
  files?: SlackFile[];
}

interface Envelope {
  type: string;
  envelope_id?: string;
  reason?: string;
  payload?: Record<string, unknown>;
}

export class SlackAdapter implements MessagingAdapter {
  private stopped = false;
  /** The socket that reconnects when it drops; retired ones still deliver until Slack closes them. */
  private ws: WebSocket | null = null;
  private sockets = new Set<WebSocket>();
  private failures = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private alive = true;
  private names = new Map<string, string>();
  private channels = new Map<string, string>();

  constructor(
    private readonly ctx: AdapterContext,
    private readonly secrets: Secrets<"slack">,
  ) {}

  start(): void {
    void this.connect();
    this.pingTimer = setInterval(() => this.checkAlive(), PING_EVERY_MS);
  }

  private checkAlive() {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!this.alive) {
      log.info("the Slack socket stopped answering; reconnecting");
      this.refresh(ws);
      return;
    }
    this.alive = false;
    try {
      (ws as WebSocket & { ping: () => void }).ping();
    } catch {
      this.refresh(ws);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws = null;
    for (const ws of this.sockets) {
      try {
        ws.close(1000);
      } catch {
        /* already closed */
      }
    }
    this.sockets.clear();
  }

  private async connect() {
    if (this.stopped) return;
    if (!this.sockets.size) this.ctx.onStatus("connecting");
    let url: string;
    try {
      ({ url } = await slack<SlackResult & { url: string }>(this.secrets.appToken.trim(), "apps.connections.open"));
    } catch (err) {
      if (err instanceof MessagingError && err.fatal) {
        this.ctx.onStatus("error", err.message);
        return;
      }
      this.retry(err, err instanceof SlackApiError ? err.retryAfter : undefined);
      return;
    }
    if (this.stopped) return;
    const ws = new WebSocket(url);
    this.ws = ws;
    this.alive = true;
    this.sockets.add(ws);
    ws.addEventListener("pong", () => {
      if (this.ws === ws) this.alive = true;
    });
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.alive = true;
      if (!this.stopped) this.onFrame(ws, typeof ev.data === "string" ? ev.data : String(ev.data));
    };
    ws.onclose = () => {
      this.sockets.delete(ws);
      if (this.ws !== ws) return;
      this.ws = null;
      this.retry(new Error("the connection closed"));
    };
    ws.onerror = () => {
      /* a close event follows */
    };
  }

  private retry(err: unknown, afterSeconds?: number) {
    if (this.stopped) return;
    this.failures++;
    const wait = afterSeconds ? afterSeconds * 1000 : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.failures, 6));
    if (this.failures > 2) this.ctx.onStatus("connecting", err instanceof Error ? err.message : String(err));
    this.reconnectTimer = setTimeout(() => void this.connect(), wait);
  }

  /** Slack is about to drop this socket (refreshes happen every few hours): open the next one first. */
  private refresh(ws: WebSocket) {
    if (this.ws !== ws) return;
    this.ws = null;
    void this.connect();
    setTimeout(() => {
      try {
        ws.close(1000);
      } catch {
        /* already closed */
      }
    }, 15_000).unref?.();
  }

  private onFrame(ws: WebSocket, raw: string) {
    let env: Envelope;
    try {
      env = JSON.parse(raw) as Envelope;
    } catch {
      return;
    }
    if (env.envelope_id) ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
    switch (env.type) {
      case "hello":
        this.failures = 0;
        this.ctx.onStatus("connected");
        return;
      case "disconnect":
        this.refresh(ws);
        return;
      case "events_api": {
        const payload = env.payload ?? {};
        const event = (payload.event ?? payload) as SlackEvent;
        if (event?.type) void this.onEvent(event).catch((err) => log.warn("event failed", err instanceof Error ? err.message : err));
        return;
      }
      case "slash_commands":
        void this.onCommand(env.payload ?? {}).catch((err) => log.warn("command failed", err instanceof Error ? err.message : err));
        return;
    }
  }

  private async onEvent(event: SlackEvent) {
    if (event.bot_id || !event.user || event.user === this.ctx.bot.id) return;
    if (event.subtype && event.subtype !== "file_share" && event.subtype !== "thread_broadcast") return;
    let message: Omit<InboundMessage, "user" | "text" | "files" | "messageId">;
    if (event.type === "message" && event.channel_type === "im") {
      message = {
        chatKey: event.channel,
        target: { chatId: event.channel, reply: event.thread_ts ? { threadTs: event.thread_ts } : {} },
        kind: "direct",
        chatTitle: "",
      };
    } else if (event.type === "app_mention" && !event.channel.startsWith("D")) {
      const thread = event.thread_ts ?? event.ts;
      message = {
        chatKey: `${event.channel}:${thread}`,
        parentKey: event.channel,
        target: { chatId: event.channel, reply: { threadTs: thread } },
        kind: "group",
        chatTitle: await this.channelName(event.channel),
      };
    } else return;
    const name = await this.userName(event.user);
    this.ctx.onMessage({
      ...message,
      chatTitle: message.chatTitle || name,
      user: { id: event.user, name, username: null },
      messageId: event.ts,
      text: fromSlackText((event.text ?? "").replace(new RegExp(`<@${this.ctx.bot.id}>`, "g"), "")).trim(),
      files: (event.files ?? []).flatMap((f) => this.file(f)),
    });
  }

  private async onCommand(p: Record<string, unknown>) {
    const channel = String(p.channel_id ?? "");
    const user = String(p.user_id ?? "");
    const responseUrl = String(p.response_url ?? "");
    if (!channel || !user) return;
    const words = String(p.text ?? "").trim();
    const direct = channel.startsWith("D");
    const name = await this.userName(user);
    this.ctx.onMessage({
      chatKey: channel,
      target: { chatId: channel, reply: {} },
      kind: direct ? "direct" : "group",
      chatTitle: direct ? name : await this.channelName(channel),
      user: { id: user, name, username: null },
      messageId: `cmd:${String(p.trigger_id ?? Date.now())}`,
      text: words ? `/${words.replace(/^\//, "")}` : "/help",
      files: [],
      commandOnly: true,
      respond: async (text) => {
        if (!/^https:\/\/hooks\.slack\.com\//.test(responseUrl)) return;
        await fetchWithTimeout(responseUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ response_type: "ephemeral", text: toSlackMrkdwn(text) }),
        });
      },
    });
  }

  private file(f: SlackFile): InboundFile[] {
    const url = f.url_private_download ?? f.url_private;
    if (!url || !/^https:\/\/([\w-]+\.)*slack(-edge)?\.com\//.test(url)) return [];
    return [
      {
        name: f.name || f.title || "file",
        mime: f.mimetype || "application/octet-stream",
        size: f.size ?? null,
        download: async () => {
          const res = await fetchWithTimeout(url, { headers: { authorization: `Bearer ${this.secrets.botToken.trim()}` }, timeoutMs: 120_000 });
          if (!res.ok) throw new MessagingError(`Slack answered ${res.status} for the file`);
          if ((res.headers.get("content-type") ?? "").includes("text/html")) throw new MessagingError("Slack didn't hand over the file (the app needs the files:read permission)");
          return readLimited(res, MAX_FILE);
        },
      },
    ];
  }

  private async userName(id: string): Promise<string> {
    const cached = this.names.get(id);
    if (cached) return cached;
    try {
      const info = await slack<SlackResult & { user?: { real_name?: string; name?: string; profile?: { display_name?: string; real_name?: string } } }>(
        this.secrets.botToken.trim(),
        "users.info",
        { user: id },
      );
      const name = info.user?.profile?.real_name || info.user?.real_name || info.user?.profile?.display_name || info.user?.name || id;
      this.names.set(id, name);
      return name;
    } catch {
      return id;
    }
  }

  private async channelName(id: string): Promise<string> {
    const cached = this.channels.get(id);
    if (cached) return cached;
    try {
      const info = await slack<SlackResult & { channel?: { name?: string } }>(this.secrets.botToken.trim(), "conversations.info", { channel: id });
      const name = info.channel?.name ? `#${info.channel.name}` : "a channel";
      this.channels.set(id, name);
      return name;
    } catch {
      return "a channel";
    }
  }

  async send(target: ChatTarget, markdown: string): Promise<void> {
    const threadTs = typeof target.reply.threadTs === "string" ? target.reply.threadTs : undefined;
    for (const chunk of splitMessage(markdown, MESSAGE_LIMIT)) {
      const params = { channel: target.chatId, text: toSlackMrkdwn(chunk), thread_ts: threadTs, unfurl_links: false, unfurl_media: false };
      try {
        await slack(this.secrets.botToken.trim(), "chat.postMessage", params, { json: true });
      } catch (err) {
        if (!(err instanceof SlackApiError) || !err.retryAfter) throw err;
        await sleep(err.retryAfter * 1000);
        await slack(this.secrets.botToken.trim(), "chat.postMessage", params, { json: true });
      }
    }
  }

  async working(target: ChatTarget, messageId: string): Promise<() => Promise<void>> {
    if (messageId.startsWith("cmd:") || this.stopped) return async () => {};
    const params = { channel: target.chatId, timestamp: messageId, name: WORKING_REACTION };
    const token = this.secrets.botToken.trim();
    const added = await slack(token, "reactions.add", params).then(
      () => true,
      () => false,
    );
    return async () => {
      if (added) await slack(token, "reactions.remove", params).catch(() => undefined);
    };
  }
}
