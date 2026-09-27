/**
 * Password imports: CSV exports of Chrome (and every Chromium browser), 1Password, Bitwarden, Apple Passwords,
 * Firefox, LastPass, Dashlane, Proton Pass and KeePass, plus 1Password's .1pux archive.
 *
 * Rows for the same site + username + password become one login with several domains. Every login is matched
 * against the saved logins of the target scope, so importing the same export twice changes nothing.
 * Nothing is kept between preview and import: the file is parsed again and the selected row ids are applied.
 */
import { strFromU8, unzipSync } from "fflate";
import type {
  Credential,
  PasswordImportPreview,
  PasswordImportResult,
  PasswordImportRow,
  PasswordImportSkipped,
  PasswordImportSource,
} from "@godmode/shared";
import { tx } from "../db";
import { bus } from "../events/bus";
import { HttpError, badRequest, hostnameOf, locked } from "../util";
import * as vault from "./vault";
import { assertWorkspace, getCredential, insertCredential, linkCredentialTotp, listCredentials, patchCredential } from "./credentials";
import { normalizeBase32Secret, parseOtpUri, type ParsedOtpAccount } from "./otpauth";
import { insertTotp, totpReuseKey, unlinkedTotpForImport } from "./totp";

export const MAX_IMPORT_BYTES = 512 * 1024 ** 2;
/** Cap for a CSV, and for the file unpacked from an archive (its declared size is allocated up front). */
const MAX_TEXT_BYTES = 64 * 1024 ** 2;

const LIMITS = { name: 200, url: 2048, username: 512, password: 4096, notes: 20_000, domains: 100, tags: 50, tag: 64 };

/** One entry of an export, before rows of the same login are merged. */
export interface ExportedLogin {
  name: string;
  url: string;
  username: string;
  password: string;
  notes: string;
  /** otpauth:// URI or bare base32 secret */
  otp: string;
  tags: string[];
  /** Why the entry is not a website login (archived, secure note …) */
  skip?: string;
}

export interface ParsedExport {
  source: PasswordImportSource;
  entries: ExportedLogin[];
}

/* ------------------------------------------------------------------ */
/* CSV                                                                  */
/* ------------------------------------------------------------------ */

/** RFC 4180: quoted fields, `""` escapes, line breaks inside quotes. Blank lines are dropped. */
export function parseCsv(text: string, sep = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;
  const endRow = () => {
    row.push(field);
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
    field = "";
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"' && !started) {
      quoted = true;
      started = true;
    } else if (c === sep) {
      row.push(field);
      field = "";
      started = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else {
      field += c;
      started = true;
    }
  }
  if (started || row.length > 0) endRow();
  return rows;
}

/** Header aliases, most specific first. */
const COLUMNS = {
  url: ["url", "login_uri", "login uri", "website", "web site", "web address", "login url", "uri", "origin_url", "hostname"],
  username: ["username", "login_username", "user name", "login name", "login", "user", "email", "e-mail", "email address"],
  password: ["password", "login_password"],
  name: ["name", "title"],
  notes: ["note", "notes", "extra", "comment", "comments"],
  otp: ["otpauth", "login_totp", "totp", "otpsecret", "otp", "one-time password"],
  tags: ["tags", "folder", "group", "grouping"],
  archived: ["archived"],
} as const;

function detectCsvSource(h: Set<string>): PasswordImportSource {
  if (h.has("login_uri")) return "bitwarden";
  if (h.has("httprealm") || h.has("formactionorigin")) return "firefox";
  if (h.has("grouping") && h.has("extra")) return "lastpass";
  if (h.has("username2") || h.has("otpsecret")) return "dashlane";
  if (h.has("vault") && h.has("createtime")) return "protonpass";
  if (h.has("group") && h.has("title")) return "keepass";
  if (h.has("otpauth") && (h.has("archived") || h.has("favorite"))) return "1password";
  if (h.has("otpauth")) return "apple";
  if (h.has("name") && h.has("url") && h.has("username") && h.has("password")) return "chrome";
  return "csv";
}

/** UTF-8, UTF-16 with a byte order mark, or — for older Windows exports — Windows-1252. */
function decodeText(data: Uint8Array): string {
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data);
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return new TextDecoder("windows-1252").decode(data);
  }
}

export function parsePasswordCsv(text: string): ParsedExport {
  const clean = text.replace(/^﻿/, "");
  const firstLine = clean.slice(0, clean.search(/\r?\n|$/));
  const count = (s: string) => firstLine.split(s).length - 1;
  const sep = [",", ";", "\t"].reduce((best, s) => (count(s) > count(best) ? s : best), ",");
  const [header, ...rows] = parseCsv(clean, sep);
  if (!header) throw badRequest("The file is empty");
  const names = header.map((h) => h.trim().toLowerCase());
  const cols = (aliases: readonly string[]) => aliases.map((a) => names.indexOf(a)).filter((i) => i !== -1);
  const url = cols(COLUMNS.url);
  const password = cols(COLUMNS.password);
  if (url.length === 0 || password.length === 0) {
    throw badRequest("This CSV is not a password export — it needs at least a url and a password column");
  }
  const username = cols(COLUMNS.username);
  const name = cols(COLUMNS.name);
  const notes = cols(COLUMNS.notes);
  const otp = cols(COLUMNS.otp);
  const tags = cols(COLUMNS.tags);
  const archived = cols(COLUMNS.archived);
  const pick = (r: string[], idx: number[]) => idx.map((i) => (r[i] ?? "").trim()).find(Boolean) ?? "";
  return {
    source: detectCsvSource(new Set(names)),
    entries: rows.map((r) => ({
      name: pick(r, name),
      url: pick(r, url),
      username: pick(r, username),
      // Taken verbatim: leading and trailing spaces can be part of a password.
      password: password.map((i) => r[i] ?? "").find((p) => p !== "") ?? "",
      notes: pick(r, notes),
      otp: pick(r, otp),
      tags: pick(r, tags)
        .split(/[,;\\/]/)
        .map((t) => t.trim())
        .filter(Boolean),
      skip: /^(true|yes|1)$/i.test(pick(r, archived)) ? "Archived" : undefined,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* 1Password .1pux                                                      */
/* ------------------------------------------------------------------ */

interface OnePuxItem {
  state?: unknown;
  trashed?: unknown;
  categoryUuid?: unknown;
  overview?: { title?: unknown; url?: unknown; urls?: unknown; tags?: unknown };
  details?: { loginFields?: unknown; notesPlain?: unknown; password?: unknown; sections?: unknown };
}

type OnePuxField = { value?: unknown; fieldType?: unknown; designation?: unknown };

/** 001 = Login, 005 = Password; everything else (cards, notes, identities …) is not a website login. */
const ONEPUX_LOGIN_CATEGORIES = new Set(["001", "005"]);

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]).filter((x) => x && typeof x === "object") : []);
const str = (v: unknown) => (typeof v === "string" ? v : "");

export function parse1PuxData(json: string): ParsedExport {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw badRequest("The .1pux file is damaged — its export.data is not valid JSON");
  }
  const entries: ExportedLogin[] = [];
  const accounts = list<{ vaults?: unknown }>((data as { accounts?: unknown } | null)?.accounts);
  for (const v of accounts.flatMap((a) => list<{ items?: unknown }>(a.vaults))) {
    for (const item of list<OnePuxItem>(v.items)) {
      if (item.trashed === true || item.state === "trashed") continue;
      const o = item.overview ?? {};
      const d = item.details ?? {};
      const fields = list<OnePuxField>(d.loginFields);
      const field = (match: (f: OnePuxField) => boolean) => str(fields.find(match)?.value);
      const otp = list<{ fields?: unknown }>(d.sections)
        .flatMap((s) => list<{ value?: { totp?: unknown } }>(s.fields))
        .map((f) => str(f.value?.totp))
        .find(Boolean);
      const urls = [str(o.url), ...list<{ url?: unknown }>(o.urls).map((u) => str(u.url))].map((u) => u.trim()).filter(Boolean);
      const category = str(item.categoryUuid) || "001";
      entries.push({
        name: str(o.title).trim(),
        url: [...new Set(urls)].join(", "),
        username: (field((f) => f.designation === "username") || field((f) => f.fieldType === "E" || f.fieldType === "T")).trim(),
        password: field((f) => f.designation === "password") || str(d.password),
        notes: str(d.notesPlain).trim(),
        otp: (otp ?? "").trim(),
        tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === "string") : [],
        skip: !ONEPUX_LOGIN_CATEGORIES.has(category) ? "Not a login" : item.state === "archived" ? "Archived" : undefined,
      });
    }
  }
  return { source: "1password", entries };
}

const isZip = (data: Uint8Array) => data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
const tooLarge = (what: string) => new HttpError(413, `${what} is larger than 64 MB`, "too_large");

/** Read an uploaded export: a CSV in any supported layout, a .1pux archive, or Dashlane's zip of CSVs. */
export function readPasswordExport(data: Uint8Array): ParsedExport {
  if (data.length === 0) throw badRequest("The file is empty");
  if (!isZip(data)) {
    if (data.length > MAX_TEXT_BYTES) throw tooLarge("The CSV");
    return parsePasswordCsv(decodeText(data));
  }
  const wanted = (name: string) => name === "export.data" || /(^|\/)credentials\.csv$/i.test(name);
  let oversized = false;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter: (f) => {
        if (!wanted(f.name)) return false;
        if (f.originalSize > MAX_TEXT_BYTES) oversized = true;
        return !oversized;
      },
    });
  } catch {
    throw badRequest("The archive could not be read");
  }
  if (oversized) throw tooLarge("The export inside the archive");
  if (files["export.data"]) return parse1PuxData(strFromU8(files["export.data"]));
  const csv = Object.keys(files).find((n) => /credentials\.csv$/i.test(n));
  if (csv) return parsePasswordCsv(decodeText(files[csv]!));
  throw badRequest("This archive is not a 1Password (.1pux) or Dashlane export");
}

/* ------------------------------------------------------------------ */
/* Merge rows into logins                                               */
/* ------------------------------------------------------------------ */

export interface PlannedLogin {
  name: string;
  url: string;
  hosts: string[];
  username: string;
  password: string;
  notes: string;
  tags: string[];
  totp: ParsedOtpAccount | null;
  totpUnreadable: boolean;
  rows: number;
  conflictKey: string | null;
}

/** Two-label public suffixes; everything else is treated as a one-label suffix. */
const SECOND_LEVEL = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "ltd.uk", "plc.uk", "me.uk", "co.at", "or.at", "gv.at", "ac.at", "com.au", "net.au", "org.au",
  "co.nz", "co.jp", "ne.jp", "or.jp", "com.br", "com.cn", "com.tr", "co.za", "com.mx", "co.in", "co.kr", "com.sg", "com.hk", "com.pl",
  "com.es", "co.il", "com.ar",
]);

const isIp = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");

/** Routers, NAS & co.: the same address is another device on another network, so their logins are left out. */
function isLocalHost(host: string): boolean {
  return isIp(host) || host === "localhost" || /\.(local|lan|home|internal|localhost|home\.arpa)$/.test(host) || host === "fritz.box";
}

/** Approximate registrable domain: "accounts.google.com" → "google.com", "shop.foo.co.uk" → "foo.co.uk". */
export function baseDomain(host: string): string {
  const labels = host.split(".");
  if (isIp(host) || labels.length <= 2) return host;
  return labels.slice(SECOND_LEVEL.has(labels.slice(-2).join(".")) ? -3 : -2).join(".");
}

/** Chrome names a login after its host; other managers use a real title. */
export function displayName(name: string, host: string): string {
  const n = name.trim();
  if (n && !/^([a-z][a-z0-9+.-]*:\/\/)?[^\s/]+\.[a-z]{2,}(\/\S*)?$/i.test(n)) return n;
  const label = baseDomain(host).split(".")[0] ?? "";
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : host;
}

/** The export's URL as a login page: http(s) only, without credentials, query, fragment or `;jsessionid=…`. */
function loginUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) return null;
  u.username = "";
  u.password = "";
  u.search = "";
  u.hash = "";
  u.pathname = u.pathname
    .split("/")
    .map((seg) => seg.split(";")[0])
    .join("/");
  return u;
}

/** Bitwarden and 1Password keep several URLs of one login in one field, separated by commas. */
const splitUrls = (raw: string) => raw.split(/,(?=\s*(?:[a-z][a-z0-9+.-]*:\/\/|[a-z0-9-]+\.[a-z]))/i).map((s) => s.trim()).filter(Boolean);

function readTotp(otp: string, name: string, username: string): ParsedOtpAccount | null {
  const account = /^otpauth:/i.test(otp)
    ? parseOtpUri(otp).find((i) => i.ok)?.account
    : { issuer: "", accountName: "", secret: normalizeBase32Secret(otp), algorithm: "SHA1" as const, digits: 6, period: 30 };
  if (!account) return null;
  return {
    ...account,
    issuer: (account.issuer || name).slice(0, 200),
    accountName: (account.accountName || username).slice(0, 512),
  };
}

export function groupLogins(entries: ExportedLogin[]): { logins: PlannedLogin[]; skipped: PasswordImportSkipped[] } {
  let logins: PlannedLogin[] = [];
  const skipped: PasswordImportSkipped[] = [];
  const byKey = new Map<string, PlannedLogin>();
  for (const e of entries) {
    const skip = (reason: string) => skipped.push({ name: e.name.slice(0, LIMITS.name), url: e.url.slice(0, LIMITS.url), username: e.username.slice(0, LIMITS.username), reason });
    if (e.skip) {
      skip(e.skip);
      continue;
    }
    if (/^android:/i.test(e.url)) {
      skip("Android app");
      continue;
    }
    const urls = splitUrls(e.url)
      .map(loginUrl)
      .filter((u): u is URL => !!u)
      .map((u) => ({ u, host: hostnameOf(u.hostname) }))
      .filter((x) => x.host);
    const web = urls.filter((x) => x.host.includes(".") && !isLocalHost(x.host));
    if (web.length === 0) {
      skip(urls.some((x) => isLocalHost(x.host)) ? "Local network address" : "No website address");
      continue;
    }
    const { u, host } = web[0]!;
    const hosts = [...new Set(web.map((x) => x.host))];
    let totp: ParsedOtpAccount | null = null;
    if (e.otp) {
      try {
        totp = readTotp(e.otp, displayName(e.name, host), e.username);
      } catch {
        totp = null;
      }
    }
    const totpUnreadable = !!e.otp && !totp;
    if (!e.password && !totp) {
      skip("No password");
      continue;
    }
    if (e.password.length > LIMITS.password) {
      skip("Password is too long");
      continue;
    }
    const key = `${baseDomain(host)}\u0000${e.username.toLowerCase()}\u0000${e.password}`;
    const same = byKey.get(key);
    if (same) {
      for (const h of hosts) if (!same.hosts.includes(h)) same.hosts.push(h);
      same.totp ??= totp;
      same.totpUnreadable = !same.totp && (same.totpUnreadable || totpUnreadable);
      if (e.notes && !same.notes.includes(e.notes)) same.notes = same.notes ? `${same.notes}\n\n${e.notes}` : e.notes;
      for (const t of e.tags) if (!same.tags.includes(t)) same.tags.push(t);
      same.rows++;
      continue;
    }
    const login: PlannedLogin = {
      name: displayName(e.name, host).slice(0, LIMITS.name),
      url: u.toString().slice(0, LIMITS.url),
      hosts,
      username: e.username.slice(0, LIMITS.username),
      password: e.password,
      notes: e.notes,
      tags: [...e.tags],
      totp,
      totpUnreadable,
      rows: 1,
      conflictKey: null,
    };
    byKey.set(key, login);
    logins.push(login);
  }

  // A 2FA-only entry (no password) completes the password entry of the same account instead of competing with it.
  const siteUser = (l: PlannedLogin) => `${baseDomain(l.hosts[0]!)}\u0000${l.username.toLowerCase()}`;
  logins = logins.filter((l) => {
    if (l.password || !l.totp) return true;
    const partner = logins.find((o) => o !== l && o.password && !o.totp && siteUser(o) === siteUser(l));
    if (!partner) return true;
    partner.totp = l.totp;
    partner.totpUnreadable = false;
    for (const h of l.hosts) if (!partner.hosts.includes(h)) partner.hosts.push(h);
    partner.rows += l.rows;
    return false;
  });

  // The same username on the same host with different passwords: Chrome keeps old ones, so the user picks the
  // current one. Other subdomains (tenants like acme.okta.com / globex.okta.com) are separate accounts.
  const parent = logins.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i]!)));
  const firstWith = new Map<string, number>();
  logins.forEach((l, i) => {
    for (const h of l.hosts) {
      const k = `${h}\u0000${l.username.toLowerCase()}`;
      const j = firstWith.get(k);
      if (j === undefined) firstWith.set(k, i);
      else parent[root(i)] = root(j);
    }
  });
  const groups = new Map<number, PlannedLogin[]>();
  logins.forEach((l, i) => groups.set(root(i), [...(groups.get(root(i)) ?? []), l]));
  let n = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const conflictKey = `c${++n}`;
    for (const l of group) l.conflictKey = conflictKey;
  }

  for (const l of logins) {
    l.notes = l.notes.slice(0, LIMITS.notes);
    l.hosts = l.hosts.slice(0, LIMITS.domains);
    l.tags = l.tags.map((t) => t.slice(0, LIMITS.tag)).slice(0, LIMITS.tags);
  }
  logins.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.username.localeCompare(b.username));
  return { logins, skipped };
}

/* ------------------------------------------------------------------ */
/* Match against the vault                                              */
/* ------------------------------------------------------------------ */

/** Enough of a password to tell competing ones apart, without its length. */
function maskPassword(p: string): string {
  return p.length >= 8 ? `${p[0]}••••••${p[p.length - 1]}` : "••••••";
}

/** A saved domain covers its own host and every subdomain — the same rule the vault uses when it fills a login. */
const covers = (domain: string, host: string) => host === domain || host.endsWith(`.${domain}`);
const coveredBy = (host: string, saved: string[]) => saved.some((d) => covers(d, host));
const savedHosts = (c: Credential) => [...new Set([...c.domains, c.url].map(hostnameOf).filter(Boolean))];
const sameUser = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

interface Planned {
  login: PlannedLogin;
  row: PasswordImportRow;
  existing: Credential | null;
}

/**
 * The saved login each export login updates: one whose domain covers a host of the export login, first with the
 * same username, then one without a username yet — never a saved login for a subdomain the export login does not
 * name. Within a pass the most specific domain wins (github.com beats a parent-domain login for gist.github.com).
 * Rows of one conflict group share a target; each saved login is claimed once.
 */
function matchExisting(logins: PlannedLogin[], existing: Credential[]): (Credential | null)[] {
  const hosts = existing.map(savedHosts);
  const byBase = new Map<string, number[]>();
  hosts.forEach((hs, i) => {
    for (const b of new Set(hs.map(baseDomain))) byBase.set(b, [...(byBase.get(b) ?? []), i]);
  });
  const candidates = logins.map((l) => [...new Set(l.hosts.flatMap((h) => byBase.get(baseDomain(h)) ?? []))]);
  const keyOf = (l: PlannedLogin, li: number) => l.conflictKey ?? `#${li}`;
  /** Length of the saved domain that covers one of the login's hosts; -1 = not on the site. */
  const specificity = (l: PlannedLogin, i: number) => Math.max(-1, ...l.hosts.flatMap((h) => hosts[i]!.filter((d) => covers(d, h)).map((d) => d.length)));
  const passes: ((l: PlannedLogin, i: number) => boolean)[] = [
    (l, i) => !!l.username && sameUser(existing[i]!.username, l.username),
    (_, i) => !existing[i]!.username,
  ];
  const target = new Map<string, number>();
  const claimed = new Set<number>();
  for (const pass of passes) {
    const pairs: { spec: number; li: number; i: number }[] = [];
    logins.forEach((l, li) => {
      if (target.has(keyOf(l, li))) return;
      for (const i of candidates[li]!) {
        const spec = claimed.has(i) || !pass(l, i) ? -1 : specificity(l, i);
        if (spec >= 0) pairs.push({ spec, li, i });
      }
    });
    pairs.sort((a, b) => b.spec - a.spec || a.li - b.li || a.i - b.i);
    for (const { li, i } of pairs) {
      const key = keyOf(logins[li]!, li);
      if (target.has(key) || claimed.has(i)) continue;
      claimed.add(i);
      target.set(key, i);
    }
  }
  return logins.map((l, li) => {
    const i = target.get(keyOf(l, li));
    return i === undefined ? null : existing[i]!;
  });
}

function changesFor(l: PlannedLogin, c: Credential): string[] {
  const saved = savedHosts(c);
  const changes: string[] = [];
  if (l.password && l.password !== (c.password ?? "")) changes.push("password");
  if (l.username && !c.username) changes.push("username");
  if (l.hosts.some((h) => !coveredBy(h, saved))) changes.push("website");
  if (!c.url) changes.push("login URL");
  if (l.notes && !c.notes) changes.push("notes");
  if (l.totp && !c.totpId) changes.push("2FA");
  return changes;
}

function plan(data: Uint8Array, workspaceId: string | null): { source: PasswordImportSource; total: number; planned: Planned[]; skipped: PasswordImportSkipped[] } {
  assertWorkspace(workspaceId);
  if (!vault.isUnlocked()) throw locked();
  const parsed = readPasswordExport(data);
  const { logins, skipped } = groupLogins(parsed.entries);
  const revealed = new Map<string, Credential>();
  const matches = matchExisting(logins, listCredentials({ workspaceId })).map((c) => {
    if (c && !revealed.has(c.id)) revealed.set(c.id, getCredential(c.id, { reveal: true }));
    return c && revealed.get(c.id)!;
  });
  const planned = logins.map((login, id): Planned => {
    const match = matches[id] ?? null;
    const changes = match ? changesFor(login, match) : [];
    return {
      login,
      existing: match,
      row: {
        id,
        name: login.name,
        url: login.url,
        domains: login.hosts,
        username: login.username,
        action: !match ? "new" : changes.length ? "update" : "unchanged",
        existingId: match?.id ?? null,
        existingName: match?.name ?? null,
        changes,
        replacesPassword: !!match?.password && changes.includes("password"),
        hasTotp: !!login.totp,
        rows: login.rows,
        conflictKey: login.conflictKey,
        ...(login.conflictKey ? { passwordHint: login.password ? maskPassword(login.password) : "no password" } : {}),
        ...(login.totpUnreadable ? { warning: "The 2FA secret of this entry could not be read" } : {}),
      },
    };
  });
  return { source: parsed.source, total: parsed.entries.length, planned, skipped };
}

export function previewPasswordImport(data: Uint8Array, workspaceId: string | null): PasswordImportPreview {
  const { source, total, planned, skipped } = plan(data, workspaceId);
  return { source, total, rows: planned.map((p) => p.row), skipped };
}

export function importPasswords(data: Uint8Array, workspaceId: string | null, ids: number[]): PasswordImportResult & { source: PasswordImportSource } {
  const { source, planned } = plan(data, workspaceId);
  const wanted = new Set(ids);
  const selected = planned.filter((p) => wanted.has(p.row.id) && p.row.action !== "unchanged");
  const picked = new Set<string>();
  for (const { row } of selected) {
    if (!row.conflictKey) continue;
    if (picked.has(row.conflictKey)) throw badRequest(`Choose one password for ${row.name}${row.username ? ` (${row.username})` : ""}`);
    picked.add(row.conflictKey);
  }

  const result: PasswordImportResult = { created: 0, updated: 0, totp: 0 };
  tx(() => {
    const spare = unlinkedTotpForImport(workspaceId);
    const totpId = (account: ParsedOtpAccount) => {
      const key = totpReuseKey(account);
      const reuse = spare.get(key);
      spare.delete(key);
      result.totp++;
      return reuse ?? insertTotp(workspaceId, account);
    };
    for (const { login, row, existing } of selected) {
      if (!existing) {
        const id = insertCredential({
          workspaceId,
          name: login.name,
          url: login.url,
          domains: login.hosts,
          username: login.username,
          password: login.password,
          notes: login.notes,
          tags: login.tags,
        });
        if (login.totp) linkCredentialTotp(id, totpId(login.totp));
        result.created++;
        continue;
      }
      const has = (c: string) => row.changes.includes(c);
      const saved = savedHosts(existing);
      patchCredential(existing.id, {
        password: has("password") ? login.password : undefined,
        username: has("username") ? login.username : undefined,
        url: has("login URL") ? login.url : undefined,
        domains: has("website") ? [...existing.domains, ...login.hosts.filter((h) => !coveredBy(h, saved))] : undefined,
        notes: has("notes") ? login.notes : undefined,
      });
      if (has("2FA") && login.totp) linkCredentialTotp(existing.id, totpId(login.totp));
      result.updated++;
    }
  });
  if (result.created || result.updated) bus.changed("credentials");
  if (result.totp) bus.changed("totp");
  return { ...result, source };
}
