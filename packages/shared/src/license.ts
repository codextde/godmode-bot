import type { ISODate } from "./models";

/** `GM-XXXXX-XXXXX-XXXXX-XXXXX` in Crockford base32 (no I, L, O, U). */
export const LICENSE_KEY_PATTERN = /^GM(-[0-9A-HJKMNP-TV-Z]{5}){4}$/;

/** A key as typed or pasted: trimmed and upper case. */
export function normalizeLicenseKey(input: string): string {
  return input.trim().toUpperCase();
}

export function isLicenseKey(input: string): boolean {
  return LICENSE_KEY_PATTERN.test(normalizeLicenseKey(input));
}

/** `godmode://license?key=GM-…`: the welcome page after checkout hands the key to the desktop app with it. */
export function licenseDeepLink(key: string): string {
  return `godmode://license?key=${encodeURIComponent(normalizeLicenseKey(key))}`;
}

const LICENSE_LINK = /^godmode:\/\/license\/?\?([^#]*)/i;

/** The licence key in a `godmode://license?key=…` link, or null for any other link. */
export function licenseKeyFromDeepLink(link: string): string | null {
  const query = LICENSE_LINK.exec(link.trim())?.[1];
  const value = query?.split("&").find((part) => part.startsWith("key="))?.slice(4);
  if (!value) return null;
  try {
    const key = normalizeLicenseKey(decodeURIComponent(value));
    return isLicenseKey(key) ? key : null;
  } catch {
    return null;
  }
}

/** How long a new install without a key runs free. */
export const LICENSE_FREE_DAYS = 14;

/** Godmode Pro's prices in USD, as sold on usegodmode.com (keep in step with the site's PRICING). */
export const LICENSE_PRICING = {
  guaranteeDays: 14,
  monthly: { perMonth: 39, price: 39 },
  yearly: { perMonth: 29, price: 348 },
} as const;

/** What the yearly plan saves against twelve months, in percent (rounded down). */
export const LICENSE_YEARLY_SAVINGS = Math.floor((1 - LICENSE_PRICING.yearly.price / (LICENSE_PRICING.monthly.price * 12)) * 100);

/** GET /api/license/usage: what Godmode did on this computer so far, for the end of the free trial. */
export interface LicenseUsage {
  /** Since when: the first start, or the first run when that came earlier. */
  since: ISODate | null;
  /** Finished runs started by the human, an automation or the API (not condition checks, memory or heartbeats). */
  tasksDone: number;
  /** Of `tasksDone`, the ones an automation started. */
  automationRuns: number;
  /** How long those runs worked, in minutes. */
  minutesWorked: number;
  agents: number;
  /** Automations that are switched on. */
  automations: number;
  /** Logins saved in the vault. */
  logins: number;
}

/**
 * - `active`, `trial`, `past_due` (Stripe still retries the payment): the key is good.
 * - `grace`: the free trial: an install without a key runs free for `LICENSE_FREE_DAYS` from its first start.
 * - `unverified`: a key that could not be checked yet; accepted for 7 days after it was entered.
 * - `missing`, `invalid`, `expired`: new runs are refused (in release builds).
 */
export type LicenseStatus = "active" | "trial" | "past_due" | "grace" | "unverified" | "missing" | "invalid" | "expired";

export type LicensePlan = "monthly" | "yearly" | "lifetime";

/** GET /api/license */
export interface LicenseState {
  status: LicenseStatus;
  plan: LicensePlan | null;
  /** The key's last 5 characters; the full key never leaves the core. */
  keyHint: string | null;
  trialEndsAt: ISODate | null;
  renewsAt: ISODate | null;
  cancelAtPeriodEnd: boolean;
  /** The end of the free trial of an install without a key (set once, never extended). */
  graceEndsAt: ISODate | null;
  /** The end of the window an unverified key is accepted for. */
  unverifiedUntil: ISODate | null;
  /** The last answer from the licence server. */
  checkedAt: ISODate | null;
  /** The Stripe customer portal for this licence. */
  manageUrl: string | null;
  /** One sentence for the human: why runs are refused, or what needs attention. */
  message: string | null;
  /** This build checks licences (release builds only). */
  enforced: boolean;
  /** New runs are refused right now. */
  blocked: boolean;
}

/** PUT /api/license */
export interface LicenseKeyInput {
  key: string;
}

/** Error code of a refused run start (HTTP 402). */
export const LICENSE_REQUIRED = "license_required";
/** Error code of a key the licence server doesn't know (HTTP 400). */
export const LICENSE_INVALID = "license_invalid";
