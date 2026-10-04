/**
 * Runs before every page request (Next 16's proxy, Node runtime): the per-request CSP nonce, security headers, the
 * first-run redirect to /setup, and re-sending a session cookie whose lifetime was extended.
 *
 * Machine APIs (/api/*, including the Stripe webhook), static files and the paths the custom server answers itself
 * (/ui, /d, /gw, /relay) never come through here; see `config.matcher`.
 */
import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy, gateRedirect } from "@/app/setup/_lib/gate";
import { sessionCookieName, sessionCookieOptions, validateSessionToken } from "@/server/auth/sessions";
import { isSecureSite } from "@/server/config";
import { getSettings } from "@/server/settings";
import { setupGate, type SetupGate } from "@/server/setup";

const DAY_MS = 86_400_000;

function withSecurityHeaders(response: NextResponse, csp: string): NextResponse {
  response.headers.set("content-security-policy", csp);
  response.headers.set("x-frame-options", "DENY");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  response.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), browsing-topics=()");
  if (isSecureSite()) response.headers.set("strict-transport-security", "max-age=31536000");
  return response;
}

/**
 * Browsers keep the cookie's own expiry, so a session extended in the database needs its cookie sent again. Only
 * full page loads are checked (one query), not every client-side navigation. A session can also have been extended
 * during a request that could not set cookies (a Server Component render); it is recognised by living longer than
 * one lifetime and gets its cookie again too.
 */
async function renewedCookie(request: NextRequest): Promise<{ token: string; expires: Date } | null> {
  const token = request.cookies.get(sessionCookieName())?.value;
  if (!token) return null;
  const result = await validateSessionToken(token);
  if (!result) return null;
  const { session } = result;
  if (!result.renewed) {
    const { sessionDays } = await getSettings("auth");
    if (session.expiresAt.getTime() - session.createdAt.getTime() <= sessionDays * DAY_MS + 60_000) return null;
  }
  return { token, expires: session.expiresAt };
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, searchParams } = request.nextUrl;
  const nonce = randomBytes(16).toString("base64");
  const csp = contentSecurityPolicy(nonce, process.env.NODE_ENV !== "production");
  const reading = request.method === "GET" || request.method === "HEAD";

  if (reading) {
    let gate: SetupGate | null = null;
    try {
      gate = await setupGate();
    } catch (err) {
      // Without the database the page itself shows the error; the redirect just cannot be decided.
      console.error("[proxy] could not read the setup state:", err instanceof Error ? err.message : err);
    }
    const target = gate ? gateRedirect(gate, pathname) : null;
    if (target) {
      // Same host as the request, so Next sends a relative Location: it works at whatever address was opened.
      const url = request.nextUrl.clone();
      url.pathname = target;
      url.search = "";
      return withSecurityHeaders(NextResponse.redirect(url, 307), csp);
    }
  }

  const query = new URLSearchParams(searchParams);
  query.delete("_rsc");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  // Where `requireUser` sends people back to after signing in.
  headers.set("x-pathname", query.size ? `${pathname}?${query}` : pathname);
  const response = withSecurityHeaders(NextResponse.next({ request: { headers } }), csp);

  const document = request.method === "GET" && !request.headers.has("rsc") && (request.headers.get("accept") ?? "").includes("text/html");
  if (document) {
    try {
      const renewed = await renewedCookie(request);
      if (renewed) response.cookies.set(sessionCookieName(), renewed.token, sessionCookieOptions(renewed.expires));
    } catch (err) {
      console.error("[proxy] could not check the session:", err instanceof Error ? err.message : err);
    }
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|api/|ui/|d/|gw/|relay/|.*\\.[\\w-]+$).*)"],
};
