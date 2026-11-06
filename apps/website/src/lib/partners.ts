import type Stripe from 'stripe';
import { env } from 'cloudflare:workers';
import { euro, PARTNERS, partnerLink, RESERVED_CODES } from '@/config/partners';
import { isPlan, PRICING, SITE } from '@/config/site';
import { db } from './db';
import { minLivemode } from './entitlement';
import { render } from './lifecycle';
import { sendMail, sendOnce } from './mail';
import { CODE, loginToken, normalizeCode } from './partner-auth';
import { stripe } from './stripe';

const DAY = 86_400_000;

export type PartnerStatus = 'active' | 'paused' | 'banned';

export type Partner = {
  id: number;
  email: string;
  name: string;
  code: string;
  country: string | null;
  links: string | null;
  status: PartnerStatus;
  rate_bps: number;
  email_verified_at: number | null;
  payout_method: 'stripe' | 'paypal' | null;
  paypal_email: string | null;
  stripe_account_id: string | null;
  stripe_payouts_enabled: number;
  promotion_code_id: string | null;
  notes: string | null;
  created_at: number;
  last_login_at: number | null;
};

export type Referral = {
  id: number;
  partner_id: number;
  session_id: string | null;
  subscription_id: string | null;
  source: 'link' | 'code';
  status: 'active' | 'rejected' | 'canceled';
  first_paid_at: number | null;
  plan: string | null;
};

type Commission = {
  id: number;
  partner_id: number;
  referral_id: number | null;
  invoice_id: string;
  kind: string;
  charge_id: string | null;
  base_cents: number;
  amount_cents: number;
  status: 'pending' | 'available' | 'paid' | 'reversed';
  available_at: number;
  payout_id: number | null;
  livemode: number;
};

const base = () => SITE.url.replace(/\/$/, '');
const idOf = (v: string | { id: string } | null | undefined) => (typeof v === 'string' ? v : (v?.id ?? null));
/** 1 with a live Stripe key, 0 with a test key: payouts and balances only ever mix one mode. */
export const liveFlag = () => minLivemode();
export const cents = (v: number) => euro(v / 100);

export function addMonths(ms: number, months: number) {
  const d = new Date(ms);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.getTime();
}

export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? '';
/** "Daniel E." — how other partners see a name (leaderboard). */
export const shortName = (name: string) => {
  const [first, ...rest] = name.trim().split(/\s+/);
  const last = rest.at(-1);
  return last ? `${first} ${last[0].toUpperCase()}.` : (first ?? '');
};

// Partners ----------------------------------------------------------------------------------------------------

export const partnerById = (id: number) => db().prepare(`SELECT * FROM partners WHERE id = ?`).bind(id).first<Partner>();
export const partnerByEmail = (email: string) =>
  db().prepare(`SELECT * FROM partners WHERE email = ?`).bind(email.trim().toLowerCase()).first<Partner>();
export const partnerByCode = (code: string) => db().prepare(`SELECT * FROM partners WHERE code = ?`).bind(normalizeCode(code)).first<Partner>();

export async function activePartnerByCode(code: string) {
  const c = normalizeCode(code);
  if (!CODE.test(c)) return null;
  const p = await partnerByCode(c);
  return p?.status === 'active' ? p : null;
}

export const validCode = (code: string) => CODE.test(code) && !RESERVED_CODES.has(code);

/** A free code from a name: "Mia Clips" -> MIACLIPS, MIACLIPS2, … */
export async function suggestCode(name: string) {
  const stem = name.normalize('NFKD').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16) || 'CLIP';
  const root = stem.length >= 3 ? stem : `${stem}GM`.slice(0, 16);
  for (let i = 0; i < 50; i++) {
    const code = i === 0 ? root : `${root}${i + 1}`;
    if (validCode(code) && !(await partnerByCode(code))) return code;
  }
  return `${root.slice(0, 10)}${Math.floor(Math.random() * 1e6)}`;
}

export type JoinInput = { email: string; name: string; code: string; country: string | null; links: string | null };
export type JoinError = 'email_taken' | 'code_taken' | 'code_invalid';

export async function createPartner(input: JoinInput, now = Date.now()): Promise<Partner | JoinError> {
  const email = input.email.trim().toLowerCase();
  const code = normalizeCode(input.code);
  if (!validCode(code)) return 'code_invalid';
  if (await partnerByEmail(email)) return 'email_taken';
  if (await partnerByCode(code)) return 'code_taken';
  try {
    await db()
      .prepare(
        `INSERT INTO partners (email, name, code, country, links, status, rate_bps, created_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .bind(email, input.name.trim(), code, input.country, input.links, PARTNERS.rateBps, now, now)
      .run();
  } catch {
    return (await partnerByEmail(email)) ? 'email_taken' : 'code_taken';
  }
  return (await partnerByEmail(email))!;
}

// Clips ---------------------------------------------------------------------------------------------------------------

const PLATFORMS: [RegExp, string][] = [
  [/(^|\.)tiktok\.com$/, 'TikTok'],
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'YouTube'],
  [/(^|\.)(x\.com|twitter\.com)$/, 'X'],
  [/(^|\.)facebook\.com$/, 'Facebook'],
  [/(^|\.)linkedin\.com$/, 'LinkedIn'],
];

/** A posted clip's URL without tracking parameters (so the same clip can't be added twice), and its platform. */
export function normalizeClipUrl(raw: string): { url: string; platform: string } | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
  const platform = PLATFORMS.find(([re]) => re.test(host))?.[1] ?? 'Other';
  const keep = platform === 'YouTube' && u.searchParams.get('v') ? `?v=${u.searchParams.get('v')}` : platform === 'Other' ? u.search : '';
  return { url: `https://${host}${u.pathname.replace(/\/+$/, '')}${keep}`.slice(0, 500), platform };
}

// Stripe promotion codes: one shared coupon, one code per partner ---------------------------------------------------

async function ensureCoupon() {
  try {
    await stripe().coupons.retrieve(PARTNERS.couponId);
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode !== 404) throw e;
    await stripe().coupons.create({
      id: PARTNERS.couponId,
      percent_off: PARTNERS.discountPercent,
      duration: 'once',
      name: `Partner code: ${PARTNERS.discountPercent}% off the first month`,
    });
  }
}

/** Creates the partner's promotion code (code = partner code) once; adopts it if Stripe already has it for them. */
export async function ensurePromotionCode(p: Partner): Promise<string> {
  if (p.promotion_code_id) return p.promotion_code_id;
  await ensureCoupon();
  let id: string;
  try {
    const promo = await stripe().promotionCodes.create({
      promotion: { type: 'coupon', coupon: PARTNERS.couponId },
      code: p.code,
      active: p.status === 'active',
      metadata: { partner_id: String(p.id), partner_code: p.code },
      restrictions: { first_time_transaction: true },
    });
    id = promo.id;
  } catch (e) {
    const existing = await stripe().promotionCodes.list({ code: p.code, limit: 1 });
    const mine = existing.data.find((c) => c.metadata?.partner_id === String(p.id));
    if (!mine) throw e;
    id = mine.id;
  }
  await db().prepare(`UPDATE partners SET promotion_code_id = ? WHERE id = ?`).bind(id, p.id).run();
  return id;
}

/** Retries sign-ups whose promotion code could not be created (cron and the admin button). */
export async function createMissingPromotionCodes(limit = 10) {
  const rows = await db()
    .prepare(`SELECT * FROM partners WHERE promotion_code_id IS NULL AND status = 'active' ORDER BY id LIMIT ?`)
    .bind(limit)
    .all<Partner>();
  let created = 0;
  for (const p of rows.results ?? []) {
    try {
      await ensurePromotionCode(p);
      created++;
    } catch (e) {
      console.error('promotion code failed', p.code, e instanceof Error ? e.message : e);
    }
  }
  return { created, tried: rows.results?.length ?? 0 };
}

/** Pause, ban or reactivate; the partner's code stops (or starts) working at checkout too. */
export async function setPartnerStatus(id: number, status: PartnerStatus) {
  await db().prepare(`UPDATE partners SET status = ? WHERE id = ?`).bind(status, id).run();
  const p = await partnerById(id);
  if (p?.promotion_code_id) {
    await stripe()
      .promotionCodes.update(p.promotion_code_id, { active: status === 'active' })
      .catch((e) => console.error('promotion code update failed', p.code, e instanceof Error ? e.message : e));
  }
}

async function partnerForPromotionCode(promotionCodeId: string): Promise<Partner | null> {
  const known = await db().prepare(`SELECT * FROM partners WHERE promotion_code_id = ?`).bind(promotionCodeId).first<Partner>();
  if (known) return known;
  try {
    const promo = await stripe().promotionCodes.retrieve(promotionCodeId);
    const id = Number(promo.metadata?.partner_id);
    if (id) return await partnerById(id);
  } catch (e) {
    console.error('promotion code lookup failed', promotionCodeId, e instanceof Error ? e.message : e);
  }
  return null;
}

// Attribution ------------------------------------------------------------------------------------------------------

/** A partner's code entered at checkout wins over the link they came through (gm_ref cookie → metadata.partner). */
export async function attribute(promotionCodeId: string | null, metadataCode: string | null | undefined) {
  if (promotionCodeId) {
    const p = await partnerForPromotionCode(promotionCodeId);
    if (p?.status === 'active') return { partner: p, source: 'code' as const };
  }
  const p = metadataCode ? await activePartnerByCode(metadataCode) : null;
  return p ? { partner: p, source: 'link' as const } : null;
}

type Discountish = { promotion_code?: string | { id: string } | null } | string;
export const promotionCodeOf = (discounts: Discountish[] | null | undefined) => {
  for (const d of discounts ?? []) if (typeof d === 'object' && d?.promotion_code) return idOf(d.promotion_code);
  return null;
};

export type ReferralInput = {
  sessionId: string | null;
  subscriptionId: string;
  customerId: string | null;
  email: string | null;
  plan: string | null;
  promotionCodeId: string | null;
  metadataCode: string | null | undefined;
  livemode: boolean;
};

export const referralBySubscription = (subscriptionId: string) =>
  db().prepare(`SELECT * FROM partner_referrals WHERE subscription_id = ?`).bind(subscriptionId).first<Referral>();

/**
 * Records which partner brought a subscription, once (checkout.session.completed, or the first invoice when that
 * arrives first). A customer with the partner's own email is a self-referral: kept as `rejected`, never paid.
 */
export async function recordReferral(input: ReferralInput, now = Date.now()): Promise<Referral | null> {
  let referral = await referralBySubscription(input.subscriptionId);
  if (!referral) {
    const hit = await attribute(input.promotionCodeId, input.metadataCode);
    if (!hit) return null;
    const email = input.email?.trim().toLowerCase() ?? null;
    const self = Boolean(email && email === hit.partner.email);
    await db()
      .prepare(
        `INSERT OR IGNORE INTO partner_referrals (partner_id, session_id, subscription_id, customer_id, email, source, plan, status,
           created_at, livemode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        hit.partner.id,
        input.sessionId,
        input.subscriptionId,
        input.customerId,
        email,
        hit.source,
        input.plan,
        self ? 'rejected' : 'active',
        now,
        input.livemode ? 1 : 0,
      )
      .run();
    referral = await referralBySubscription(input.subscriptionId);
    if (!referral) return null;
  } else {
    if (input.sessionId && !referral.session_id) {
      await db().prepare(`UPDATE partner_referrals SET session_id = ? WHERE id = ?`).bind(input.sessionId, referral.id).run();
    }
    // A partner code that shows up later still wins over the link, as long as nothing was earned on it yet.
    const hit = input.promotionCodeId && referral.source === 'link' ? await attribute(input.promotionCodeId, null) : null;
    if (hit && hit.partner.id !== referral.partner_id) {
      const self = Boolean(input.email && input.email.trim().toLowerCase() === hit.partner.email);
      await db()
        .prepare(
          `UPDATE partner_referrals SET partner_id = ?, source = 'code', status = CASE WHEN status = 'canceled' THEN status ELSE ? END
           WHERE id = ? AND source = 'link' AND NOT EXISTS (SELECT 1 FROM partner_commissions WHERE referral_id = ?)`,
        )
        .bind(hit.partner.id, self ? 'rejected' : 'active', referral.id, referral.id)
        .run();
      referral = (await referralBySubscription(input.subscriptionId)) ?? referral;
    }
  }
  if (referral.status === 'active') {
    await db()
      .prepare(`UPDATE orders SET partner_id = ? WHERE subscription_id = ? OR session_id = ?`)
      .bind(referral.partner_id, input.subscriptionId, input.sessionId ?? '')
      .run();
  }
  return referral;
}

export async function referralFromSession(s: Stripe.Checkout.Session) {
  const subscriptionId = idOf(s.subscription);
  if (s.mode !== 'subscription' || !subscriptionId) return null;
  return recordReferral({
    sessionId: s.id,
    subscriptionId,
    customerId: idOf(s.customer),
    email: s.customer_details?.email ?? s.customer_email ?? null,
    plan: s.metadata?.plan ?? null,
    promotionCodeId: promotionCodeOf(s.discounts as Discountish[] | null),
    metadataCode: s.metadata?.partner,
    livemode: s.livemode,
  });
}

export async function endReferral(subscriptionId: string) {
  await db()
    .prepare(`UPDATE partner_referrals SET status = 'canceled' WHERE subscription_id = ? AND status = 'active'`)
    .bind(subscriptionId)
    .run();
}

// Commissions -------------------------------------------------------------------------------------------------------

export type PaidInvoice = {
  invoiceId: string;
  subscriptionId: string;
  /** In the invoice currency's minor unit. */
  amountPaid: number;
  tax: number;
  currency: string;
  paidAt: number;
  chargeId: string | null;
  /** Invoice currency → EUR (Stripe's rate from the charge's balance transaction); 1 for EUR. */
  eurRate: number | null;
  livemode: boolean;
};

/**
 * 20% (the partner's rate) of a payment minus tax, in EUR, for payments within 12 months of the customer's first
 * one. Held for 30 days. Once per invoice.
 */
export async function recordCommission(inv: PaidInvoice, now = Date.now()) {
  if (inv.amountPaid <= 0) return null;
  const ref = await db()
    .prepare(
      `SELECT r.id, r.partner_id, r.status, r.first_paid_at, r.plan, p.status AS partner_status, p.rate_bps, p.email, p.name
       FROM partner_referrals r JOIN partners p ON p.id = r.partner_id WHERE r.subscription_id = ?`,
    )
    .bind(inv.subscriptionId)
    .first<Referral & { partner_status: PartnerStatus; rate_bps: number; email: string; name: string }>();
  if (!ref || ref.status === 'rejected' || ref.partner_status === 'banned') return null;

  await db()
    .prepare(`UPDATE partner_referrals SET first_paid_at = MIN(COALESCE(first_paid_at, ?1), ?1) WHERE id = ?2`)
    .bind(inv.paidAt, ref.id)
    .run();
  const first = Math.min(ref.first_paid_at ?? inv.paidAt, inv.paidAt);
  if (inv.paidAt >= addMonths(first, PARTNERS.months)) return null;

  const rate = inv.currency.toLowerCase() === 'eur' ? 1 : inv.eurRate;
  if (!rate) throw new Error(`no EUR rate for invoice ${inv.invoiceId} (${inv.currency})`);
  const baseCents = Math.max(0, Math.round((inv.amountPaid - inv.tax) * rate));
  const amount = Math.round((baseCents * ref.rate_bps) / 10000);
  if (amount <= 0) return null;

  const res = await db()
    .prepare(
      `INSERT OR IGNORE INTO partner_commissions (partner_id, referral_id, invoice_id, kind, charge_id, base_cents, amount_cents,
         status, available_at, created_at, livemode)
       VALUES (?, ?, ?, 'sale', ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .bind(ref.partner_id, ref.id, inv.invoiceId, inv.chargeId, baseCents, amount, inv.paidAt + PARTNERS.holdDays * DAY, now, inv.livemode ? 1 : 0)
    .run();
  if (!res.meta.changes) return null;

  const plan = ref.plan && isPlan(ref.plan) ? PRICING.plans[ref.plan].name : 'Godmode';
  await notify(ref.partner_id, `commission:${inv.invoiceId}`, ref.email, saleMail(ref.name, amount, plan, inv.paidAt + PARTNERS.holdDays * DAY));
  return { partnerId: ref.partner_id, amount };
}

/**
 * The charge behind a paid invoice and its EUR rate (from the charge's balance transaction), for the API versions this
 * site meets: a legacy `charge` on the invoice, or its invoice payments.
 */
async function chargeForInvoice(invoice: Stripe.Invoice): Promise<{ charge: Stripe.Charge | null; eurRate: number | null }> {
  const eur = invoice.currency.toLowerCase() === 'eur';
  let chargeId = idOf((invoice as unknown as { charge?: string | { id: string } | null }).charge);
  let pi: string | null = null;
  if (!chargeId) {
    const payments = await stripe().invoicePayments.list({ invoice: invoice.id, limit: 10 });
    const pay = payments.data.find((p) => p.status === 'paid') ?? payments.data[0];
    pi = idOf(pay?.payment?.payment_intent as string | { id: string } | null | undefined);
    chargeId = idOf(pay?.payment?.charge as string | { id: string } | null | undefined);
  }
  let charge: Stripe.Charge | null = null;
  if (pi) {
    const intent = await stripe().paymentIntents.retrieve(pi, { expand: ['latest_charge.balance_transaction'] });
    charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
  } else if (chargeId) {
    charge = await stripe().charges.retrieve(chargeId, { expand: ['balance_transaction'] });
  }
  if (eur) return { charge, eurRate: 1 };
  if (!charge) return { charge, eurRate: null };
  const bt = typeof charge.balance_transaction === 'object' ? charge.balance_transaction : null;
  // Missing right after the payment at most: throwing makes Stripe deliver the event again.
  if (!bt) throw new Error(`no balance transaction yet for ${charge.id}`);
  // Minor units on both sides, so currencies without cents convert right too.
  return { charge, eurRate: bt.currency === 'eur' && charge.amount > 0 ? bt.amount / charge.amount : null };
}

/** invoice.paid: the commission for a referred subscription's payment. Unreferred subscriptions cost no API calls. */
export async function handleInvoicePaid(invoice: Stripe.Invoice, now = Date.now()) {
  const legacy = invoice as unknown as { subscription?: string | { id: string } | null; tax?: number | null };
  const subscriptionId = idOf(invoice.parent?.subscription_details?.subscription) ?? idOf(legacy.subscription);
  if (!subscriptionId || !invoice.id) return null;

  let referral = await referralBySubscription(subscriptionId);
  // The first invoice can arrive before checkout.session.completed: attribute it from the invoice itself (its
  // discounts carry a partner code, the subscription metadata snapshot the link).
  const meta = invoice.parent?.subscription_details?.metadata ?? {};
  if (!referral && invoice.billing_reason === 'subscription_create' && meta.license_key) {
    const full = await stripe().invoices.retrieve(invoice.id, { expand: ['discounts'] });
    referral = await recordReferral(
      {
        sessionId: null,
        subscriptionId,
        customerId: idOf(invoice.customer),
        email: invoice.customer_email,
        plan: meta.plan ?? null,
        promotionCodeId: promotionCodeOf(full.discounts as Discountish[]),
        metadataCode: meta.partner,
        livemode: invoice.livemode,
      },
      now,
    );
  }
  if (!referral || referral.status === 'rejected' || invoice.amount_paid <= 0) return null;

  const tax = invoice.total_taxes ? invoice.total_taxes.reduce((s, t) => s + t.amount, 0) : (legacy.tax ?? 0);
  const { charge, eurRate } = await chargeForInvoice(invoice);
  if (!eurRate) {
    console.error('partner commission skipped: no EUR rate', invoice.id, invoice.currency);
    return null;
  }
  const paidAt = (invoice.status_transitions?.paid_at ?? Math.floor(now / 1000)) * 1000;
  const res = await recordCommission(
    {
      invoiceId: invoice.id,
      subscriptionId,
      amountPaid: invoice.amount_paid,
      tax,
      currency: invoice.currency,
      paidAt,
      chargeId: charge?.id ?? null,
      eurRate,
      livemode: invoice.livemode,
    },
    now,
  );
  // A refund can be processed before this event: catch up with it right away.
  if (res && charge && charge.amount_refunded > 0 && charge.amount > 0) {
    await reverseCommission(charge.id, charge.amount_refunded / charge.amount, `refund:${charge.amount_refunded}`, now);
  }
  return res;
}

/** Keeps a proposed payout's amount equal to what it still carries; one left with nothing is canceled. */
async function syncPayoutAmount(payoutId: number) {
  const row = await db()
    .prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS total FROM partner_commissions WHERE payout_id = ? AND status = 'available'`)
    .bind(payoutId)
    .first<{ total: number }>();
  const total = Number(row?.total ?? 0);
  const res = await db().prepare(`UPDATE partner_payouts SET amount_cents = ? WHERE id = ? AND status = 'proposed'`).bind(total, payoutId).run();
  if (res.meta.changes && total <= 0) await cancelPayout(payoutId, 'nothing left to pay');
}

/**
 * Refunds (full or partial, `fraction` = share of the charge refunded so far) and lost disputes. Commission nobody
 * signed off yet is reversed; once it was paid out or sits in an approved payout, a negative adjustment comes off the
 * next payout instead. Idempotent per refund state, and safe when two refund events run at once.
 */
export async function reverseCommission(chargeId: string, fraction: number, kind: string, now = Date.now()) {
  const sale = await db()
    .prepare(`SELECT * FROM partner_commissions WHERE charge_id = ? AND kind = 'sale'`)
    .bind(chargeId)
    .first<Commission>();
  if (!sale || sale.status === 'reversed') return;
  const share = Math.min(1, Math.max(0, fraction));
  const lockedRow = await db()
    .prepare(
      `SELECT 1 AS locked FROM partner_commissions c LEFT JOIN partner_payouts pp ON pp.id = c.payout_id
       WHERE c.invoice_id = ? AND c.status <> 'reversed' AND (c.status = 'paid' OR (c.payout_id IS NOT NULL AND pp.status <> 'proposed'))
       LIMIT 1`,
    )
    .bind(sale.invoice_id)
    .first<{ locked: number }>();
  const locked = Boolean(lockedRow);

  if (!locked && share >= 1) {
    const touched = await db()
      .prepare(`SELECT DISTINCT payout_id FROM partner_commissions WHERE invoice_id = ? AND status IN ('pending', 'available') AND payout_id IS NOT NULL`)
      .bind(sale.invoice_id)
      .all<{ payout_id: number }>();
    await db()
      .prepare(`UPDATE partner_commissions SET status = 'reversed' WHERE invoice_id = ? AND status IN ('pending', 'available')`)
      .bind(sale.invoice_id)
      .run();
    for (const r of touched.results ?? []) await syncPayoutAmount(r.payout_id);
    return;
  }

  // One statement reads what was reversed so far and adds only the rest.
  await db()
    .prepare(
      `INSERT OR IGNORE INTO partner_commissions (partner_id, referral_id, invoice_id, kind, charge_id, base_cents, amount_cents,
         status, available_at, created_at, livemode)
       SELECT s.partner_id, s.referral_id, s.invoice_id, ?1, s.charge_id,
              -CAST(ROUND(s.base_cents * d.delta * 1.0 / s.amount_cents) AS INTEGER), -d.delta, ?2, ?3, ?4, s.livemode
       FROM partner_commissions s,
            (SELECT ?5 + COALESCE(SUM(a.amount_cents), 0) AS delta FROM partner_commissions a
             WHERE a.invoice_id = ?6 AND a.kind <> 'sale' AND a.status <> 'reversed') d
       WHERE s.id = ?7 AND s.status <> 'reversed' AND d.delta > 0`,
    )
    .bind(
      kind,
      locked ? 'available' : sale.status,
      locked ? now : sale.available_at,
      now,
      Math.round(sale.amount_cents * share),
      sale.invoice_id,
      sale.id,
    )
    .run();
}

// Balances and payouts ----------------------------------------------------------------------------------------------

export type Balance = { pending: number; available: number; paid: number; inPayout: number };

export async function balanceOf(partnerId: number, livemode = liveFlag()): Promise<Balance> {
  const r = await db()
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN status = 'pending' THEN amount_cents END), 0) AS pending,
              COALESCE(SUM(CASE WHEN status = 'available' THEN amount_cents END), 0) AS available,
              COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_cents END), 0) AS paid,
              COALESCE(SUM(CASE WHEN status = 'available' AND payout_id IS NOT NULL THEN amount_cents END), 0) AS in_payout
       FROM partner_commissions WHERE partner_id = ? AND livemode = ?`,
    )
    .bind(partnerId, livemode)
    .first<{ pending: number; available: number; paid: number; in_payout: number }>();
  return { pending: Number(r?.pending ?? 0), available: Number(r?.available ?? 0), paid: Number(r?.paid ?? 0), inPayout: Number(r?.in_payout ?? 0) };
}

/** The way a partner can be paid right now: their choice when it is ready, else whichever is. */
export function payoutMethod(p: Pick<Partner, 'payout_method' | 'paypal_email' | 'stripe_account_id' | 'stripe_payouts_enabled'>) {
  const stripeReady = Boolean(p.stripe_account_id && p.stripe_payouts_enabled);
  const paypalReady = Boolean(p.paypal_email);
  if (p.payout_method === 'stripe' && stripeReady) return 'stripe' as const;
  if (p.payout_method === 'paypal' && paypalReady) return 'paypal' as const;
  return stripeReady ? ('stripe' as const) : paypalReady ? ('paypal' as const) : null;
}

/** Commission that is past its hold becomes available. */
export async function releaseHeld(now = Date.now()) {
  await db().prepare(`UPDATE partner_commissions SET status = 'available' WHERE status = 'pending' AND available_at <= ?`).bind(now).run();
}

const monthStartOf = (now: number) => Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);

/**
 * On the 1st of the month: one proposed payout per active, verified partner with a ready payout method and at least
 * €25 available. Proposals are made once a month: one from an earlier month that is still waiting takes in what became
 * available since, approved ones are left alone, and later runs in the same month change nothing.
 */
export async function proposePayouts(now = Date.now()) {
  const live = liveFlag();
  const monthStart = monthStartOf(now);
  const rows = await db()
    .prepare(
      `SELECT p.*, SUM(c.amount_cents) AS balance FROM partners p JOIN partner_commissions c ON c.partner_id = p.id
       WHERE c.status = 'available' AND c.payout_id IS NULL AND c.livemode = ?
         AND p.status = 'active' AND p.email_verified_at IS NOT NULL
       GROUP BY p.id`,
    )
    .bind(live)
    .all<Partner & { balance: number }>();
  const proposed: number[] = [];
  for (const p of rows.results ?? []) {
    const method = payoutMethod(p);
    if (!method) continue;
    const open = await db()
      .prepare(`SELECT * FROM partner_payouts WHERE partner_id = ? AND livemode = ? AND status IN ('proposed', 'approved', 'failed')`)
      .bind(p.id, live)
      .first<{ id: number; status: string; amount_cents: number; created_at: number }>();
    if (open && (open.status !== 'proposed' || open.created_at >= monthStart)) continue;
    if (Number(p.balance) + (open?.amount_cents ?? 0) < PARTNERS.minPayoutEur * 100) continue;
    let id = open?.id;
    if (id) {
      await db().prepare(`UPDATE partner_payouts SET method = ?, created_at = ? WHERE id = ?`).bind(method, now, id).run();
    } else {
      const res = await db()
        .prepare(`INSERT INTO partner_payouts (partner_id, amount_cents, currency, method, status, created_at, livemode) VALUES (?, 0, 'eur', ?, 'proposed', ?, ?)`)
        .bind(p.id, method, now, live)
        .run();
      id = res.meta.last_row_id;
    }
    await db()
      .prepare(`UPDATE partner_commissions SET payout_id = ? WHERE partner_id = ? AND status = 'available' AND payout_id IS NULL AND livemode = ?`)
      .bind(id, p.id, live)
      .run();
    await syncPayoutAmount(id!);
    proposed.push(id!);
  }
  return proposed;
}

/**
 * Signs a payout off. `amount` is what the approver saw: if the payout changed since (a refund), nothing happens.
 * From here on its commissions are fixed; later refunds come off the next payout.
 */
export async function approvePayout(id: number, by: string, amount?: number, now = Date.now()) {
  const res = await db()
    .prepare(
      `UPDATE partner_payouts SET status = 'approved', approved_at = ?, approved_by = ?, error = NULL
       WHERE id = ? AND status IN ('proposed', 'failed') AND (? IS NULL OR amount_cents = ?)`,
    )
    .bind(now, by, id, amount ?? null, amount ?? null)
    .run();
  return res.meta.changes > 0;
}

export async function cancelPayout(id: number, reason: string | null = null) {
  const res = await db()
    .prepare(`UPDATE partner_payouts SET status = 'canceled', error = COALESCE(?, error) WHERE id = ? AND status IN ('proposed', 'approved', 'failed')`)
    .bind(reason, id)
    .run();
  if (res.meta.changes) await db().prepare(`UPDATE partner_commissions SET payout_id = NULL WHERE payout_id = ? AND status <> 'paid'`).bind(id).run();
  return res.meta.changes > 0;
}

/**
 * Cancel from /admin: a Stripe payout whose transfer went out after all (the run broke before it was recorded) is
 * marked paid instead, so its commissions can't be paid twice.
 */
export async function cancelPayoutChecked(id: number, now = Date.now()): Promise<'canceled' | 'paid' | 'unchanged'> {
  const payout = await db().prepare(`SELECT method, status FROM partner_payouts WHERE id = ?`).bind(id).first<{ method: string; status: string }>();
  if (!payout) return 'unchanged';
  if (payout.method === 'stripe' && payout.status !== 'proposed') {
    const sent = await stripe().transfers.list({ transfer_group: `partner_payout_${id}`, limit: 1 });
    if (sent.data[0]) return (await markPayoutPaid(id, { transferId: sent.data[0].id }, now)) ? 'paid' : 'unchanged';
  }
  return (await cancelPayout(id, 'canceled in admin')) ? 'canceled' : 'unchanged';
}

/**
 * Marks a payout paid (Stripe transfer or a PayPal payment made by hand) together with its commissions, in one
 * transaction, and tells the partner. `amount`: what was actually sent; a payout that changed since stays open.
 */
export async function markPayoutPaid(id: number, done: { transferId?: string; reference?: string; amount?: number }, now = Date.now()) {
  const [res] = await db().batch([
    db()
      .prepare(
        `UPDATE partner_payouts SET status = 'paid', paid_at = ?, stripe_transfer_id = COALESCE(?, stripe_transfer_id),
           reference = COALESCE(?, reference), error = NULL
         WHERE id = ? AND status IN ('proposed', 'approved', 'failed') AND (? IS NULL OR amount_cents = ?)`,
      )
      .bind(now, done.transferId ?? null, done.reference ?? null, id, done.amount ?? null, done.amount ?? null),
    db()
      .prepare(
        `UPDATE partner_commissions SET status = 'paid' WHERE payout_id = ? AND status = 'available'
           AND EXISTS (SELECT 1 FROM partner_payouts WHERE id = ? AND status = 'paid' AND paid_at = ?)`,
      )
      .bind(id, id, now),
  ]);
  if (!res.meta.changes) return false;
  const row = await db()
    .prepare(`SELECT pp.amount_cents, pp.method, p.id AS partner_id, p.email, p.name FROM partner_payouts pp JOIN partners p ON p.id = pp.partner_id WHERE pp.id = ?`)
    .bind(id)
    .first<{ amount_cents: number; method: string; partner_id: number; email: string; name: string }>();
  if (row) await notify(row.partner_id, `payout:${id}`, row.email, payoutMail(row.name, row.amount_cents, row.method));
  return true;
}

const capCents = () => {
  const raw = env.PARTNER_PAYOUT_MONTHLY_CAP_EUR;
  const v = raw == null || raw === '' ? PARTNERS.monthlyCapEur : Number(raw);
  return Math.round((Number.isFinite(v) && v >= 0 ? v : PARTNERS.monthlyCapEur) * 100);
};

/**
 * Sends every approved Stripe payout (approved in /admin/partners, or by setting status = 'approved' in D1) as a
 * Connect transfer in EUR, for active partners. Past the monthly cap they wait, approved, with error "over monthly cap".
 */
export async function executeApprovedPayouts(now = Date.now(), only?: number) {
  const live = liveFlag();
  const rows = await db()
    .prepare(
      `SELECT pp.id, pp.partner_id, pp.amount_cents, p.status AS partner_status, p.stripe_account_id, p.stripe_payouts_enabled,
         (SELECT COALESCE(SUM(c.amount_cents), 0) FROM partner_commissions c WHERE c.payout_id = pp.id AND c.status = 'available') AS carried
       FROM partner_payouts pp JOIN partners p ON p.id = pp.partner_id
       WHERE pp.status = 'approved' AND pp.method = 'stripe' AND pp.livemode = ? AND (? IS NULL OR pp.id = ?)
       ORDER BY COALESCE(pp.approved_at, pp.created_at), pp.id`,
    )
    .bind(live, only ?? null, only ?? null)
    .all<{
      id: number;
      partner_id: number;
      amount_cents: number;
      partner_status: PartnerStatus;
      stripe_account_id: string | null;
      stripe_payouts_enabled: number;
      carried: number;
    }>();
  if (!rows.results?.length) return [];

  const sentRow = await db()
    .prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS sent FROM partner_payouts WHERE method = 'stripe' AND status = 'paid' AND paid_at >= ? AND livemode = ?`)
    .bind(monthStartOf(now), live)
    .first<{ sent: number }>();
  let sent = Number(sentRow?.sent ?? 0);
  const cap = capCents();
  const setError = (id: number, error: string, status?: 'failed') =>
    db()
      .prepare(`UPDATE partner_payouts SET error = ?, status = COALESCE(?, status) WHERE id = ?`)
      .bind(error.slice(0, 300), status ?? null, id)
      .run();

  const paid: number[] = [];
  for (const p of rows.results) {
    const amount = p.amount_cents;
    if (p.partner_status !== 'active') {
      await setError(p.id, `partner is ${p.partner_status}`);
      continue;
    }
    if (amount <= 0 || Number(p.carried) !== amount) {
      await setError(p.id, 'amount no longer matches its commissions: cancel and propose again');
      continue;
    }
    if (sent + amount > cap) {
      await setError(p.id, 'over monthly cap');
      continue;
    }
    if (!p.stripe_account_id || !p.stripe_payouts_enabled) {
      await setError(p.id, 'Stripe account not ready for payouts');
      continue;
    }
    const group = `partner_payout_${p.id}`;
    try {
      const existing = await stripe().transfers.list({ transfer_group: group, limit: 1 });
      const transfer =
        existing.data[0] ??
        (await stripe().transfers.create(
          {
            amount,
            currency: 'eur',
            destination: p.stripe_account_id,
            transfer_group: group,
            description: `${PARTNERS.name} payout`,
            metadata: { payout_id: String(p.id), partner_id: String(p.partner_id) },
          },
          { idempotencyKey: group },
        ));
      await markPayoutPaid(p.id, { transferId: transfer.id }, now);
      sent += amount;
      paid.push(p.id);
    } catch (e) {
      const err = e as { type?: string; message?: string };
      const permanent = err.type === 'StripeInvalidRequestError' || err.type === 'StripePermissionError';
      console.error('partner payout failed', p.id, err.message);
      await setError(p.id, err.message ?? 'transfer failed', permanent ? 'failed' : undefined);
    }
  }
  return paid;
}

/** Hourly cron. */
export async function runPartners(now = Date.now()) {
  await releaseHeld(now);
  if (new Date(now).getUTCDate() === 1) await proposePayouts(now);
  await executeApprovedPayouts(now);
  await createMissingPromotionCodes(5);
}

// Emails ------------------------------------------------------------------------------------------------------------

const SIGN = 'Daniel\nFounder, Godmode';
const hi = (name: string) => (firstName(name) ? `Hi ${firstName(name)},` : 'Hi,');
const longDate = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

async function notify(partnerId: number, kind: string, to: string, mail: ReturnType<typeof render>) {
  if (!env.EMAIL) return;
  await sendOnce({ sessionId: `partner:${partnerId}`, kind, to, mail }).catch((e) => console.error('partner email failed', kind, e));
}

export const saleMail = (name: string, amount: number, plan: string, availableAt: number) =>
  render(`New sale: you earned ${cents(amount)}`, [
    hi(name),
    `someone you brought to Godmode just paid for ${plan}. You earned ${cents(amount)}.`,
    `It becomes available on ${longDate(availableAt)}, after the refund window, and goes out with the next monthly payout.`,
    { button: 'Open your dashboard', url: `${base()}/partners/dashboard` },
    'Keep posting.',
    SIGN,
  ]);

export const payoutMail = (name: string, amount: number, method: string) =>
  render(`Payout sent: ${cents(amount)}`, [
    hi(name),
    method === 'paypal'
      ? `I just sent ${cents(amount)} to your PayPal account.`
      : `I just sent ${cents(amount)} to your Stripe account. Stripe pays it out to your bank in the next few days.`,
    `Every commission in it is listed in your dashboard:\n${base()}/partners/dashboard`,
    'Thanks for spreading the word.',
    SIGN,
  ]);

export async function sendWelcomeMail(p: Partner) {
  const url = `${base()}/partners/auth?t=${encodeURIComponent(await loginToken(p))}`;
  return sendMail(
    p.email,
    render(`Welcome to ${PARTNERS.name}`, [
      hi(p.name),
      `welcome aboard. Your link and code are ready:`,
      `Link: ${partnerLink(p.code)}\nCode: ${p.code} (${PARTNERS.discountPercent}% off the first month for your viewers)`,
      'Confirm your email so we can pay you:',
      { button: 'Confirm email', url },
      `The button works for 30 minutes. You can always get a new sign-in link at ${base()}/partners/login`,
      'One rule before you post: mark every video as an ad, with #ad in the caption and the platform’s paid-partnership label switched on.',
      `Hooks, talking points and videos to cut: ${base()}/partners/kit`,
      'Questions? Just reply, this comes straight to me.',
      SIGN,
    ]),
  );
}

export const sendPayoutChangeMail = (p: Partner, paypal: string) =>
  sendMail(
    p.email,
    render(`Your ${PARTNERS.name} payouts now go to ${paypal}`, [
      hi(p.name),
      `your payouts now go to the PayPal account ${paypal}.`,
      'If that wasn’t you, reply right away and I’ll stop your payouts until we sort it out.',
      SIGN,
    ]),
  );

export async function sendLoginMail(p: Partner) {
  const url = `${base()}/partners/auth?t=${encodeURIComponent(await loginToken(p))}`;
  return sendMail(
    p.email,
    render(`Your ${PARTNERS.name} sign-in link`, [
      hi(p.name),
      'here is your sign-in link:',
      { button: 'Sign in', url },
      'It works once, for 30 minutes. If you did not ask for it, ignore this email.',
      SIGN,
    ]),
  );
}
