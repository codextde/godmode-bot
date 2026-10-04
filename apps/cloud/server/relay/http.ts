/**
 * HTTP through the link: `/d/<id>/api/…` (channel "cloud") and `/gw/<id>/api/…` (channel "mobile").
 *
 * Bodies flow under the contract's flow control in both directions: the request body is forwarded only as far as the
 * computer granted credit (and the link's socket has room), and the computer gets credit back for its response body
 * only once the bytes were written out to the client, so a slow client holds at most one window in memory.
 */
import { validateHeaderName, validateHeaderValue, type IncomingMessage, type ServerResponse } from "node:http";
import {
  CLOUD_CHUNK,
  CLOUD_DROPPED_REQUEST_HEADERS,
  CLOUD_PASSED_RESPONSE_HEADERS,
  CLOUD_WINDOW,
  CloudCredit,
  CloudFrame,
  CloudWindow,
  cloudFrameJson,
  decodeCloudWindow,
  encodeCloudFrame,
  encodeCloudWindow,
  isPassableContentType,
  type CloudChannel,
  type CloudFrameData,
  type CloudHeaders,
  type CloudReqHead,
} from "@godmode/shared";
import { browserAccess, header, phoneAccess, type Grant } from "./access";
import type { RelayHub } from "./hub";
import { addressKey } from "./limits";
import { ProtocolError, type Link, type RelayStream } from "./link";
import { RELAY_SECURITY_HEADERS, denial, writeDenial, type Denial } from "./respond";

/** A request body is given up when the client sends nothing for this long. */
const BODY_IDLE_MS = 30_000;
const MAX_RESPONSE_HEADERS = 64;
const MAX_HEADER_VALUE = 8 * 1024;

const DROPPED = new Set(CLOUD_DROPPED_REQUEST_HEADERS);
const PASSED = new Set(CLOUD_PASSED_RESPONSE_HEADERS);

/** The client's headers as the computer may see them: no cookies, hop-by-hop or proxy headers. */
export function relayRequestHeaders(raw: string[], channel: CloudChannel): CloudHeaders {
  const out: CloudHeaders = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i]!.toLowerCase();
    if (DROPPED.has(name)) continue;
    // On "cloud" the person is identified by the cloud; on "mobile" this is the phone's own device token.
    if (channel === "cloud" && name === "authorization") continue;
    out.push([name, raw[i + 1]!]);
  }
  return out;
}

/**
 * Answers can go out before the client finished sending its body (a refused upload, 413, a failure). Node closes the
 * connection right after an answer when the client asked for that, and closing with unread bytes resets it; a reset
 * can make the client lose the answer it has not read yet. So the answer is ended only once the rest of the body was
 * read and dropped; a client still sending after this long is cut off.
 */
const LINGER_MS = 5_000;

/** Destroys the connection once `res` is out (or at once when it already is). */
function cutAfter(req: IncomingMessage, res: ServerResponse): void {
  if (res.writableFinished || res.destroyed) req.socket.destroy();
  else res.once("finish", () => req.socket.destroy());
}

/** Ends a refusal written before any stream existed, once the request body was read and dropped. */
function endAfterBody(req: IncomingMessage, res: ServerResponse): void {
  if (req.complete) {
    res.end();
    return;
  }
  // A keep-alive connection carries many requests: the listener must go with this one.
  const socket = req.socket;
  const onClose = () => clearTimeout(timer);
  const timer = setTimeout(() => {
    socket.off("close", onClose);
    res.end();
    cutAfter(req, res);
  }, LINGER_MS);
  timer.unref();
  req.once("end", () => {
    clearTimeout(timer);
    socket.off("close", onClose);
    res.end();
  });
  socket.once("close", onClose);
  req.resume();
}

const IDLE = Symbol("idle");

function withIdleTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof IDLE> {
  let timer: NodeJS.Timeout | undefined;
  const idle = new Promise<typeof IDLE>((resolve) => {
    timer = setTimeout(() => resolve(IDLE), ms);
  });
  return Promise.race([promise, idle]).finally(() => clearTimeout(timer));
}

class HttpRelayStream implements RelayStream {
  readonly kind = "http" as const;
  readonly channel: CloudChannel;
  readonly session: Grant["session"];
  private readonly window = new CloudWindow();
  private readonly credit = new CloudCredit();
  /** ResBody bytes received and not yet granted back. */
  private ungranted = 0;
  private status = 0;
  private noBody = false;
  private declaredLength: number | null = null;
  private written = 0;
  /** The client's body was read to the end (or there is none). */
  private bodyDone: boolean;
  private over = false;
  private bytesIn = 0;
  private bytesOut = 0;
  private pendingEnd: (() => void) | null = null;
  private lingerTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly hub: RelayHub,
    private readonly link: Link,
    readonly id: number,
    private readonly req: IncomingMessage,
    private readonly res: ServerResponse,
    private readonly grant: Grant,
    private readonly method: string,
    private readonly hasBody: boolean,
  ) {
    this.channel = grant.channel;
    this.session = grant.session;
    this.bodyDone = !hasBody;
  }

  start(path: string): void {
    const head: CloudReqHead = {
      method: this.method,
      path,
      headers: relayRequestHeaders(this.req.rawHeaders, this.channel),
      channel: this.channel,
      user: this.grant.user,
      ip: this.grant.ip,
      hasBody: this.hasBody,
    };
    this.link.send(encodeCloudFrame(CloudFrame.ReqHead, this.id, head));
    this.res.on("close", () => {
      if (!this.over) this.clientGone();
    });
    if (this.res.destroyed) {
      this.clientGone();
      return;
    }
    if (this.hasBody) void this.pump();
  }

  onFrame(frame: CloudFrameData): void {
    switch (frame.type) {
      case CloudFrame.ResHead:
        return this.onHead(frame);
      case CloudFrame.ResBody:
        return this.onBody(frame);
      case CloudFrame.ResEnd:
        return this.onEnd();
      case CloudFrame.Abort:
        return this.onAbort();
      case CloudFrame.Window:
        this.window.grant(decodeCloudWindow(frame));
        return;
      default:
        throw new ProtocolError("WebSocket frame on an HTTP stream.");
    }
  }

  linkClosed(): void {
    if (this.over) return;
    if (!this.status) this.deny(denial(502, "link_lost", "The connection to the computer was lost. Try again."));
    else this.res.destroy();
    this.finish();
  }

  revoke(): void {
    if (this.over) return;
    this.abortComputer("Access ended");
    if (!this.status) this.deny(denial(403, "cloud_forbidden", "Your access to this computer ended."));
    else this.res.destroy();
    this.finish();
  }

  /** The cloud's own answer instead of the computer's. */
  private deny(d: Denial): void {
    if (writeDenial(this.res, d)) this.endAfterBody(() => this.res.end());
  }

  /** Runs `end` once the client's body was read to the end; see LINGER_MS. */
  private endAfterBody(end: () => void): void {
    if (this.bodyDone) return end();
    this.pendingEnd = end;
    this.lingerTimer = setTimeout(() => {
      this.flushEnd();
      cutAfter(this.req, this.res);
    }, LINGER_MS);
    this.lingerTimer.unref();
  }

  private flushEnd(): void {
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    const end = this.pendingEnd;
    this.pendingEnd = null;
    end?.();
  }

  /**
   * Forwards the client's body in chunks the computer has credit for. Once the stream is over (answered, refused,
   * aborted) the rest of the body is read and dropped until the client is done or the linger time ends.
   */
  private async pump(): Promise<void> {
    const chunks = this.req[Symbol.asyncIterator]();
    let total = 0;
    for (;;) {
      let next: IteratorResult<Buffer> | typeof IDLE;
      try {
        next = await withIdleTimeout(chunks.next(), BODY_IDLE_MS);
      } catch {
        // The client disconnected (or was cut off after lingering).
        this.clientGone();
        this.flushEnd();
        return;
      }
      if (next === IDLE) {
        if (this.over) {
          // The answer is complete and only waits for the rest of the body: send it, then cut the connection.
          this.flushEnd();
          cutAfter(this.req, this.res);
          return;
        }
        this.abortComputer("The client stopped sending");
        this.res.destroy();
        this.finish();
        return;
      }
      if (next.done) {
        if (!this.over) this.link.send(encodeCloudFrame(CloudFrame.ReqEnd, this.id));
        this.bodyDone = true;
        this.flushEnd();
        return;
      }
      if (this.over) continue;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > this.grant.maxBodyBytes) {
        this.abortComputer("Body too large");
        if (!this.status) {
          const mb = Math.round(this.grant.maxBodyBytes / (1024 * 1024));
          const limit = mb >= 1 ? `${mb} MB` : `${Math.round(this.grant.maxBodyBytes / 1024)} KB`;
          this.deny(denial(413, "body_too_large", `This upload is larger than the ${limit} the cloud relays.`));
        } else this.res.destroy();
        this.finish();
        continue;
      }
      try {
        for (let offset = 0; offset < chunk.byteLength && !this.over; offset += CLOUD_CHUNK) {
          const part = chunk.subarray(offset, offset + CLOUD_CHUNK);
          await this.window.take(part.byteLength);
          await this.link.drained();
          if (this.over) break;
          this.link.send(encodeCloudFrame(CloudFrame.ReqBody, this.id, part));
          this.bytesIn += part.byteLength;
        }
      } catch {
        // The window rejects once the stream is over; the rest is dropped.
      }
    }
  }

  private onHead(frame: CloudFrameData): void {
    if (this.status) throw new ProtocolError("Second ResHead on a stream.");
    const head = cloudFrameJson<{ status?: unknown; headers?: unknown }>(frame);
    if (!head || typeof head.status !== "number" || !Array.isArray(head.headers)) throw new ProtocolError("Malformed ResHead.");
    const status = head.status;
    // The core never redirects: a 3xx on the cloud's origin could send the browser's next request (with its cookie)
    // to another computer.
    if (!Number.isInteger(status) || status < 200 || status > 599 || (status >= 300 && status < 400)) return this.badResponse();
    const headers = this.responseHeaders(head.headers);
    try {
      this.res.writeHead(status, headers);
    } catch {
      return this.badResponse();
    }
    this.status = status;
    this.noBody = this.method === "HEAD" || status === 204;
    // Node holds the head back until the first body chunk; an event stream must reach the client at once.
    if (headers["content-type"]?.startsWith("text/event-stream")) this.res.flushHeaders();
    if (this.channel === "mobile" && status === 401) this.hub.gatewayUnauthorized.strike(addressKey(this.grant.ip));
  }

  private responseHeaders(list: unknown[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const entry of list.slice(0, MAX_RESPONSE_HEADERS)) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string") continue;
      const name = entry[0].toLowerCase();
      const value: string = entry[1];
      if (!PASSED.has(name) || name in out || value.length > MAX_HEADER_VALUE) continue;
      try {
        validateHeaderName(name);
        validateHeaderValue(name, value);
      } catch {
        continue;
      }
      out[name] = value;
    }
    if (out["content-type"] !== undefined && !isPassableContentType(out["content-type"])) out["content-type"] = "application/octet-stream";
    if (!/\b(private|no-store)\b/i.test(out["cache-control"] ?? "")) out["cache-control"] = "private, no-store";
    if (out["content-length"] !== undefined) {
      if (/^\d{1,15}$/.test(out["content-length"])) this.declaredLength = Number(out["content-length"]);
      else delete out["content-length"];
    }
    Object.assign(out, RELAY_SECURITY_HEADERS);
    return out;
  }

  private onBody(frame: CloudFrameData): void {
    if (!this.status) throw new ProtocolError("ResBody before ResHead.");
    const n = frame.payload.byteLength;
    this.ungranted += n;
    if (this.ungranted > CLOUD_WINDOW) throw new ProtocolError("Response body beyond the window.");
    this.bytesOut += n;
    if (this.noBody) {
      this.consumed(n);
      return;
    }
    if (this.declaredLength !== null && this.written + n > this.declaredLength) {
      this.abortComputer("Body longer than its content-length");
      this.res.destroy();
      this.finish();
      return;
    }
    this.written += n;
    this.res.write(frame.payload, (err) => {
      if (!err) this.consumed(n);
    });
  }

  /** Bytes reached the client: give the computer that much credit back. */
  private consumed(n: number): void {
    if (this.over) return;
    const grant = this.credit.consumed(n);
    if (!grant) return;
    this.ungranted -= grant;
    this.link.send(encodeCloudWindow(this.id, grant));
  }

  private onEnd(): void {
    if (!this.status) throw new ProtocolError("ResEnd before ResHead.");
    if (!this.noBody && this.declaredLength !== null && this.written !== this.declaredLength) this.res.destroy();
    else this.endAfterBody(() => this.res.end());
    this.finish();
  }

  private onAbort(): void {
    if (!this.status) this.deny(denial(502, "link_lost", "The computer stopped answering this request. Try again."));
    else this.res.destroy();
    this.finish();
  }

  private badResponse(): void {
    this.abortComputer("Bad response");
    this.deny(denial(502, "bad_response", "The computer sent an answer the cloud does not pass on."));
    this.finish();
  }

  private clientGone(): void {
    if (this.over) return;
    this.abortComputer("Client went away");
    this.finish();
  }

  private abortComputer(reason: string): void {
    if (!this.over) this.link.send(encodeCloudFrame(CloudFrame.Abort, this.id, { reason }));
  }

  private finish(): void {
    if (this.over) return;
    this.over = true;
    this.window.close();
    this.link.end(this.id);
    // A phone the computer turned away (401), or one without a phone token (health check, pairing), costs its owner
    // nothing: strangers who only know the address can't burn the allowance.
    if (!(this.channel === "mobile" && (this.status === 401 || this.grant.anonymous))) this.link.count(this.bytesIn, this.bytesOut, 1);
  }
}

/** `apiPath` is the path the computer sees ("/api/…" plus the query), already normalised by the router. */
export async function relayHttp(
  hub: RelayHub,
  req: IncomingMessage,
  res: ServerResponse,
  channel: CloudChannel,
  deviceId: string,
  apiPath: string,
  ip: string,
): Promise<void> {
  const result =
    channel === "cloud"
      ? await browserAccess(req, ip, deviceId, apiPath, "http")
      : await phoneAccess(hub.gatewayUnauthorized, req, ip, deviceId, apiPath, "http");
  const refuse = (d: Denial) => {
    if (writeDenial(res, d)) endAfterBody(req, res);
  };
  if (!result.ok) return refuse(result.denial);
  if (res.destroyed) return;
  const link = hub.link(deviceId);
  if (!link) return refuse(denial(503, "device_offline", "This computer is offline. Start Godmode on it, or check its internet connection."));

  const method = (req.method ?? "GET").toUpperCase();
  const length = Number(header(req.headers, "content-length") ?? 0);
  const hasBody = method !== "GET" && method !== "HEAD" && (req.headers["transfer-encoding"] !== undefined || length > 0);
  if (hasBody && length > result.grant.maxBodyBytes) return refuse(denial(413, "body_too_large", "This upload is larger than the cloud relays."));
  const stream = link.open(channel, "http", (id) => new HttpRelayStream(hub, link, id, req, res, result.grant, method, hasBody));
  if (!stream) return refuse(denial(429, "rate_limited", "This computer is busy. Try again in a moment.", 1000));
  stream.start(apiPath);
}
