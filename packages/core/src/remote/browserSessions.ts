/**
 * Browser sign-ins on the other computers (owner: remote): which of a profile's cookies the controller copies to a
 * runner or a device of the group before a chat starts there (`copyCookies` in runners.ts), and which of them the other
 * computer takes (`POST /api/link/browser/:profileId/cookies`).
 *
 *  runners   get every session except those of session-bound sites; they replace what the runner had
 *  devices   `own` (default): nothing, each computer signs in by itself with the saved logins and 2FA codes;
 *            `seed`: the same as a runner, but only for sites the device has no cookies for yet
 *
 * The receiver never takes a session-bound site's cookies, so an older controller can't sign it out either.
 */
import type { BrowserSignIns, RunnerKind } from "@godmode/shared";
import { getMeta, setMeta } from "../db";
import { badRequest } from "../util";
import { baseDomain } from "../vault/passwordImport";

/** How the other computer takes the cookies: `replace` overwrites its own, `seed` only fills sites it has none for. */
export type CookieMode = "seed" | "replace";

/** A cookie as read from a browser (`domain`) or as set for one host (`url`). */
interface CookieSite {
  domain?: string;
  url?: string;
}

const SIGN_INS_META = "link.group.browserSignIns";

/**
 * Sites that sign a session out everywhere when its cookies show up on a second computer (session theft protection,
 * device-bound sessions) or bind it to one device. `name.*`: that name under every country domain (google.de,
 * google.co.uk); anything else: the domain and its subdomains.
 */
const SESSION_BOUND = [
  "google.*",
  "youtube.*",
  "gmail.com",
  "live.com",
  "microsoftonline.com",
  "microsoft.com",
  "microsoft365.com",
  "cloud.microsoft",
  "office.com",
  "office365.com",
  "outlook.com",
  "bing.com",
  "apple.com",
  "icloud.com",
  "amazon.*",
  "paypal.*",
  "facebook.com",
  "instagram.com",
  "whatsapp.com",
  "messenger.com",
  "linkedin.com",
  "x.com",
  "twitter.com",
  "tiktok.com",
  "accounts.shopify.com",
  "stripe.com",
  "klarna.*",
  "adyen.com",
  "mollie.com",
  "revolut.com",
  "wise.com",
  "n26.com",
  "bunq.com",
  "qonto.com",
  "coinbase.com",
  "sparkasse.de",
  "ing.de",
  "dkb.de",
  "comdirect.de",
  "commerzbank.de",
  "deutsche-bank.de",
  "postbank.de",
];

const BRANDS = SESSION_BOUND.filter((s) => s.endsWith(".*")).map((s) => s.slice(0, -2));
const DOMAINS = SESSION_BOUND.filter((s) => !s.endsWith(".*"));
/** `name.` followed by a country domain, also with a second level (`co.uk`, `com.au`), at the end of the host. */
const BRAND_RE = new RegExp(`(^|\\.)(${BRANDS.join("|")})\\.((co|com|org|net|ne|or|gob|ac)\\.)?[a-z]{2,}$`);

function bare(domain: string): string {
  return domain.trim().toLowerCase().replace(/^\.+/, "").replace(/\.$/, "");
}

function hostOf(c: CookieSite): string {
  if (c.domain) return bare(c.domain);
  try {
    return c.url ? bare(new URL(c.url).hostname) : "";
  } catch {
    return "";
  }
}

/** A site whose sessions never go to another computer: there it signs in by itself. */
export function sessionBoundSite(domain: string): boolean {
  const host = bare(domain);
  if (!host) return false;
  return BRAND_RE.test(host) || DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** How browser sign-ins reach the devices of the group (the primary's choice). */
export function browserSignIns(): BrowserSignIns {
  return getMeta(SIGN_INS_META) === "seed" ? "seed" : "own";
}

export function setBrowserSignIns(value: BrowserSignIns): void {
  if (value !== "own" && value !== "seed") throw badRequest('Browser sign-ins are "own" or "seed"');
  setMeta(SIGN_INS_META, value);
}

/** What of a profile's cookies goes to a runner or a device, and how it takes them. */
export function cookiesFor<T extends CookieSite>(kind: RunnerKind, policy: BrowserSignIns, cookies: T[]): { cookies: T[]; mode: CookieMode } {
  if (kind === "device" && policy === "own") return { cookies: [], mode: "seed" };
  return { cookies: cookies.filter((c) => !sessionBoundSite(hostOf(c))), mode: kind === "device" ? "seed" : "replace" };
}

/**
 * What this computer takes of the cookies another one copies here: never a session-bound site's (an older controller
 * still sends them), and with `seed` only those of sites (registrable domains) the profile has no cookies for yet.
 */
export function acceptedCookies<T extends CookieSite>(incoming: T[], mode: CookieMode, existing: CookieSite[]): T[] {
  const known = mode === "seed" ? new Set(existing.map((c) => baseDomain(hostOf(c)))) : null;
  return incoming.filter((c) => {
    const host = hostOf(c);
    return !sessionBoundSite(host) && !known?.has(baseDomain(host));
  });
}
