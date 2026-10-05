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

/**
 * - `active`, `trial`, `past_due` (Stripe still retries the payment): the key is good.
 * - `grace`: an install from before licences has 7 days to add a key.
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
  /** Existing installs: the end of the 7-day window to add a key (set once, never extended). */
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
