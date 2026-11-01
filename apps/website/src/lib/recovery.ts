import type Stripe from 'stripe';
import { LICENSE_FREE_DAYS } from '@godmode/shared';
import { PRICING } from '@/config/site';
import { render, type Composed } from './lifecycle';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The recovery email goes out a day after the checkout expired, and not at all once it's three days old. */
export const RECOVERY_DELAY = DAY;
export const RECOVERY_WINDOW = 3 * DAY;

export const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

export type RecoveryRow = {
  session_id: string;
  expired_at: number | null;
  plan: string | null;
  email: string | null;
  consent: string | null;
  recovery_url: string | null;
  recovery_expires_at: number | null;
};

/** What else is known about the person behind the row. */
export type RecoveryHistory = {
  /** A recovery email already went to this address (for any checkout). */
  mailed: boolean;
  /** The address has a completed order (they came back and bought, or already had). */
  bought: boolean;
  unsubscribed: boolean;
};

const ms = (v: number | null | undefined) => (typeof v === 'number' && v > 0 ? v * 1000 : null);
const clip = (v: unknown, n = 200) => (typeof v === 'string' && v ? v.slice(0, n) : null);
export const normalizeEmail = (v: unknown) => {
  const email = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return EMAIL.test(email) ? email : null;
};

/** The parts of an expired Checkout Session worth keeping for recovery. */
export function recoveryFromSession(s: Stripe.Checkout.Session, now = Date.now()) {
  const m = s.metadata ?? {};
  const recovery = s.after_expiration?.recovery;
  return {
    session_id: s.id,
    created_at: s.created * 1000,
    expired_at: Math.min(ms(s.expires_at) ?? now, now),
    plan: m.plan ?? null,
    email: normalizeEmail(s.customer_details?.email ?? s.customer_email),
    consent: s.consent?.promotions ?? null,
    recovery_url: recovery?.enabled && recovery.url ? recovery.url : null,
    recovery_expires_at: ms(recovery?.expires_at),
    utm_source: clip(m.utm_source, 120),
    utm_medium: clip(m.utm_medium, 120),
    utm_campaign: clip(m.utm_campaign, 120),
    utm_content: clip(m.utm_content, 120),
    referrer: clip(m.referrer),
    livemode: s.livemode ? 1 : 0,
  };
}

/**
 * Whether the one recovery email may go out now. Consent is required, wherever the person lives: Stripe only
 * reports it where the law asks for it, so anything short of an explicit opt-in counts as no.
 */
export function recoveryDue(r: RecoveryRow, h: RecoveryHistory, now: number): boolean {
  if (!r.email || !EMAIL.test(r.email)) return false;
  if (r.consent !== 'opt_in') return false;
  if (!r.recovery_url?.startsWith('https://')) return false;
  if (!r.expired_at) return false;
  const age = now - r.expired_at;
  if (age < RECOVERY_DELAY || age >= RECOVERY_WINDOW) return false;
  if (r.recovery_expires_at && r.recovery_expires_at <= now + HOUR) return false;
  return !h.mailed && !h.bought && !h.unsubscribed;
}

export function composeRecovery(r: RecoveryRow, base: string, unsubscribeUrl: string): Composed {
  const plan = r.plan === 'yearly' ? PRICING.plans.yearly : PRICING.plans.monthly;
  return render('Your Godmode checkout', [
    'Hi,',
    "saw you started the Godmode checkout but didn't finish it. Anything that stopped you?",
    `If it was just timing, here is your checkout again (Pro ${plan.interval === 'year' ? 'Yearly' : 'Monthly'}, $${plan.price}/${plan.interval}). Nothing is charged today and the first ${PRICING.trialDays} days are free:\n${r.recovery_url}`,
    `Or try it without a card first. The download runs free for ${LICENSE_FREE_DAYS} days:\n${base}/download`,
    "And if something didn't make sense or felt off, just reply. It comes straight to me.",
    'Daniel\nFounder, Godmode',
    `This is the only reminder I'll send. Unsubscribe: ${unsubscribeUrl}`,
  ]);
}
