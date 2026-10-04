/**
 * The admin-A server actions and route handlers read the signed-in person through `@/lib/session`, which reads
 * `next/headers`. Tests install a fake header store and choose who is signed in with `actAs(token)`.
 */
import { eq } from "drizzle-orm";
import { createSession, type SessionContext } from "@/server/auth/sessions";
import { newId } from "@/server/crypto";
import { db, roles, users } from "@/server/db";
import { ensureSystemRoles } from "@/server/rbac";
import { ensureSettingsRows } from "@/server/settings";

export const META = { ip: "203.0.113.9", userAgent: "Mozilla/5.0 (Macintosh) Chrome/140.0 Safari/537.36" };

export interface SessionState {
  /** The session cookie value of whoever is "signed in", or null. */
  token: string | null;
}

/**
 * The fake `next/headers` module. In a test file:
 *
 *   const state = vi.hoisted(() => ({ token: null as string | null }));
 *   vi.mock("next/headers", async () => (await import("./helpers")).nextHeadersMock(state));
 *   vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));
 */
export function nextHeadersMock(state: SessionState) {
  return {
    cookies: async () => ({
      get: (name: string) => (state.token ? { name, value: state.token } : undefined),
      set: () => {},
    }),
    headers: async () => new Headers({ "user-agent": META.userAgent, "x-pathname": "/admin" }),
  };
}

export async function seed(): Promise<void> {
  await ensureSystemRoles();
  await ensureSettingsRows();
}

export interface Person {
  ctx: SessionContext;
  /** The session cookie value: hand it to `actAs`. */
  token: string;
}

let counter = 0;

/** A person with the given role (key or id) and one session. */
export async function person(opts: { email?: string; role?: string; roleId?: string; status?: "active" | "suspended"; name?: string | null } = {}): Promise<Person> {
  const [role] = await db
    .select()
    .from(roles)
    .where(opts.roleId ? eq(roles.id, opts.roleId) : eq(roles.key, opts.role ?? "member"));
  if (!role) throw new Error(`No role ${opts.roleId ?? opts.role}`);
  const [user] = await db
    .insert(users)
    .values({
      id: newId("usr"),
      email: opts.email ?? `person${++counter}@example.com`,
      name: opts.name ?? null,
      roleId: role.id,
      status: opts.status ?? "active",
    })
    .returning();
  const { token, session } = await createSession(user!.id, META);
  return { ctx: { session, user: user!, role }, token };
}
