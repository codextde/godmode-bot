/**
 * First run. A fresh instance on the public internet must not be claimable by whoever finds it first, so claiming
 * needs the setup code printed to the server log (and written to `<dataDir>/setup-code.txt`).
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { asc, count, eq, sql } from "drizzle-orm";
import { actorOf, audit } from "./audit";
import { normalizeEmail } from "./auth/policy";
import { createSession, type SessionContext } from "./auth/sessions";
import { ensureDefaultPlans } from "./billing/plans";
import { config } from "./config";
import { keyedHash, newId, newSetupCode, safeEqual } from "./crypto";
import { db, users, type User } from "./db";
import { badRequest, conflict, forbidden, tooMany } from "./errors";
import { rateLimit } from "./ratelimit";
import { ensureSystemRoles, isOwner, OWNER_ROLE_ID } from "./rbac";
import { ensureSettingsRows, getSettings, getSettingsWithSecrets, updateSetupState } from "./settings";
import { shared } from "./shared";

/** "claim": nobody has an account yet. "wizard": the owner exists, setup is not finished. "done": finished. */
export type SetupGate = "claim" | "wizard" | "done";

const GATE_REFRESH_MS = 10_000;

const gate = () => shared<{ value: SetupGate | null; at: number }>("setupGate", () => ({ value: null, at: 0 }));

function setGate(value: SetupGate): void {
  Object.assign(gate(), { value, at: Date.now() });
}

function setupCodeFile(): string {
  return path.join(config().dataDir, "setup-code.txt");
}

async function userCount(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(users);
  return row?.n ?? 0;
}

/**
 * Where the instance stands, for the proxy's setup redirect. Cached process-wide: "done" for good, the others for a
 * few seconds (claiming and finishing update it directly), so page requests do not query the database.
 */
export async function setupGate(): Promise<SetupGate> {
  const state = gate();
  if (state.value === "done" || (state.value && Date.now() - state.at < GATE_REFRESH_MS)) return state.value;
  const setup = await getSettings("setup");
  const value: SetupGate = setup.completedAt ? "done" : (await userCount()) > 0 ? "wizard" : "claim";
  setGate(value);
  return value;
}

export async function isSetupComplete(): Promise<boolean> {
  return (await setupGate()) === "done";
}

/** "d••••@solakon.de": who started setup, for a signed-out visitor of /setup. */
export async function setupStartedBy(): Promise<string | null> {
  const [owner] = await db.select({ email: users.email }).from(users).where(eq(users.roleId, OWNER_ROLE_ID)).orderBy(asc(users.createdAt)).limit(1);
  if (!owner) return null;
  const [local, domain] = owner.email.split("@") as [string, string];
  return `${local.slice(0, 1)}${"•".repeat(Math.max(local.length - 1, 3))}@${domain}`;
}

/**
 * At boot: while nobody has an account, creates a new setup code, stores its keyed hash and writes it to
 * `setup-code.txt` (0600). Returns it for the boot banner, or null once someone has claimed the instance.
 */
export async function ensureSetupCode(): Promise<string | null> {
  if ((await userCount()) > 0) {
    const setup = await getSettingsWithSecrets("setup");
    if (setup.codeHash) await updateSetupState({ codeHash: null });
    rmSync(setupCodeFile(), { force: true });
    return null;
  }
  const code = newSetupCode();
  await updateSetupState({ codeHash: keyedHash("setup-code", code) });
  mkdirSync(config().dataDir, { recursive: true });
  writeFileSync(setupCodeFile(), `${code}\n`, { mode: 0o600 });
  chmodSync(setupCodeFile(), 0o600);
  return code;
}

/** "kqzm 7hpd-3xwa" → "KQZM-7HPD-3XWA"; null when it cannot be a setup code. */
function normalizeSetupCode(value: string): string | null {
  const plain = String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (plain.length !== 12) return null;
  return `${plain.slice(0, 4)}-${plain.slice(4, 8)}-${plain.slice(8)}`;
}

/**
 * Step 1: creates the first owner and signs them in. Works only while nobody has an account; the check and the insert
 * run under one advisory lock, so two claims at once give exactly one owner.
 */
export async function claimSetup(
  input: { code: string; email: string; name: string },
  meta: { ip: string; userAgent: string | null },
): Promise<{ user: User; sessionToken: string; expires: Date }> {
  if (!rateLimit(`setup:ip:${meta.ip}`, 10, 15 * 60_000).ok) throw tooMany("Too many attempts. Wait a few minutes and try again.");
  const email = normalizeEmail(input.email);
  const name = String(input.name ?? "").trim();
  if (!name) throw badRequest("Enter your name.");
  if (name.length > 80) throw badRequest("Keep your name under 80 characters.");
  const { codeHash } = await getSettingsWithSecrets("setup");
  if (!codeHash) throw conflict("This cloud has already been set up, or no setup code is active. Restart the server to print one.", "no_setup_code");
  const code = normalizeSetupCode(input.code);
  if (!code || !safeEqual(codeHash, keyedHash("setup-code", code))) {
    throw badRequest("That setup code is not right. Copy it from the server log or from setup-code.txt in the data folder.", "wrong_setup_code");
  }
  await ensureSystemRoles();
  const user = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('godmode-cloud'), hashtext('setup-claim'))`);
    const [row] = await tx.select({ n: count() }).from(users);
    if (row && row.n > 0) throw conflict("This cloud has already been set up. Sign in instead.", "already_claimed");
    const [created] = await tx.insert(users).values({ id: newId("usr"), email, name, roleId: OWNER_ROLE_ID, lastLoginAt: new Date() }).returning();
    return created!;
  });
  await updateSetupState({ codeHash: null });
  rmSync(setupCodeFile(), { force: true });
  setGate("wizard");
  const { token, session } = await createSession(user.id, meta);
  await audit({ id: user.id, label: user.email, ip: meta.ip }, "setup.claim", { type: "user", id: user.id });
  return { user, sessionToken: token, expires: session.expiresAt };
}

function requireOwner(ctx: SessionContext): void {
  if (!isOwner(ctx)) throw forbidden("Only an owner can continue the setup.");
}

/** Remembers a finished or skipped wizard step (for the setup checklist on the admin overview). */
export async function markSetupStep(step: "email" | "access" | "billing", ctx: SessionContext): Promise<void> {
  requireOwner(ctx);
  if (step === "email") await updateSetupState({ emailDone: true });
  else if (step === "access") await updateSetupState({ accessDone: true });
  else if (step === "billing") await updateSetupState({ billingDone: true });
  else throw badRequest("Unknown setup step.");
}

export async function finishSetup(ctx: SessionContext): Promise<void> {
  requireOwner(ctx);
  const setup = await getSettings("setup");
  if (!setup.completedAt) await updateSetupState({ completedAt: new Date().toISOString() });
  setGate("done");
  await audit(actorOf(ctx), "setup.finish", null);
}

/**
 * Called by the custom server at start (idempotent): built-in roles, a settings row per group, the default plans,
 * and the proxy-trust flag `clientIp` reads.
 */
export async function bootstrapData(): Promise<void> {
  await ensureSystemRoles();
  await ensureSettingsRows();
  await ensureDefaultPlans();
  await getSettings("security");
  gate().value = null;
}

/**
 * Compares the address this request came in on with the configured public address. Sign-in cookies and links only
 * work at the configured one, so the setup page and the admin overview warn (or block) when they differ.
 */
export function publicUrlCheck(headers: { get(name: string): string | null }): {
  ok: boolean;
  requestOrigin: string;
  publicUrl: string;
  configured: boolean;
  https: boolean;
} {
  const { publicUrl, publicUrlConfigured } = config();
  const first = (value: string | null) => value?.split(",")[0]?.trim() || null;
  const proto = (first(headers.get("x-forwarded-proto")) ?? "http").toLowerCase();
  const host = first(headers.get("x-forwarded-host")) ?? first(headers.get("host")) ?? "";
  let requestOrigin = `${proto}://${host}`;
  try {
    requestOrigin = new URL(requestOrigin).origin;
  } catch {
    // Not a valid address: it stays as received and never equals the configured one.
  }
  return { ok: requestOrigin === publicUrl, requestOrigin, publicUrl, configured: publicUrlConfigured, https: publicUrl.startsWith("https://") };
}

