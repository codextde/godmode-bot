/**
 * Process configuration. The only value an operator sets is the domain (DOMAIN in .env, or the domain field in
 * Coolify). Everything else has a working default or is generated on first start; all product configuration lives in
 * the database and is edited in the admin dashboard (src/server/settings).
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface Config {
  env: "development" | "production" | "test";
  /** Listen address (HOST; never HOSTNAME, which Docker sets to the container id). */
  hostname: string;
  port: number;
  /** Where people reach this site, without a trailing slash: "https://cloud.example.com". */
  publicUrl: string;
  /** True when DOMAIN (or Coolify's SERVICE_URL_CLOUD) was given, so `publicUrl` is not a guess. */
  publicUrlConfigured: boolean;
  databaseUrl: string;
  /** Files this instance owns: the generated secret, the setup code. */
  dataDir: string;
  /** Root key for encrypting secrets at rest and signing. Never shown anywhere. */
  appSecret: string;
  /** The built Godmode dashboard (apps/desktop `build:cloud`), served under /ui and /d/<computer>/. */
  uiDir: string;
  /** The app directory (apps/cloud in development, /app in the image). */
  appDir: string;
}

function fileOrEnv(name: string): string | null {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  const file = process.env[`${name}_FILE`]?.trim();
  if (file && existsSync(file)) {
    const value = readFileSync(file, "utf8").trim();
    if (value) return value;
  }
  return null;
}

function isLocalHost(host: string): boolean {
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]" || name.endsWith(".localhost");
}

/** "cloud.example.com", "https://cloud.example.com/" and Coolify's comma-separated list all become one origin. */
export function normalizePublicUrl(value: string): string | null {
  const first = value.split(",")[0]?.trim();
  if (!first) return null;
  const withScheme = /^https?:\/\//i.test(first) ? first : `${isLocalHost(first) ? "http" : "https"}://${first}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (url) return url;
  const host = process.env.DATABASE_HOST?.trim();
  if (host) {
    const user = encodeURIComponent(process.env.DATABASE_USER?.trim() || "godmode");
    const password = fileOrEnv("DATABASE_PASSWORD");
    const name = encodeURIComponent(process.env.DATABASE_NAME?.trim() || "godmode");
    const port = process.env.DATABASE_PORT?.trim() || "5432";
    const auth = password ? `${user}:${encodeURIComponent(password)}` : user;
    return `postgres://${auth}@${host}:${port}/${name}`;
  }
  // A developer's local PostgreSQL.
  return "postgres://localhost:5432/godmode_cloud_dev";
}

function resolveAppSecret(dataDir: string): string {
  const fromFile = process.env.APP_SECRET_FILE?.trim();
  if (fromFile && !process.env.APP_SECRET?.trim()) {
    // A configured file that is not there yet must not silently get a different key: secrets stored with it would
    // stop decrypting once the real file appears.
    const value = existsSync(fromFile) ? readFileSync(fromFile, "utf8").trim() : "";
    if (!value) throw new Error(`APP_SECRET_FILE is set but ${fromFile} is missing or empty.`);
  }
  const given = fileOrEnv("APP_SECRET");
  if (given) {
    if (given.length < 32) throw new Error("APP_SECRET must be at least 32 characters.");
    return given;
  }
  // Nothing provided: make one and keep it, so a plain `docker run` or `pnpm dev` works without configuration.
  const file = path.join(dataDir, "app-secret");
  if (existsSync(file)) {
    const value = readFileSync(file, "utf8").trim();
    if (value.length >= 32) return value;
  }
  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(48).toString("base64url");
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return secret;
}

let cached: Config | null = null;

export function config(): Config {
  if (cached) return cached;
  const nodeEnv = process.env.NODE_ENV;
  const env: Config["env"] = nodeEnv === "production" ? "production" : nodeEnv === "test" ? "test" : "development";
  const port = Number(process.env.PORT) || 3000;
  const appDir = path.resolve(/*turbopackIgnore: true*/ process.env.CLOUD_APP_DIR?.trim() || process.cwd());
  const dataDir = path.resolve(
    /*turbopackIgnore: true*/ process.env.DATA_DIR?.trim() || (env === "production" ? "/data" : path.join(/*turbopackIgnore: true*/ appDir, ".data")),
  );
  const configured =
    normalizePublicUrl(process.env.DOMAIN ?? "") ??
    normalizePublicUrl(process.env.SERVICE_URL_CLOUD ?? "") ??
    normalizePublicUrl(process.env.COOLIFY_URL ?? "");
  cached = {
    env,
    hostname: process.env.HOST?.trim() || "0.0.0.0",
    port,
    publicUrl: configured ?? `http://localhost:${port}`,
    publicUrlConfigured: configured !== null,
    databaseUrl: resolveDatabaseUrl(),
    dataDir,
    appSecret: resolveAppSecret(dataDir),
    uiDir: path.resolve(
      /*turbopackIgnore: true*/ process.env.GODMODE_UI_DIR?.trim() || path.join(/*turbopackIgnore: true*/ appDir, "../desktop/dist-cloud"),
    ),
    appDir,
  };
  return cached;
}

/** Cookies need `Secure` (and may use the `__Host-` prefix) exactly when the site is served over https. */
export function isSecureSite(): boolean {
  return config().publicUrl.startsWith("https://");
}

/** For tests. */
export function resetConfig(): void {
  cached = null;
}
