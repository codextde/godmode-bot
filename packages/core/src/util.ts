import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Short, URL-safe, prefixed random id, e.g. `agt_4f9Kd81LmQ2xYz0a`. */
export function newId(prefix: string, length = 16): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return `${prefix}_${out}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function now(): string {
  return new Date().toISOString();
}

export function slugify(input: string): string {
  const s = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "item";
}

/** HTTP error carrying a status code; thrown from services and mapped by the server. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`, "not_found");
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, "bad_request", details);
export const locked = () => new HttpError(423, "Vault is locked. Unlock it to access secrets.", "vault_locked");
export const conflict = (msg: string) => new HttpError(409, msg, "conflict");
export const forbidden = (msg = "Forbidden") => new HttpError(403, msg, "forbidden");

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Normalize a url or domain to a bare hostname (lowercase, no www.). */
export function hostnameOf(input: string): string {
  if (!input) return "";
  let s = input.trim();
  try {
    if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
    return new URL(s).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return input.trim().toLowerCase().replace(/^www\./, "");
  }
}

/** Does `host` match `domain` (exact or subdomain)? */
export function domainMatches(host: string, domain: string): boolean {
  const h = hostnameOf(host);
  const d = hostnameOf(domain);
  if (!h || !d) return false;
  return h === d || h.endsWith(`.${d}`) || d.endsWith(`.${h}`);
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

export function which(bin: string): string | null {
  try {
    return Bun.which(bin) ?? null;
  } catch {
    return null;
  }
}
