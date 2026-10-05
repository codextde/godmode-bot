/** Shared setup for the platform tests: seeded roles and settings, and people with a session. */
import { eq } from "drizzle-orm";
import { createSession, type SessionContext } from "@/server/auth/sessions";
import { newId } from "@/server/crypto";
import { auditLog, db, devices, roles, users } from "@/server/db";
import { ensureSystemRoles } from "@/server/rbac";
import { ensureSettingsRows } from "@/server/settings";

export const META = {
  ip: "203.0.113.9",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
};

export async function seed(): Promise<void> {
  await ensureSystemRoles();
  await ensureSettingsRows();
}

let counter = 0;

/** A person with the given role (key) and one session, as a SessionContext. */
export async function makeUser(
  opts: { email?: string; role?: string; status?: "active" | "suspended"; name?: string | null } = {},
): Promise<SessionContext> {
  const [role] = await db.select().from(roles).where(eq(roles.key, opts.role ?? "member"));
  if (!role) throw new Error(`No role ${opts.role}`);
  const [user] = await db
    .insert(users)
    .values({ id: newId("usr"), email: opts.email ?? `person${++counter}@example.com`, name: opts.name ?? null, roleId: role.id, status: opts.status ?? "active" })
    .returning();
  const { session } = await createSession(user!.id, META);
  return { session, user: user!, role };
}

export async function makeDevice(userId: string): Promise<string> {
  const id = `dvc_${newId("x").slice(2)}`;
  await db.insert(devices).values({ id, userId, name: "Test Mac", instanceId: newId("gm"), secretHash: "0".repeat(64) });
  return id;
}

export async function auditRows(action: string) {
  return db.select().from(auditLog).where(eq(auditLog.action, action));
}
