import { env } from 'cloudflare:workers';
import { SITE } from '@/config/site';
import { db } from './db';
import { minLivemode } from './entitlement';
import { composeFree, dueFreeKinds, leadKey, type FreeLead } from './free-emails';
import { compose, dueKinds, type Composed, type LifecycleOrder } from './lifecycle';
import { unsubscribeToken } from './signed';

const DAY = 86_400_000;

const base = () => SITE.url.replace(/\/$/, '');

/** Off unless LIFECYCLE_EMAILS=on: until then due emails are only logged, nothing is recorded or sent. */
const enabled = () => env.LIFECYCLE_EMAILS === 'on' && Boolean(env.EMAIL);

type Candidate = LifecycleOrder & {
  created_at: number;
  sub_status: string | null;
  cancel_at_period_end: number | null;
  last_email_at: number | null;
};

const SELECT = `SELECT o.session_id, o.created_at, o.plan, o.email, o.name, o.license_key, o.amount_total, o.currency,
    o.customer_id, o.trial_end, o.first_seen_at, o.sub_status, o.cancel_at_period_end,
    (SELECT MAX(sent_at) FROM emails e WHERE e.session_id = o.session_id) AS last_email_at
  FROM orders o
  WHERE o.status = 'paid' AND COALESCE(o.comp, 0) = 0 AND o.email IS NOT NULL AND o.license_key IS NOT NULL
    AND o.livemode >= ?`;

/** Claims the (key, kind) row first, so overlapping runs never send twice; a failed send gives the claim back. */
async function send(key: string, kind: string, to: string, write: () => Composed, headers?: Record<string, string>): Promise<boolean> {
  const claim = await db()
    .prepare(`INSERT OR IGNORE INTO emails (session_id, kind, sent_at) VALUES (?, ?, ?)`)
    .bind(key, kind, Date.now())
    .run();
  if (!claim.meta.changes) return false;
  try {
    const mail = write();
    const res = await env.EMAIL!.send({
      from: { name: env.MAIL_FROM_NAME ?? 'Daniel from Godmode', email: env.MAIL_FROM ?? 'daniel@usegodmode.com' },
      replyTo: env.MAIL_REPLY_TO ?? SITE.email,
      to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      ...(headers ? { headers } : {}),
    });
    await db().prepare(`UPDATE emails SET message_id = ? WHERE session_id = ? AND kind = ?`).bind(res.messageId, key, kind).run();
    return true;
  } catch (e) {
    console.error('lifecycle email failed', kind, key, e);
    await db().prepare(`DELETE FROM emails WHERE session_id = ? AND kind = ?`).bind(key, kind).run();
    return false;
  }
}

/** One email per order per day at most, the most urgent due kind first. */
async function deliver(o: Candidate, now: number) {
  if (o.last_email_at && now - o.last_email_at < DAY) return;
  const sent = await db().prepare(`SELECT kind FROM emails WHERE session_id = ?`).bind(o.session_id).all<{ kind: string }>();
  const done = new Set((sent.results ?? []).map((r) => r.kind));
  const kind = dueKinds(o, now).find((k) => !done.has(k));
  if (!kind) return;
  if (!enabled()) {
    console.log('lifecycle email due (sending is off)', kind, o.session_id);
    return;
  }
  await send(o.session_id, kind, o.email, () => compose(kind, o, base()));
}

/** Right after checkout: the license key by email, so it isn't lost with the welcome page. */
export async function sendWelcome(sessionId: string) {
  const o = await db().prepare(`${SELECT} AND o.session_id = ?`).bind(minLivemode(), sessionId).first<Candidate>();
  if (o) await deliver(o, Date.now());
}

/** Hourly cron: welcome backfill, day-3 getting started, the reminder three days before a trial ends, and the free-days emails. */
export async function runLifecycle(now = Date.now()) {
  const rows = await db()
    .prepare(`${SELECT} AND o.created_at >= ? ORDER BY o.created_at`)
    .bind(minLivemode(), now - 30 * DAY)
    .all<Candidate>();
  for (const o of rows.results ?? []) await deliver(o, now);
  await runFreeLifecycle(now);
}

type FreeCandidate = FreeLead & { last_email_at: number | null };

// Leads from the app on (or just past) their free days who haven't unsubscribed or bought since.
const FREE_SELECT = `SELECT l.id, l.email, l.free_ends_at, l.locale, l.unsubscribed_at,
    (SELECT MAX(sent_at) FROM emails e WHERE e.session_id = 'lead:' || l.id) AS last_email_at
  FROM leads l
  WHERE l.source = 'app' AND l.free_ends_at IS NOT NULL AND l.unsubscribed_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE lower(o.email) = l.email AND o.status IN ('paid', 'past_due') AND o.livemode >= ?)`;

async function deliverFree(l: FreeCandidate, now: number) {
  if (l.last_email_at && now - l.last_email_at < DAY) return;
  const key = leadKey(l.id);
  const sent = await db().prepare(`SELECT kind FROM emails WHERE session_id = ?`).bind(key).all<{ kind: string }>();
  const done = new Set((sent.results ?? []).map((r) => r.kind));
  const kind = dueFreeKinds(l, now).find((k) => !done.has(k));
  if (!kind) return;
  if (!enabled()) {
    console.log('lifecycle email due (sending is off)', kind, key);
    return;
  }
  const unsubscribe = `${base()}/api/unsubscribe?e=${await unsubscribeToken(l.id)}`;
  await send(key, kind, l.email, () => composeFree(kind, l, base(), unsubscribe, now), {
    'List-Unsubscribe': `<${unsubscribe}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  });
}

/** Right after the app sent an address: the welcome, unless the free days are almost over (then the reminder). */
export async function sendFreeWelcome(leadId: number) {
  const l = await db().prepare(`${FREE_SELECT} AND l.id = ?`).bind(minLivemode(), leadId).first<FreeCandidate>();
  if (l) await deliverFree(l, Date.now());
}

async function runFreeLifecycle(now: number) {
  const rows = await db()
    .prepare(`${FREE_SELECT} AND l.free_ends_at > ? ORDER BY l.free_ends_at`)
    .bind(minLivemode(), now - 3 * DAY)
    .all<FreeCandidate>();
  for (const l of rows.results ?? []) await deliverFree(l, now);
}
