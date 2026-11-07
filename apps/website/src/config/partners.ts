// Godmode Partners: the program's numbers and the content kit. Change the numbers here only; pages, emails,
// the webhook and the payout cron all read them from this file.
import { PRICING, SITE, type Plan } from './site';

export const PARTNERS = {
  name: 'Godmode Partners',
  /** Default share of every payment, in basis points (per partner in partners.rate_bps). */
  rateBps: 2000,
  /** Months after a customer's first payment that earn commission. */
  months: 12,
  /** Commission is held this long (money-back guarantee and chargebacks), then becomes available. */
  holdDays: 30,
  minPayoutEur: 25,
  cookieDays: 60,
  /** Viewers who enter a partner's code at checkout: this much off their first month (one shared Stripe coupon). */
  discountPercent: 20,
  couponId: 'godmode_partner_first_month',
  /** Stripe payouts the cron sends per calendar month at most (env PARTNER_PAYOUT_MONTHLY_CAP_EUR overrides it). */
  monthlyCapEur: 1000,
  termsUpdated: 'November 6, 2026',
} as const;

export const ratePercent = (bps: number = PARTNERS.rateBps) => Math.round(bps) / 100;

/** What one paying customer on a plan earns the partner per month, in EUR (before tax is taken off). */
export const perCustomer = (plan: Plan, bps: number = PARTNERS.rateBps) => (PRICING.plans[plan].price * bps) / 10000;

/** "€9.80", "€1,197.60" */
export const euro = (amount: number, digits = 2) =>
  new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);

export const partnerLink = (code: string) => `${SITE.url.replace(/\/$/, '')}/r/${code}`;

/** Codes partners can't take: they would read like Godmode's own offers. */
export const RESERVED_CODES = new Set(['GODMODE', 'ADMIN', 'TEST', 'FREE', 'STRIPE', 'CODEXT', 'DANIEL', 'SUPPORT', 'PARTNER', 'PARTNERS', 'FOUNDING20']);

/**
 * Countries where Stripe can pay a partner from Codext GmbH's German account (Connect cross-border payouts: US, UK,
 * EEA, Canada, Switzerland). Everyone else gets paid by PayPal.
 */
export const STRIPE_PAYOUT_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'CA', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT',
  'LI', 'LT', 'LU', 'LV', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'US',
]);

// ISO 3166-1 alpha-2, for the country picker (names come from Intl.DisplayNames).
const ISO =
  'AD AE AF AG AL AM AO AR AT AU AZ BA BB BD BE BF BG BH BJ BN BO BR BS BT BW BY BZ CA CD CH CI CL CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ES ET FI FJ FR GA GB GD GE GH GM GN GR GT GY HK HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KN KR KW KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MK ML MM MN MO MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NZ OM PA PE PG PH PK PL PR PS PT PY QA RO RS RU RW SA SC SD SE SG SI SK SL SM SN SO SR SV SY TG TH TJ TN TR TT TW TZ UA UG US UY UZ VC VE VN YE ZA ZM ZW';

export const COUNTRIES: { code: string; name: string }[] = (() => {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    /* no ICU data: show the codes */
  }
  return ISO.split(' ')
    .map((code) => ({ code, name: names?.of(code) ?? code }))
    .sort((a, b) => a.name.localeCompare(b.name));
})();

export const isCountry = (v: string) => ISO.split(' ').includes(v);

// Content kit (/partners/kit) ---------------------------------------------------------------------------------

export const KIT = {
  hooks: [
    'I gave an AI my Mac for a day. Here is what it got done.',
    'This AI logs into my accounts and does my admin while I watch.',
    'Chatbots tell you how. This one clicks through it for you.',
    'It compared prices in three shops before I found my wallet.',
    'My AI coworker downloads every invoice I need, every Monday.',
    'Watch it type my 2FA code without ever seeing it.',
    'I stopped doing this boring task by hand.',
  ],
  talkingPoints: [
    'Godmode is an AI coworker for your Mac. You tell it a task in plain words and it does the job start to finish in your own browser and apps.',
    'It works with your real logins. Passwords and 2FA codes stay in an encrypted vault on your Mac; the AI only sees “Secret hidden”.',
    'It asks before important steps like sending, paying, deleting or posting. You can watch every step live and take over with one click.',
    'Automations run on a schedule or when an email arrives, for example invoices every Monday or a weekly ad report.',
    `Free for ${PRICING.freeDays} days with no card and no sign-up. Then €${PRICING.plans.private.price}/month for private use or €${PRICING.plans.company.price}/month for companies.`,
  ],
  facts: [
    ['Made by', 'Codext GmbH, Germany'],
    ['Runs on', 'Mac (Apple chip or Intel)'],
    ['Needs', 'A Claude Pro or Max plan, or an Anthropic API key'],
    ['Free period', `${PRICING.freeDays} days, no card`],
    ['Price', `€${PRICING.plans.private.price}/month Private, €${PRICING.plans.company.price}/month Company`],
    ['Money-back', `${PRICING.guaranteeDays} days on the first payment`],
    ['Website', 'usegodmode.com'],
  ] as [string, string][],
  videos: [
    { file: '/media/ad-vm-9x16.mp4', poster: '/media/ad-vm-9x16.jpg', title: 'Vertical demo (9:16)', note: 'Ready for TikTok, Reels and Shorts' },
    { file: '/media/ad-main-1x1.mp4', poster: '/media/ad-main-1x1.jpg', title: 'Square demo (1:1)', note: 'Main ad cut' },
    { file: '/media/ad-vault-1x1.mp4', poster: '/media/ad-vault-1x1.jpg', title: 'Password vault (1:1)', note: 'Logins and 2FA without the AI seeing them' },
    { file: '/media/ad-main-16x9.mp4', poster: '/media/ad-main-16x9.jpg', title: 'Landscape demo (16:9)', note: 'For YouTube and X' },
  ],
  dos: [
    'Show a real task from start to finish. Results beat features.',
    'Say your link or code out loud and put it in the caption.',
    'Cut fast: the recordings are sped up, say so if you show a time.',
    'Reply to comments with your link where the platform allows it.',
  ],
  donts: [
    'No claims Godmode can’t back up, no income or “get rich” promises.',
    'Don’t say it is made by, or partnered with, Anthropic or Apple.',
    'No spam: no mass comments, DMs or emails.',
    'No paid ads on the Godmode name, and no ads that look like Godmode’s own.',
    'Don’t pose as Godmode or Daniel, and don’t use fake reviews.',
    'No paying or rewarding people to install, sign up or click.',
    'Never show your passwords, codes or other private data on screen.',
  ],
  disclosure: 'Mark every post as an ad: put #ad in the caption and switch on the platform’s paid-partnership label where there is one.',
  caption: (code: string) =>
    `I let an AI do my computer work. It is called Godmode, free for ${PRICING.freeDays} days: ${partnerLink(code).replace(/^https?:\/\//, '')} (code ${code} = ${PARTNERS.discountPercent}% off your first month) #ad`,
} as const;
