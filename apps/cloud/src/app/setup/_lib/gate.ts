/** Pure decisions of src/proxy.ts, kept apart so they can be tested without a request. */
import type { SetupGate } from "@/server/setup";

/**
 * Where a page request must go instead, or null to let it through.
 * - "claim" (nobody has an account): everything goes to /setup.
 * - "wizard" (the owner exists, setup is unfinished): signing in, signing out and invitation links work (the
 *   invitation page says the cloud is still being set up); everything else goes to /setup.
 * - "done": /setup is over and leads to the start page.
 */
export function gateRedirect(gate: SetupGate, pathname: string): string | null {
  const setup = pathname === "/setup" || pathname.startsWith("/setup/");
  if (gate === "done") return setup ? "/" : null;
  if (setup) return null;
  if (gate === "claim") return "/setup";
  const open = pathname === "/login" || pathname === "/auth/verify" || pathname === "/logout" || pathname.startsWith("/invite/");
  return open ? null : "/setup";
}

/** The page CSP. Scripts need the per-request nonce; `'unsafe-eval'` exists only for the development tooling. */
export function contentSecurityPolicy(nonce: string, development: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
  ].join("; ");
}
