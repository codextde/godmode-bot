/**
 * Settings service. One row per group in `settings`; secret fields are stored as `{ "$enc": encryptSecret(plain) }`.
 * Reads are cached for 5 s (process-wide, through `shared`) and the cache is cleared on every write.
 *
 * `getSettings` is what pages may see (secrets redacted). `getSettingsWithSecrets` is for src/server only (mail,
 * Stripe, webhook) and its result must never reach a page or a client component.
 */
import { and, eq, gt, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import type { SessionContext } from "../auth/sessions";
import { actorOf, audit, type Actor } from "../audit";
import { decryptSecret, encryptSecret } from "../crypto";
import { db, roles, sessions, settings as settingsTable, users } from "../db";
import { badRequest, forbidden } from "../errors";
import { setProxyTrust } from "../ratelimit";
import { can, canGrantRole, OWNER_ROLE_ID, OWNER_ROLE_KEY, SETTINGS_PERMISSIONS } from "../rbac/permissions";
import { shared } from "../shared";
import {
  SECRET_FIELDS,
  SETTINGS_DEFAULTS,
  SETTINGS_SCHEMAS,
  type AllSettings,
  type RedactedSettings,
  type SecuritySettings,
  type SettingsGroup,
  type SettingsPatch,
  type SetupSettings,
} from "./registry";

export * from "./registry";

const CACHE_MS = 5_000;

type Cache = Map<SettingsGroup, { value: unknown; at: number }>;

const cache = () => shared<Cache>("settings", () => new Map());

type Plain = Record<string, unknown>;

function secretFields(group: SettingsGroup): readonly string[] {
  return SECRET_FIELDS[group] as readonly string[];
}

function openSecret(group: SettingsGroup, field: string, stored: unknown): string {
  if (stored && typeof stored === "object" && typeof (stored as { $enc?: unknown }).$enc === "string") {
    const plain = decryptSecret((stored as { $enc: string }).$enc);
    if (plain === null) {
      console.warn(`[settings] ${group}.${field} was stored with a different APP_SECRET and is treated as not set.`);
      return "";
    }
    return plain;
  }
  return typeof stored === "string" ? stored : "";
}

/** Stored JSON → a complete, valid value. Fields that no longer validate fall back to their defaults. */
function decode<K extends SettingsGroup>(group: K, stored: Plain | null): AllSettings[K] {
  const defaults = SETTINGS_DEFAULTS[group] as unknown as Plain;
  const merged: Plain = { ...defaults, ...(stored ?? {}) };
  for (const field of secretFields(group)) merged[field] = openSecret(group, field, merged[field]);
  const schema = SETTINGS_SCHEMAS[group];
  const first = schema.safeParse(merged);
  if (first.success) return first.data;
  const broken = new Set(first.error.issues.map((i) => String(i.path[0] ?? "")));
  console.warn(`[settings] ${group}: invalid stored values for ${[...broken].join(", ")}; using the defaults for them.`);
  for (const field of broken) if (field in defaults) merged[field] = defaults[field];
  const second = schema.safeParse(merged);
  return second.success ? second.data : structuredClone(SETTINGS_DEFAULTS[group]);
}

function encode(group: SettingsGroup, value: unknown): Plain {
  const out: Plain = { ...(value as Plain) };
  for (const field of secretFields(group)) {
    const plain = out[field];
    out[field] = typeof plain === "string" && plain !== "" ? { $enc: encryptSecret(plain) } : "";
  }
  return out;
}

async function load<K extends SettingsGroup>(group: K): Promise<AllSettings[K]> {
  const hit = cache().get(group);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as AllSettings[K];
  const [row] = await db.select({ value: settingsTable.value }).from(settingsTable).where(eq(settingsTable.key, group)).limit(1);
  const value = decode(group, row?.value ?? null);
  cache().set(group, { value, at: Date.now() });
  if (group === "security") setProxyTrust(value as SecuritySettings);
  return value;
}

/** For forms: secret fields come back as "" plus `<field>Set: boolean`. */
export function redactSettings<K extends SettingsGroup>(group: K, value: AllSettings[K]): RedactedSettings<K> {
  const out: Plain = structuredClone(value as unknown as Plain);
  for (const field of secretFields(group)) {
    out[`${field}Set`] = typeof out[field] === "string" && out[field] !== "";
    out[field] = "";
  }
  return out as RedactedSettings<K>;
}

/** The redacted settings of a group. Safe to pass to pages and client components. */
export async function getSettings<K extends SettingsGroup>(group: K): Promise<RedactedSettings<K>> {
  return redactSettings(group, await load(group));
}

/** Decrypted values. Only for src/server (mail, Stripe, webhook); never return the result to a page. */
export async function getSettingsWithSecrets<K extends SettingsGroup>(group: K): Promise<AllSettings[K]> {
  return structuredClone(await load(group));
}

/** For tests and after restoring a backup. */
export function clearSettingsCache(): void {
  cache().clear();
}

async function persist<K extends SettingsGroup>(group: K, patch: SettingsPatch<K>, actor: Actor | null): Promise<AllSettings[K]> {
  const defaults = SETTINGS_DEFAULTS[group] as unknown as Plain;
  const secrets = secretFields(group);
  let changed: string[] = [];
  let revoked = 0;
  const value = await db.transaction(async (tx) => {
    // Lock the row so two saves of the same group cannot overwrite each other's fields.
    await tx.insert(settingsTable).values({ key: group, value: encode(group, defaults) }).onConflictDoNothing();
    const [row] = await tx.select().from(settingsTable).where(eq(settingsTable.key, group)).for("update");
    const current = decode(group, row?.value ?? null) as unknown as Plain;
    const next: Plain = { ...current };
    for (const [field, raw] of Object.entries(patch as Plain)) {
      if (raw === undefined || !(field in defaults)) continue;
      if (secrets.includes(field)) {
        if (raw === "") continue;
        next[field] = raw === null ? "" : raw;
      } else {
        next[field] = raw;
      }
    }
    const parsed = SETTINGS_SCHEMAS[group].parse(next) as unknown as Plain;
    await validateAcrossGroups(group, parsed);
    changed = Object.keys(defaults).filter((f) => JSON.stringify(parsed[f]) !== JSON.stringify(current[f]));
    if (!changed.length) return parsed;
    await tx
      .update(settingsTable)
      .set({ value: encode(group, parsed), updatedAt: new Date(), updatedBy: actor?.id ?? null })
      .where(eq(settingsTable.key, group));
    if (group === "auth" && changed.includes("allowedDomains")) {
      const domains = parsed.allowedDomains as string[];
      // Year-long sessions must not outlive the domain rule that let them in. Owners are never locked out.
      if (domains.length) {
        const rows = await tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(
            and(
              isNull(sessions.revokedAt),
              gt(sessions.expiresAt, sql`now()`),
              inArray(
                sessions.userId,
                tx
                  .select({ id: users.id })
                  .from(users)
                  .where(and(ne(users.roleId, OWNER_ROLE_ID), notInArray(sql`split_part(${users.email}, '@', 2)`, domains))),
              ),
            ),
          )
          .returning({ id: sessions.id });
        revoked = rows.length;
      }
    }
    return parsed;
  });
  cache().delete(group);
  const result = value as unknown as AllSettings[K];
  if (group === "security") setProxyTrust(result as SecuritySettings);
  if (changed.length && actor) {
    const meta: Plain = { group, fields: changed };
    if (group === "auth" && changed.includes("allowedDomains")) meta.sessionsRevoked = revoked;
    await audit(actor, "settings.update", { type: "settings", id: group }, meta);
  }
  return result;
}

async function validateAcrossGroups(group: SettingsGroup, value: Plain): Promise<void> {
  if (group === "billing" && value.requireTermsConsent === true) {
    const general = await load("general");
    if (!general.termsUrl) throw badRequest("Add a link to your terms under Settings → General before asking for consent.");
  }
  if (group === "auth") {
    const key = value.defaultRoleKey as string;
    const [role] = await db.select().from(roles).where(eq(roles.key, key)).limit(1);
    if (!role) throw badRequest("Choose an existing role for people who sign up on their own.");
    if (role.key === OWNER_ROLE_KEY || role.permissions.includes("admin.access")) {
      throw badRequest("People who sign up on their own must get a role without access to the admin area.");
    }
  }
  if (group === "email" && value.transport === "smtp" && (!value.host || !value.fromEmail)) {
    throw badRequest("Enter the SMTP server and a sender address before switching to SMTP.");
  }
}

/**
 * Saves a settings group for someone signed in. Who may edit what: General and Relay need `settings.manage`, Billing
 * needs `billing.manage`, and Sign-in, E-mail and Security only owners (they decide who can sign in as whom).
 * Returns the redacted value.
 */
export async function updateSettings<K extends SettingsGroup>(group: K, patch: SettingsPatch<K>, ctx: SessionContext): Promise<RedactedSettings<K>> {
  if (group === "setup") throw forbidden("Setup progress is saved by the setup wizard.");
  const needed = SETTINGS_PERMISSIONS[group as Exclude<SettingsGroup, "setup">];
  if (!can(ctx, needed)) {
    throw forbidden(needed === "owner" ? "Only an owner can change these settings." : "You don't have permission to change these settings.");
  }
  const roleKey = (patch as Partial<AllSettings["auth"]>).defaultRoleKey;
  if (group === "auth" && roleKey) {
    const [role] = await db.select().from(roles).where(eq(roles.key, roleKey)).limit(1);
    if (role && !canGrantRole(ctx, role)) throw forbidden("You can only choose a role whose permissions you have yourself.");
  }
  return redactSettings(group, await persist(group, patch, actorOf(ctx)));
}

/** For the server itself (boot, Stripe, the wizard's internal steps): no permission check, audited as `actor`. */
export async function writeSettings<K extends SettingsGroup>(group: K, patch: SettingsPatch<K>, actor: Actor): Promise<AllSettings[K]> {
  return persist(group, patch, actor);
}

/** Setup progress (internal, not audited). */
export async function updateSetupState(patch: Partial<SetupSettings>): Promise<SetupSettings> {
  return persist("setup", patch, null);
}

/** Writes the default row of every group that has none yet. Idempotent. */
export async function ensureSettingsRows(): Promise<void> {
  for (const group of Object.keys(SETTINGS_DEFAULTS) as SettingsGroup[]) {
    await db.insert(settingsTable).values({ key: group, value: encode(group, SETTINGS_DEFAULTS[group]) }).onConflictDoNothing();
  }
  cache().clear();
}
