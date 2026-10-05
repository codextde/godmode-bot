/**
 * Microsoft Teams bot through the Azure Bot Service (Bot Framework). Teams delivers messages to a public https
 * endpoint (`/hooks/messaging/<token>` behind a tunnel or server); every delivery carries a JWT signed by the Bot
 * Framework, verified here. Answers go to the conversation's service URL with a client-credentials token.
 * https://learn.microsoft.com/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
 */
import { zipSync, strToU8 } from "fflate";
import type { MessagingVerifyResult } from "@godmode/shared";
import { logger } from "../log";
import { badRequest } from "../util";
import { encodePng, type Raster } from "../vm/raster";
import { splitMessage } from "./format";
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

const log = logger("teams");

const OPENID_URL = "https://login.botframework.com/v1/.well-known/openidconfiguration";
const ISSUER = "https://api.botframework.com";
const SCOPE = "https://api.botframework.com/.default";
const CLOCK_SKEW_S = 300;
const KEYS_TTL_MS = 24 * 3_600_000;
const KEYS_REFRESH_MIN_MS = 5 * 60_000;
const MAX_BODY = 512 * 1024;
const MAX_FILE = 25 * 1024 * 1024;
const MESSAGE_LIMIT = 12_000;
const TYPING_EVERY_MS = 3000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ------------------------------------------------------------------ */
/* Public address                                                      */
/* ------------------------------------------------------------------ */

/** "godmode.example.com/" → "https://godmode.example.com". "" clears it. */
export function normalizePublicUrl(input: string): string {
  const raw = input.trim().replace(/\/+$/, "");
  if (!raw) return "";
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw badRequest("The public address must be a URL like https://godmode.example.com");
  }
  if (url.protocol !== "https:") throw badRequest("Teams only delivers to https addresses");
  if (url.search || url.hash) throw badRequest("The public address must not contain ? or #");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

interface AccessToken {
  value: string;
  expiresAt: number;
}

async function fetchToken(secrets: Secrets<"teams">): Promise<AccessToken> {
  const res = await fetchWithTimeout(`https://login.microsoftonline.com/${encodeURIComponent(secrets.tenantId.trim())}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: secrets.appId.trim(),
      client_secret: secrets.appPassword,
      scope: SCOPE,
    }).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    const code = /AADSTS\d+/.exec(json.error_description ?? "")?.[0];
    const reason =
      code === "AADSTS7000215"
        ? "The client secret is wrong (copy its Value, not its ID)."
        : code === "AADSTS700016"
          ? "No app with this App ID exists in that tenant."
          : code === "AADSTS90002" || code === "AADSTS900023"
            ? "The tenant ID is wrong."
            : code === "AADSTS7000222"
              ? "The client secret has expired. Create a new one."
              : (json.error_description?.split("\r\n")[0] ?? `Microsoft answered ${res.status}`);
    throw new MessagingError(reason, res.status === 400 || res.status === 401);
  }
  return { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
}

export async function verifyTeams(secrets: Secrets<"teams">): Promise<MessagingVerifyResult> {
  const appId = secrets.appId.trim();
  if (!GUID.test(appId)) throw new MessagingError("The Microsoft App ID is a GUID like 1f2e3d4c-…", true);
  if (!GUID.test(secrets.tenantId.trim())) throw new MessagingError("The tenant ID is a GUID like 72f988bf-… (Microsoft Entra ID → Overview).", true);
  if (!secrets.appPassword) throw new MessagingError("Paste the client secret of the bot's app registration.", true);
  await fetchToken(secrets);
  return {
    bot: {
      id: `28:${appId}`,
      name: "Teams bot",
      username: null,
      team: null,
      url: `https://teams.microsoft.com/l/chat/0/0?users=28:${appId}`,
    },
    warnings: [],
  };
}

/* ------------------------------------------------------------------ */
/* Inbound authentication (JWT from the Bot Framework)                 */
/* ------------------------------------------------------------------ */

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  endorsements?: string[];
}

let keyCache: { keys: Jwk[]; fetchedAt: number } | null = null;
let keysLoading: Promise<Jwk[]> | null = null;
const cryptoKeys = new Map<string, CryptoKey>();

async function loadKeys(): Promise<Jwk[]> {
  keysLoading ??= (async () => {
    try {
      const meta = (await (await fetchWithTimeout(OPENID_URL)).json()) as { jwks_uri?: string };
      if (!meta.jwks_uri?.startsWith("https://")) throw new MessagingError("The Bot Framework's key list is unavailable");
      const jwks = (await (await fetchWithTimeout(meta.jwks_uri)).json()) as { keys?: Jwk[] };
      const keys = (jwks.keys ?? []).filter((k) => k.kty === "RSA" && k.kid && k.n && k.e);
      keyCache = { keys, fetchedAt: Date.now() };
      cryptoKeys.clear();
      return keys;
    } finally {
      keysLoading = null;
    }
  })();
  return keysLoading;
}

async function keyFor(kid: string): Promise<{ key: CryptoKey; endorsements: string[] } | null> {
  let keys = keyCache && Date.now() - keyCache.fetchedAt < KEYS_TTL_MS ? keyCache.keys : await loadKeys();
  let jwk = keys.find((k) => k.kid === kid);
  // Keys rotate: an unknown key id refreshes the list (at most every few minutes).
  if (!jwk && keyCache && Date.now() - keyCache.fetchedAt > KEYS_REFRESH_MIN_MS) {
    keys = await loadKeys();
    jwk = keys.find((k) => k.kid === kid);
  }
  if (!jwk) return null;
  let key = cryptoKeys.get(kid);
  if (!key) {
    key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    cryptoKeys.set(kid, key);
  }
  return { key, endorsements: jwk.endorsements ?? [] };
}

function b64url(part: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(part, "base64url"));
}

export interface BotClaims {
  iss?: string;
  aud?: string;
  exp?: number;
  nbf?: number;
  serviceurl?: string;
  serviceUrl?: string;
}

/** Verify a Bot Framework bearer token; null when it isn't one for this bot. */
export async function verifyBotToken(authorization: string | null, appId: string, channelId: string): Promise<BotClaims | null> {
  const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string };
  let claims: BotClaims;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;
  const found = await keyFor(header.kid);
  if (!found) return null;
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", found.key, b64url(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) return null;
  const nowS = Date.now() / 1000;
  if (claims.iss !== ISSUER || claims.aud?.toLowerCase() !== appId.toLowerCase()) return null;
  if (typeof claims.exp !== "number" || claims.exp < nowS - CLOCK_SKEW_S) return null;
  if (typeof claims.nbf === "number" && claims.nbf > nowS + CLOCK_SKEW_S) return null;
  if (found.endorsements.length && !found.endorsements.includes(channelId)) return null;
  return claims;
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

interface Activity {
  type?: string;
  id?: string;
  channelId?: string;
  serviceUrl?: string;
  text?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  recipient?: { id?: string };
  conversation?: { id?: string; conversationType?: string; name?: string; isGroup?: boolean };
  channelData?: { tenant?: { id?: string }; channel?: { name?: string }; team?: { name?: string } };
  attachments?: { contentType?: string; contentUrl?: string; name?: string; content?: { downloadUrl?: string; fileType?: string } }[];
  entities?: { type?: string; text?: string; mentioned?: { id?: string } }[];
}

const MIME_BY_TYPE: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  txt: "text/plain",
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** The bot's own mention goes; other people's mentions stay as @Name. */
function messageText(a: Activity): string {
  let text = a.text ?? "";
  for (const e of a.entities ?? []) {
    if (e.type === "mention" && e.mentioned?.id === a.recipient?.id && e.text) text = text.split(e.text).join("");
  }
  return text
    .replace(/<at>([^<]*)<\/at>/gi, "@$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/** Hosts of the Teams connector (public cloud, GCC, GCC High, DoD): the only places the bot's token is sent to. */
const SERVICE_HOSTS = new Set(["smba.trafficmanager.net", "smba.infra.gcc.teams.microsoft.com", "smba.infra.gov.teams.microsoft.us", "smba.infra.dod.teams.microsoft.us"]);

function trustedServiceUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.port || !SERVICE_HOSTS.has(u.hostname.toLowerCase())) return null;
    return u.href.endsWith("/") ? u.href : `${u.href}/`;
  } catch {
    return null;
  }
}

export class TeamsAdapter implements MessagingAdapter {
  private token: AccessToken | null = null;
  private tokenLoading: Promise<AccessToken> | null = null;
  private stopped = false;

  constructor(
    private readonly ctx: AdapterContext,
    private readonly secrets: Secrets<"teams">,
  ) {}

  start(): void {
    if (!this.ctx.config.publicUrl) {
      this.ctx.onStatus("error", "Add the public https address of this Godmode, so Teams can deliver messages.");
      return;
    }
    this.ctx.onStatus("connecting");
    void this.accessToken().then(
      () => !this.stopped && this.ctx.onStatus("connected"),
      (err) => !this.stopped && this.ctx.onStatus("error", err instanceof Error ? err.message : String(err)),
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 5 * 60_000 > Date.now()) return this.token.value;
    this.tokenLoading ??= fetchToken(this.secrets).finally(() => {
      this.tokenLoading = null;
    });
    this.token = await this.tokenLoading;
    return this.token.value;
  }

  async receive(req: Request): Promise<Response> {
    let activity: Activity;
    try {
      activity = JSON.parse(new TextDecoder().decode(await readLimited(new Response(req.body, { headers: req.headers }), MAX_BODY))) as Activity;
    } catch (err) {
      if (err instanceof MessagingError) return Response.json({ error: "Too large" }, { status: 413 });
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
    // Only Teams: other Bot Framework channels (Web Chat, Direct Line) let clients choose who they claim to be.
    if (activity.channelId !== "msteams") return Response.json({ error: "Only Microsoft Teams is supported" }, { status: 403 });
    const claims = await verifyBotToken(req.headers.get("authorization"), this.secrets.appId.trim(), activity.channelId ?? "");
    if (!claims) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const serviceUrl = trustedServiceUrl(activity.serviceUrl);
    const claimed = claims.serviceurl ?? claims.serviceUrl;
    if (!serviceUrl || !claimed || trustedServiceUrl(claimed)?.toLowerCase() !== serviceUrl.toLowerCase()) {
      return Response.json({ error: "Unexpected service URL" }, { status: 403 });
    }
    const tenant = activity.channelData?.tenant?.id;
    if (!tenant || tenant.toLowerCase() !== this.secrets.tenantId.trim().toLowerCase()) return Response.json({ error: "Wrong tenant" }, { status: 403 });
    this.ctx.onStatus("connected");
    if (activity.type === "message") this.onMessage(activity, serviceUrl);
    return new Response(null, { status: 200 });
  }

  private onMessage(a: Activity, serviceUrl: string) {
    const conversationId = a.conversation?.id;
    const userId = a.from?.aadObjectId ?? a.from?.id;
    if (!conversationId || !userId || !a.id || a.from?.id === a.recipient?.id) return;
    const personal = (a.conversation?.conversationType ?? "personal") === "personal";
    const name = a.from?.name?.trim() || "Someone";
    const place = a.channelData?.channel?.name ?? a.conversation?.name ?? a.channelData?.team?.name;
    this.ctx.onMessage({
      chatKey: conversationId,
      target: { chatId: conversationId, reply: { serviceUrl, ...(personal ? {} : { threadId: a.id }) } },
      kind: personal ? "direct" : "group",
      chatTitle: personal ? name : place ? place : "Teams chat",
      user: { id: userId, name, username: null },
      messageId: a.id,
      text: messageText(a),
      files: this.files(a, serviceUrl),
    });
  }

  private files(a: Activity, serviceUrl: string): InboundFile[] {
    const out: InboundFile[] = [];
    for (const att of a.attachments ?? []) {
      const name = att.name || "file";
      if (att.contentType === "application/vnd.microsoft.teams.file.download.info" && att.content?.downloadUrl?.startsWith("https://")) {
        const url = att.content.downloadUrl;
        out.push({
          name,
          mime: MIME_BY_TYPE[(att.content.fileType ?? "").toLowerCase()] ?? "application/octet-stream",
          size: null,
          download: async () => {
            const res = await fetchWithTimeout(url, { timeoutMs: 120_000 });
            if (!res.ok) throw new MessagingError(`Teams answered ${res.status} for the file`);
            return readLimited(res, MAX_FILE);
          },
        });
      } else if (att.contentType?.startsWith("image/") && att.contentUrl && trustedServiceUrl(att.contentUrl)?.startsWith(new URL(serviceUrl).origin)) {
        const url = att.contentUrl;
        out.push({
          name: att.name || `image.${att.contentType.split("/")[1] ?? "png"}`,
          mime: att.contentType,
          size: null,
          download: async () => {
            const res = await fetchWithTimeout(url, { headers: { authorization: `Bearer ${await this.accessToken()}` }, timeoutMs: 120_000 });
            if (!res.ok) throw new MessagingError(`Teams answered ${res.status} for the image`);
            return readLimited(res, MAX_FILE);
          },
        });
      }
    }
    return out;
  }

  private async post(target: ChatTarget, activity: Record<string, unknown>, replyTo?: string): Promise<void> {
    const serviceUrl = trustedServiceUrl(typeof target.reply.serviceUrl === "string" ? target.reply.serviceUrl : undefined);
    if (!serviceUrl) throw new MessagingError("This Teams chat has no address to answer to");
    const path = `v3/conversations/${encodeURIComponent(target.chatId)}/activities${replyTo ? `/${encodeURIComponent(replyTo)}` : ""}`;
    const res = await fetchWithTimeout(`${serviceUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.accessToken()}`, "content-type": "application/json" },
      body: JSON.stringify(activity),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new MessagingError(`Teams answered ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
  }

  async send(target: ChatTarget, markdown: string): Promise<void> {
    const thread = typeof target.reply.threadId === "string" ? target.reply.threadId : undefined;
    for (const chunk of splitMessage(markdown, MESSAGE_LIMIT)) {
      await this.post(target, { type: "message", text: chunk, textFormat: "markdown" }, thread);
    }
  }

  async working(target: ChatTarget): Promise<() => Promise<void>> {
    if (this.stopped) return async () => {};
    const ping = () => this.post(target, { type: "typing" }).catch((err) => log.debug("typing failed", err instanceof Error ? err.message : err));
    void ping();
    const timer = setInterval(() => (this.stopped ? clearInterval(timer) : void ping()), TYPING_EVERY_MS);
    return async () => clearInterval(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Teams app package                                                   */
/* ------------------------------------------------------------------ */

/** Godmode's bolt (docs/assets/logo.svg, 512 × 512 view box). */
const BOLT: [number, number][] = [
  [283, 92],
  [158, 288],
  [244, 288],
  [222, 420],
  [354, 216],
  [266, 216],
];

function inside(poly: [number, number][], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function inRoundedRect(x: number, y: number, min: number, max: number, r: number): boolean {
  if (x < min || y < min || x > max || y > max) return false;
  const cx = Math.min(Math.max(x, min + r), max - r);
  const cy = Math.min(Math.max(y, min + r), max - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Render the logo at `size` px (4 × 4 supersampling). `tile` = the dark rounded square behind the bolt. */
function logo(size: number, tile: boolean): Raster {
  const data = new Uint8Array(size * size * 4);
  const s = 512 / size;
  const n = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bolt = 0;
      let bg = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const x = (px + (sx + 0.5) / n) * s;
          const y = (py + (sy + 0.5) / n) * s;
          if (inside(BOLT, x, y)) bolt++;
          else if (tile && inRoundedRect(x, y, 16, 496, 112)) bg++;
        }
      }
      const total = n * n;
      const i = (py * size + px) * 4;
      const a = (bolt + bg) / total;
      if (a === 0) continue;
      // Bolt #FAF9F5 over tile #1C1C1C; the outline icon is plain white.
      const mix = (fg: number, back: number) => Math.round((fg * bolt + back * bg) / (bolt + bg));
      data[i] = tile ? mix(0xfa, 0x1c) : 255;
      data[i + 1] = tile ? mix(0xf9, 0x1c) : 255;
      data[i + 2] = tile ? mix(0xf5, 0x1c) : 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  return { width: size, height: size, data };
}

/** Teams app package (manifest + icons) to upload under Teams → Apps → Manage your apps → Upload an app. */
export function teamsAppPackage(opts: { appId: string; name: string; publicUrl: string }): Uint8Array<ArrayBuffer> {
  const short = opts.name.trim().slice(0, 30) || "Godmode";
  const host = (() => {
    try {
      return new URL(opts.publicUrl).host;
    } catch {
      return null;
    }
  })();
  const manifest = {
    $schema: "https://developer.microsoft.com/json-schemas/teams/v1.19/MicrosoftTeams.schema.json",
    manifestVersion: "1.19",
    version: "1.0.0",
    id: opts.appId,
    developer: {
      name: "Godmode Bot",
      websiteUrl: "https://usegodmode.com",
      privacyUrl: "https://usegodmode.com/legal/privacy",
      termsOfUseUrl: "https://usegodmode.com/legal/terms",
    },
    name: { short, full: `${short} — Godmode agents` },
    description: {
      short: "Talk to your Godmode agents in Teams",
      full: "Chat with the AI agents running in your Godmode: ask questions, hand over tasks and get the results right here. Mention the bot in a channel to get an answer in the thread.",
    },
    icons: { color: "color.png", outline: "outline.png" },
    accentColor: "#1C1C1C",
    bots: [
      {
        botId: opts.appId,
        scopes: ["personal", "team", "groupChat"],
        supportsFiles: true,
        isNotificationOnly: false,
        commandLists: [
          {
            scopes: ["personal", "team", "groupChat"],
            commands: [
              { title: "/agents", description: "Agents you can talk to" },
              { title: "/agent", description: "Switch agent: /agent <name>" },
              { title: "/new", description: "Start a fresh conversation" },
              { title: "/stop", description: "Stop the current answer" },
              { title: "/help", description: "What this bot can do" },
            ],
          },
        ],
      },
    ],
    permissions: ["identity", "messageTeamMembers"],
    validDomains: host ? [host] : [],
  };
  const zip = zipSync(
    {
      "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
      "color.png": new Uint8Array(encodePng(logo(192, true))),
      "outline.png": new Uint8Array(encodePng(logo(32, false))),
    },
    { level: 6 },
  );
  return new Uint8Array(zip);
}
