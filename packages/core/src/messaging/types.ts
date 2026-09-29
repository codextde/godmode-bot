import type { MessagingBot, MessagingConfig, MessagingCredentials, MessagingState } from "@godmode/shared";

export interface InboundFile {
  name: string;
  mime: string;
  /** Bytes, when the platform says. */
  size: number | null;
  download: () => Promise<Uint8Array>;
}

/** Where an answer goes: the platform chat plus what the platform needs to reply there. */
export interface ChatTarget {
  chatId: string;
  reply: Record<string, unknown>;
}

export interface InboundMessage {
  /** Stable key of the conversation on the platform (a DM, a group, a channel thread). */
  chatKey: string;
  target: ChatTarget;
  kind: "direct" | "group";
  chatTitle: string;
  user: { id: string; name: string; username: string | null };
  /** Platform message id (dedupe, reactions, replies). */
  messageId: string;
  /** Mentions of the bot removed. */
  text: string;
  files: InboundFile[];
  /** A command sent through the platform's command UI (Slack slash command): answered privately with this. */
  respond?: (text: string) => Promise<void>;
  /** Command-only messages (Slack slash commands) never start a run. */
  commandOnly?: boolean;
  /** Settings shared by every thread of a channel (Slack): the chat key of the channel. */
  parentKey?: string;
}

export interface AdapterContext {
  connectionId: string;
  bot: MessagingBot;
  config: MessagingConfig;
  /** Runtime state persisted between restarts (Telegram update offset). */
  state: Record<string, unknown>;
  saveState: (patch: Record<string, unknown>) => void;
  onMessage: (message: InboundMessage) => void;
  onStatus: (state: MessagingState, message?: string | null) => void;
}

export interface MessagingAdapter {
  start(): void;
  stop(): Promise<void>;
  /** Send Markdown (converted and split for the platform). */
  send(target: ChatTarget, markdown: string): Promise<void>;
  /** Show that an answer is being worked on; the returned function ends it. */
  working(target: ChatTarget, messageId: string): Promise<() => Promise<void>>;
  /** Teams: an HTTP delivery from the platform. */
  receive?(req: Request): Promise<Response>;
}

export type Secrets<P extends MessagingCredentials["provider"]> = Omit<Extract<MessagingCredentials, { provider: P }>, "provider">;

/** Thrown for errors a human can act on (bad token, missing scope); the message is shown as is. */
export class MessagingError extends Error {
  constructor(
    message: string,
    /** The credentials are no good: don't retry until they change. */
    public fatal = false,
  ) {
    super(message);
  }
}

export const MESSAGING_USER_AGENT = "GodmodeBot (+https://github.com/codextde/godmode-bot)";

/** fetch with a timeout; network failures become MessagingErrors. */
export async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 20_000, signal, ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url, {
      ...rest,
      headers: { "user-agent": MESSAGING_USER_AGENT, ...(rest.headers as Record<string, string> | undefined) },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return url;
      }
    })();
    throw new MessagingError(timeout.aborted ? `${host} didn't answer in time` : `Couldn't reach ${host}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Read a response body of at most `max` bytes. */
export async function readLimited(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) throw new MessagingError(`The file is larger than ${Math.round(max / 1024 / 1024)} MB`);
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new MessagingError(`The file is larger than ${Math.round(max / 1024 / 1024)} MB`);
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
