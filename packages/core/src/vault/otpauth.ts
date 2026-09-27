/**
 * Parsing of 2FA enrollment data:
 *  - RFC 4648 base32 (the encoding of TOTP secrets)
 *  - `otpauth://totp/...` Key URIs (the content of 2FA QR codes)
 *  - `otpauth-migration://offline?data=...` Google Authenticator "Transfer accounts" exports
 *    (a base64 protobuf, decoded with a tiny hand-written reader — no protobuf dependency).
 */
import type { TotpAlgorithm } from "@godmode/shared";
import { badRequest, truncate } from "../util";

/* ------------------------------------------------------------------ */
/* Base32 (RFC 4648)                                                    */
/* ------------------------------------------------------------------ */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(data: Uint8Array, opts: { padding?: boolean } = {}): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  if (opts.padding) while (out.length % 8 !== 0) out += "=";
  return out;
}

/**
 * Decode base32. Tolerates lowercase, whitespace, dashes (grouping as shown by some sites) and
 * missing padding. Throws 400 on any other character. Trailing bits that don't fill a byte are dropped.
 */
export function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/[\s-]/g, "").toUpperCase().replace(/=+$/, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw badRequest("Secret is not valid base32 (allowed characters: A–Z and 2–7)");
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Canonical form of a TOTP secret (uppercase, no separators, no padding). Throws 400 when invalid or empty. */
export function normalizeBase32Secret(input: string): string {
  const bytes = base32Decode(input);
  if (bytes.length === 0) throw badRequest("TOTP secret is empty");
  return base32Encode(bytes);
}

/* ------------------------------------------------------------------ */
/* Parsed accounts                                                      */
/* ------------------------------------------------------------------ */

export interface ParsedOtpAccount {
  issuer: string;
  accountName: string;
  /** Canonical base32 secret */
  secret: string;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
}

/** One account found in a URI: either usable, or skipped with a human-readable reason. */
export type ParsedOtpItem = { ok: true; label: string; account: ParsedOtpAccount } | { ok: false; label: string; reason: string };

export const HOTP_UNSUPPORTED = "HOTP counters are not supported";

function labelOf(issuer: string, accountName: string): string {
  if (issuer && accountName) return `${issuer}:${accountName}`;
  return issuer || accountName;
}

/** Split an "Issuer:account" label. The explicit issuer (URI param / protobuf field) wins over the label prefix. */
function splitLabel(label: string, explicitIssuer: string): { issuer: string; accountName: string } {
  const idx = label.indexOf(":");
  if (idx === -1) return { issuer: explicitIssuer, accountName: label.trim() };
  const prefix = label.slice(0, idx).trim();
  const accountName = label.slice(idx + 1).trim();
  return { issuer: explicitIssuer || prefix, accountName };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** A form of an import input that is safe to echo back: `secret`/`data` values are masked, anything else is shortened. */
export function redactOtpUri(uri: string): string {
  if (/^otpauth(-migration)?:/i.test(uri)) return truncate(uri.replace(/([?&](?:secret|data)=)[^&#]*/gi, "$1•••"), 300);
  return truncate(uri, 24);
}

/** Parse one URI. `otpauth://` yields one item, `otpauth-migration://` yields one item per exported account. Throws 400 when malformed. */
export function parseOtpUri(uri: string): ParsedOtpItem[] {
  const trimmed = uri.trim();
  if (/^otpauth-migration:/i.test(trimmed)) return parseMigrationUri(trimmed);
  if (/^otpauth:/i.test(trimmed)) return [parseOtpauthUri(trimmed)];
  throw badRequest("Not an otpauth:// or otpauth-migration:// URI");
}

/* ------------------------------------------------------------------ */
/* otpauth://                                                           */
/* ------------------------------------------------------------------ */

function parseAlgorithm(raw: string | null): TotpAlgorithm {
  if (!raw) return "SHA1";
  const normalized = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized === "SHA1" || normalized === "SHA256" || normalized === "SHA512") return normalized;
  throw badRequest(`Unsupported algorithm "${raw.slice(0, 20)}"`);
}

function parseDigits(raw: string | null): number {
  if (!raw) return 6;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 6 || n > 8) throw badRequest(`Unsupported number of digits "${raw.slice(0, 10)}" (6–8 supported)`);
  return n;
}

function parsePeriod(raw: string | null): number {
  if (!raw) return 30;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 3600) throw badRequest(`Invalid period "${raw.slice(0, 10)}"`);
  return n;
}

function parseOtpauthUri(uri: string): ParsedOtpItem {
  const m = /^otpauth:\/\/([^/?#]+)\/?([^?#]*)(?:\?([^#]*))?/i.exec(uri);
  if (!m) throw badRequest("Malformed otpauth:// URI");
  const type = m[1]!.toLowerCase();
  const params = new URLSearchParams(m[3] ?? "");
  const { issuer, accountName } = splitLabel(safeDecode(m[2] ?? ""), (params.get("issuer") ?? "").trim());
  const label = labelOf(issuer, accountName);
  if (type === "hotp") return { ok: false, label, reason: HOTP_UNSUPPORTED };
  if (type !== "totp") throw badRequest(`Unsupported OTP type "${type.slice(0, 20)}"`);
  const secretParam = params.get("secret");
  if (!secretParam) throw badRequest("otpauth URI has no secret");
  return {
    ok: true,
    label,
    account: {
      issuer,
      accountName,
      secret: normalizeBase32Secret(secretParam),
      algorithm: parseAlgorithm(params.get("algorithm")),
      digits: parseDigits(params.get("digits")),
      period: parsePeriod(params.get("period")),
    },
  };
}

/* ------------------------------------------------------------------ */
/* otpauth-migration:// (Google Authenticator export)                   */
/* ------------------------------------------------------------------ */

/**
 * Minimal protobuf wire-format reader (proto3): varint, 64-bit, length-delimited and 32-bit fields.
 */
class ProtoReader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  eof(): boolean {
    return this.pos >= this.buf.length;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.buf.length) throw new Error("truncated varint");
      const byte = this.buf[this.pos++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new Error("varint too long");
  }

  tag(): { field: number; wire: number } {
    const key = Number(this.varint());
    if (key >>> 3 === 0) throw new Error("invalid field number 0");
    return { field: key >>> 3, wire: key & 7 };
  }

  bytes(): Uint8Array {
    const len = Number(this.varint());
    if (len < 0 || this.pos + len > this.buf.length) throw new Error("truncated length-delimited field");
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  skip(wire: number): void {
    switch (wire) {
      case 0:
        this.varint();
        return;
      case 1:
        this.advance(8);
        return;
      case 2:
        this.bytes();
        return;
      case 5:
        this.advance(4);
        return;
      default:
        throw new Error(`unsupported wire type ${wire}`);
    }
  }

  private advance(n: number) {
    if (this.pos + n > this.buf.length) throw new Error("truncated fixed-width field");
    this.pos += n;
  }
}

interface MigrationOtpParameters {
  secret: Uint8Array;
  name: string;
  issuer: string;
  algorithm: number;
  digits: number;
  type: number;
}

export interface MigrationPayload {
  otpParameters: MigrationOtpParameters[];
  version: number;
  batchSize: number;
  batchIndex: number;
  batchId: number;
}

const utf8 = new TextDecoder("utf-8");

function readOtpParameters(buf: Uint8Array): MigrationOtpParameters {
  const r = new ProtoReader(buf);
  const out: MigrationOtpParameters = { secret: new Uint8Array(), name: "", issuer: "", algorithm: 0, digits: 0, type: 0 };
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) out.secret = r.bytes();
    else if (field === 2 && wire === 2) out.name = utf8.decode(r.bytes());
    else if (field === 3 && wire === 2) out.issuer = utf8.decode(r.bytes());
    else if (field === 4 && wire === 0) out.algorithm = Number(r.varint());
    else if (field === 5 && wire === 0) out.digits = Number(r.varint());
    else if (field === 6 && wire === 0) out.type = Number(r.varint());
    else r.skip(wire); // includes 7: counter (HOTP only)
  }
  return out;
}

/** Decode the protobuf `MigrationPayload` message of a Google Authenticator export. */
export function decodeMigrationPayload(buf: Uint8Array): MigrationPayload {
  const r = new ProtoReader(buf);
  const out: MigrationPayload = { otpParameters: [], version: 0, batchSize: 0, batchIndex: 0, batchId: 0 };
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) out.otpParameters.push(readOtpParameters(r.bytes()));
    else if (field === 2 && wire === 0) out.version = Number(BigInt.asIntN(32, r.varint()));
    else if (field === 3 && wire === 0) out.batchSize = Number(BigInt.asIntN(32, r.varint()));
    else if (field === 4 && wire === 0) out.batchIndex = Number(BigInt.asIntN(32, r.varint()));
    else if (field === 5 && wire === 0) out.batchId = Number(BigInt.asIntN(32, r.varint()));
    else r.skip(wire);
  }
  return out;
}

const MIGRATION_ALGORITHMS: Record<number, TotpAlgorithm | undefined> = { 0: "SHA1", 1: "SHA1", 2: "SHA256", 3: "SHA512" };
const MIGRATION_DIGITS: Record<number, number | undefined> = { 0: 6, 1: 6, 2: 8 };

function migrationItem(p: MigrationOtpParameters): ParsedOtpItem {
  const { issuer, accountName } = splitLabel(p.name, p.issuer.trim());
  const label = labelOf(issuer, accountName);
  if (p.type === 1) return { ok: false, label, reason: HOTP_UNSUPPORTED };
  if (p.type !== 0 && p.type !== 2) return { ok: false, label, reason: "Unknown OTP type" };
  const algorithm = MIGRATION_ALGORITHMS[p.algorithm];
  if (!algorithm) return { ok: false, label, reason: p.algorithm === 4 ? "MD5 algorithm is not supported" : "Unknown algorithm" };
  const digits = MIGRATION_DIGITS[p.digits];
  if (!digits) return { ok: false, label, reason: "Unsupported number of digits" };
  if (p.secret.length === 0) return { ok: false, label, reason: "Entry has no secret" };
  return { ok: true, label, account: { issuer, accountName, secret: base32Encode(p.secret), algorithm, digits, period: 30 } };
}

function parseMigrationUri(uri: string): ParsedOtpItem[] {
  const query = uri.split("#")[0]!.split("?").slice(1).join("?");
  // Read `data` raw: form-decoding would turn base64 "+" into spaces.
  const raw = query
    .split("&")
    .find((part) => part.startsWith("data="))
    ?.slice(5);
  if (!raw) throw badRequest("Migration URI has no data parameter");
  const b64 = safeDecode(raw).replace(/ /g, "+");
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) throw badRequest("Migration data is not valid base64");
  let payload: MigrationPayload;
  try {
    payload = decodeMigrationPayload(Buffer.from(b64, "base64"));
  } catch {
    throw badRequest("Migration data could not be decoded");
  }
  if (payload.otpParameters.length === 0) throw badRequest("Migration data contains no accounts");
  return payload.otpParameters.map(migrationItem);
}
