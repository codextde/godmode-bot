import { env } from 'cloudflare:workers';
import { SITE } from '@/config/site';
import { db } from './db';
import { minLivemode } from './entitlement';
import { compose, dueKinds, type EmailKind, type LifecycleOrder } from './lifecycle';

const DAY = 86_400_000;

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

async function send(kind: EmailKind, o: Candidate): Promise<boolean> {
  const claim = await db()
    .prepare(`INSERT OR IGNORE INTO emails (session_id, kind, sent_at) VALUES (?, ?, ?)`)
    .bind(o.session_id, kind, Date.now())
    .run();
  if (!claim.meta.changes) return false;
  const mail = compose(kind, o, SITE.url.replace(/\/$/, ''));
  try {
    const res = await env.EMAIL!.send({
      from: { name: env.MAIL_FROM_NAME ?? 'Daniel from Godmode', email: env.MAIL_FROM ?? 'daniel@usegodmode.com' },
      replyTo: env.MAIL_REPLY_TO ?? SITE.email,
      to: o.email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    await db().prepare(`UPDATE emails SET message_id = ? WHERE session_id = ? AND kind = ?`).bind(res.messageId, o.session_id, kind).run();
    return true;
  } catch (e) {
    console.error('lifecycle email failed', kind, o.session_id, e);
    await db().prepare(`DELETE FROM emails WHERE session_id = ? AND kind = ?`).bind(o.session_id, kind).run();
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
  await send(kind, o);
}

/** Right after checkout: the license key by email, so it isn't lost with the welcome page. */
export async function sendWelcome(sessionId: string) {
  const o = await db().prepare(`${SELECT} AND o.session_id = ?`).bind(minLivemode(), sessionId).first<Candidate>();
  if (o) await deliver(o, Date.now());
}

/** Hourly cron: welcome backfill, day-3 getting started, and the reminder three days before a trial ends. */
export async function runLifecycle(now = Date.now()) {
  const rows = await db()
    .prepare(`${SELECT} AND o.created_at >= ? ORDER BY o.created_at`)
    .bind(minLivemode(), now - 30 * DAY)
    .all<Candidate>();
  for (const o of rows.results ?? []) await deliver(o, now);
}
