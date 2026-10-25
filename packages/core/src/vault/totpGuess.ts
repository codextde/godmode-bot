/**
 * Best guess which 2FA entry belongs to a login that has none linked: the issuer is compared with the login's
 * brand (name, URL and domains, fuzzy and with a few known aliases), the account name with its username.
 * A guess is tried on the login's own site only; when the site accepts the code the pair is linked for good
 * (see vault_fill_totp). Pairs that are sure enough are offered to the human to link in one click.
 */
import type { Credential, TotpAutoLinkSuggestion, TotpEntry } from "@godmode/shared";
import { hostnameOf } from "../util";
import { siteLabel } from "./match";

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Brands that sign in under another name (the issuer an authenticator shows vs. the site's domain). */
const ALIASES: string[][] = [
  ["aws", "amazonwebservices", "amazonaws", "awsamazon"],
  ["google", "gmail", "youtube", "googleworkspace", "gsuite"],
  ["microsoft", "live", "outlook", "office", "office365", "microsoftonline", "azure", "xbox", "hotmail"],
  ["x", "twitter"],
  ["meta", "facebook", "instagram", "fb", "whatsapp"],
  ["apple", "icloud", "appleid"],
  ["atlassian", "jira", "confluence", "bitbucket", "trello"],
  ["shopify", "myshopify"],
  ["godaddy", "secureserver"],
  ["digitalocean", "do"],
  ["cloudflare", "cf"],
  ["proton", "protonmail", "protonme"],
];
const ALIAS_OF = new Map<string, number>();
ALIASES.forEach((group, i) => group.forEach((name) => ALIAS_OF.set(name, i)));

/** Words that say nothing about the brand. */
const NOISE = new Set([
  ...["www", "login", "signin", "account", "accounts", "auth", "app", "my", "admin", "portal", "secure", "id", "sso", "the", "and"],
  ...["com", "de", "net", "org", "io", "inc", "gmbh", "ltd", "llc", "business", "work", "personal", "private", "privat", "dashboard"],
  ...["console", "online", "cloud", "mail", "test", "dev", "prod", "team", "company", "new", "old"],
]);

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** How alike two brand tokens are, 0..1. */
function tokenSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ga = ALIAS_OF.get(a);
  if (ga !== undefined && ga === ALIAS_OF.get(b)) return 0.95;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  // A short brand inside a much longer one ("meta" in "metabase") is only worth trying, never sure.
  const share = short.length / long.length;
  if (short.length >= 4 && long.startsWith(short)) return share > 0.5 ? 0.85 : 0.65;
  if (short.length >= 4 && long.includes(short)) return share > 0.5 ? 0.75 : 0.62;
  if (short.length < 4) return 0;
  const ratio = 1 - levenshtein(a, b) / long.length;
  return ratio >= 0.75 ? ratio * 0.85 : 0;
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !NOISE.has(w));
}

/** Brand tokens of a login: its name (whole + words) and the label of each of its sites. */
export function loginBrandTokens(cred: Pick<Credential, "name" | "url" | "domains">): Set<string> {
  const out = new Set<string>();
  const whole = compact(cred.name);
  if (whole) out.add(whole);
  for (const w of words(cred.name)) out.add(w);
  for (const site of [...cred.domains, cred.url]) {
    const label = site ? siteLabel(site) : "";
    if (label && !NOISE.has(label)) out.add(label);
  }
  return out;
}

/** Brand tokens of a 2FA entry: its issuer, or (when there is none) the part of the account name before a colon or a site in it. */
export function totpBrandTokens(entry: Pick<TotpEntry, "issuer" | "accountName">): Set<string> {
  const out = new Set<string>();
  const add = (s: string) => {
    const whole = compact(s);
    if (whole) out.add(whole);
    for (const w of words(s)) out.add(w);
    const host = hostnameOf(s.trim());
    if (host.includes(".") && !/\s/.test(s.trim())) {
      const label = siteLabel(host);
      if (label) out.add(label);
    }
  };
  if (entry.issuer.trim()) add(entry.issuer);
  const prefix = entry.accountName.includes(":") ? entry.accountName.split(":")[0]! : "";
  if (prefix.trim()) add(prefix);
  if (!out.size && entry.accountName && !entry.accountName.includes("@")) add(entry.accountName);
  return out;
}

/** How well the 2FA entry's site matches the login's, 0..1. */
export function brandScore(cred: Pick<Credential, "name" | "url" | "domains">, entry: Pick<TotpEntry, "issuer" | "accountName">): number {
  const a = loginBrandTokens(cred);
  const b = totpBrandTokens(entry);
  let best = 0;
  for (const x of a) for (const y of b) best = Math.max(best, tokenSimilarity(x, y));
  return best;
}

/** How well the 2FA entry's account matches the login's username, 0..1. */
export function accountScore(username: string, accountName: string): number {
  const u = username.trim().toLowerCase();
  const raw = accountName.trim().toLowerCase();
  const acc = raw.includes(":") ? raw.slice(raw.lastIndexOf(":") + 1).trim() : raw;
  if (!u || !acc) return 0;
  if (u === acc) return 1;
  const local = (s: string) => (s.includes("@") ? s.slice(0, s.indexOf("@")) : s);
  if (local(u).length >= 3 && local(u) === local(acc)) return 0.7;
  const [short, long] = u.length <= acc.length ? [u, acc] : [acc, u];
  if (short.length >= 4 && long.includes(short)) return 0.5;
  return 0;
}

/** Likelihood (0..1) that `entry` is the 2FA of `cred`. The site has to match: a shared email alone proves nothing. */
export function totpMatchScore(
  cred: Pick<Credential, "name" | "url" | "domains" | "username">,
  entry: Pick<TotpEntry, "issuer" | "accountName">,
): number {
  const brand = brandScore(cred, entry);
  if (brand < 0.6) return 0;
  const account = accountScore(cred.username, entry.accountName);
  const hasAccount = !!entry.accountName.trim() && !!cred.username.trim();
  // A different account on the same site is a weaker guess, not a wrong one (an alias or display name).
  return Math.round((brand * 0.7 + (hasAccount ? account : 0.5) * 0.3) * 1000) / 1000;
}

/** Lowest score worth typing a guessed code for. */
export const GUESS_MIN_SCORE = 0.5;
/** A pair this sure (and without a close rival) is offered for one-click linking. */
export const SURE_SCORE = 0.8;
const RIVAL_GAP = 0.1;

const linkCompatible = (credWs: string | null, totpWs: string | null) => totpWs === null || totpWs === credWs;

/** Free 2FA entries that could belong to this login, most likely first. */
export function rankTotpGuesses(cred: Credential, entries: TotpEntry[], exclude: ReadonlySet<string> = new Set()): { entry: TotpEntry; score: number }[] {
  return entries
    .filter((t) => !t.credentialId && !exclude.has(t.id) && linkCompatible(cred.workspaceId, t.workspaceId))
    .map((entry) => ({ entry, score: totpMatchScore(cred, entry) }))
    .filter((g) => g.score >= GUESS_MIN_SCORE)
    .sort((a, b) => b.score - a.score);
}

/**
 * One-to-one pairs of logins without 2FA and free 2FA entries, best first. `sure` marks pairs that win clearly on
 * both sides (no rival within RIVAL_GAP for the login or the entry).
 */
export function suggestTotpLinks(creds: Credential[], entries: TotpEntry[]): TotpAutoLinkSuggestion[] {
  const freeCreds = creds.filter((c) => !c.totpId);
  const freeTotp = entries.filter((t) => !t.credentialId);
  const pairs: { credentialId: string; totpId: string; score: number }[] = [];
  for (const c of freeCreds) {
    for (const t of freeTotp) {
      if (!linkCompatible(c.workspaceId, t.workspaceId)) continue;
      const score = totpMatchScore(c, t);
      if (score >= GUESS_MIN_SCORE) pairs.push({ credentialId: c.id, totpId: t.id, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const usedCred = new Set<string>();
  const usedTotp = new Set<string>();
  const out: TotpAutoLinkSuggestion[] = [];
  for (const p of pairs) {
    if (usedCred.has(p.credentialId) || usedTotp.has(p.totpId)) continue;
    usedCred.add(p.credentialId);
    usedTotp.add(p.totpId);
    const rival = pairs.some(
      (q) => q !== p && (q.credentialId === p.credentialId || q.totpId === p.totpId) && q.score > p.score - RIVAL_GAP,
    );
    out.push({ ...p, sure: p.score >= SURE_SCORE && !rival });
  }
  return out;
}
