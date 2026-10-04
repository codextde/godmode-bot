/** Periodic cleanup. The custom server runs it one minute after start and every 6 hours. */
import { lt, or, sql } from "drizzle-orm";
import { pruneAudit } from "./audit";
import { db, linkRequests, loginTokens, sessions, stripeEvents } from "./db";

async function step(name: string, run: () => Promise<number>): Promise<number> {
  try {
    return await run();
  } catch (err) {
    console.error(`[housekeeping] ${name} failed:`, err instanceof Error ? err.message : err);
    return 0;
  }
}

/**
 * Deletes what nobody needs any more: audit entries past their retention, sign-in e-mails and link requests expired
 * for a day (sign-in rows are kept that long because the per-address code lock counts the last 24 hours), sessions
 * expired or revoked 30 days ago, Stripe event ids older than 30 days. Never throws.
 */
export async function runHousekeeping(): Promise<void> {
  const audit = await step("audit", pruneAudit);
  const logins = await step("login_tokens", async () =>
    (await db.delete(loginTokens).where(lt(loginTokens.expiresAt, sql`now() - interval '1 day'`)).returning({ id: loginTokens.id })).length,
  );
  const links = await step("link_requests", async () =>
    (await db.delete(linkRequests).where(lt(linkRequests.expiresAt, sql`now() - interval '1 day'`)).returning({ id: linkRequests.id })).length,
  );
  const ended = await step("sessions", async () =>
    (
      await db
        .delete(sessions)
        .where(or(lt(sessions.expiresAt, sql`now() - interval '30 days'`), lt(sessions.revokedAt, sql`now() - interval '30 days'`)))
        .returning({ id: sessions.id })
    ).length,
  );
  const events = await step("stripe_events", async () =>
    (await db.delete(stripeEvents).where(lt(stripeEvents.receivedAt, sql`now() - interval '30 days'`)).returning({ id: stripeEvents.id })).length,
  );
  const total = audit + logins + links + ended + events;
  if (total > 0) {
    console.log(`[housekeeping] removed ${audit} audit entries, ${logins} sign-in e-mails, ${links} link requests, ${ended} sessions, ${events} Stripe events`);
  }
}
