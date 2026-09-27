/**
 * Brand/name matching used to *guess* which saved login a site belongs to when nothing matches it by domain.
 * A name guess is a hint, never proof: it may surface a login in vault_list_logins and — only for an exact brand
 * match — let Godmode try (and then remember) a login on a site the human forgot to tag. A secret is still only
 * ever typed onto a host the credential's own scope or that exact-brand check allows (see browser/fill.ts).
 */
import { hostnameOf } from "../util";

/** Second-level labels of common multi-part public suffixes, so "bitpanda.co.uk" still yields "bitpanda" (best-effort; not a full public-suffix list). */
const MULTI_PART_SLD = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "gob", "or", "ne", "go"]);

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Brand-ish label of a host or URL: the label just left of its public suffix (e.g. `account.bitpanda.com` → "bitpanda"). IPs and single-label hosts return themselves. */
export function siteLabel(hostOrUrl: string): string {
  const host = hostnameOf(hostOrUrl);
  if (!host) return "";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || !host.includes(".")) return compact(host);
  const parts = host.split(".").filter(Boolean);
  parts.pop(); // public suffix (TLD)
  if (parts.length >= 2 && MULTI_PART_SLD.has(parts[parts.length - 1]!)) parts.pop();
  return compact(parts[parts.length - 1] ?? "");
}

interface NameLike {
  name: string;
  url: string;
  domains: string[];
}

/** Tokens from a credential's name: the whole name compacted, plus each word. */
function nameTokens(cred: NameLike): Set<string> {
  const tokens = new Set<string>();
  const whole = compact(cred.name);
  if (whole) tokens.add(whole);
  for (const word of cred.name.toLowerCase().split(/[^a-z0-9]+/)) {
    const w = compact(word);
    if (w) tokens.add(w);
  }
  return tokens;
}

/** Name tokens plus the brand label of each declared domain/URL — used for the exact-brand check that may extend a fill's scope. */
function brandTokens(cred: NameLike): Set<string> {
  const tokens = nameTokens(cred);
  for (const d of cred.domains) {
    const l = siteLabel(d);
    if (l) tokens.add(l);
  }
  const urlLabel = siteLabel(cred.url);
  if (urlLabel) tokens.add(urlLabel);
  return tokens;
}

/**
 * Does this credential look like it belongs to `hostOrUrl` by name/brand?
 * - loose (default): the site's brand label matches one of the credential's name tokens (either contains the
 *   other) — used only to *surface* a guess in listings.
 * - strict: the site's brand label exactly equals one of the credential's name or declared-site brand tokens —
 *   the only name signal allowed to type a secret onto (and then remember) a site the credential does not list.
 */
export function nameGuessMatchesHost(cred: NameLike, hostOrUrl: string, opts: { strict?: boolean } = {}): boolean {
  const label = siteLabel(hostOrUrl);
  if (label.length < 3) return false;
  if (opts.strict) return brandTokens(cred).has(label);
  for (const token of nameTokens(cred)) {
    if (token.length < 3) continue;
    if (token === label || token.includes(label) || label.includes(token)) return true;
  }
  return false;
}
