"use server";

/**
 * Server actions of the signed-out pages. None of them needs a session: each is protected by what it consumes (a
 * sign-in link, the code of the browser that asked, an invitation link) and by the rate limits of the services.
 */
import { redirect } from "next/navigation";
import { z } from "zod";
import { runAction, type ActionResult } from "@/lib/action";
import { clearLoginCookie, getSession, readLoginCookie, requestMeta, setLoginCookie, setSessionCookie, signOut, startSession } from "@/lib/session";
import { consumeLoginCode, consumeLoginToken, requestLogin } from "@/server/auth/login";
import { AppError, badRequest } from "@/server/errors";
import { setupGate } from "@/server/setup";
import { acceptInvite } from "@/server/users/invites";

const emailInput = z.string({ error: "Enter your e-mail address." }).trim().min(1, "Enter your e-mail address.").max(254, "Enter a valid e-mail address.");
const nextInput = z.string().max(2000).nullish().catch(null);
const tokenInput = z.string().max(200).catch("");

/** A browser that signs in while another account is signed in switches accounts: the old session ends. */
async function endCurrentSession(): Promise<void> {
  if (await getSession()) await signOut();
}

/**
 * Sends the sign-in e-mail. The answer is the same for every address, whether or not it may sign in; only an
 * address that cannot be one, or a rate limit, gives an error.
 */
export async function requestLoginAction(input: { email: string; next?: string | null }): Promise<ActionResult> {
  return runAction(async () => {
    const email = emailInput.parse(input?.email);
    const next = nextInput.parse(input?.next);
    const { loginId } = await requestLogin(email, { ...(await requestMeta()), next });
    await setLoginCookie(loginId);
  });
}

/** The 8-digit code from the e-mail, typed in the browser that asked for it. Redirects on success. */
export async function verifyCodeAction(code: string): Promise<ActionResult> {
  return runAction(async () => {
    const digits = z.string().max(40).catch("").parse(code);
    const loginId = await readLoginCookie();
    if (!loginId) throw badRequest("This sign-in has expired. Request a new e-mail.", "login_expired");
    const result = await consumeLoginCode(loginId, digits, await requestMeta());
    if (result === "locked") {
      throw new AppError("This code can no longer be used. Open the link in the e-mail, or request a new one.", "code_locked", 429);
    }
    if (result === "invalid") throw badRequest("That code is not right. Check the e-mail and try again.", "wrong_code");
    await endCurrentSession();
    await startSession(result.user.id);
    await clearLoginCookie();
    redirect(result.next ?? "/");
  });
}

/** The button on /auth/verify: uses the link (opening the page alone never does). Redirects on success. */
export async function confirmLinkAction(token: string): Promise<ActionResult> {
  return runAction(async () => {
    const result = await consumeLoginToken(tokenInput.parse(token), await requestMeta());
    if (!result) throw new AppError("This link has expired or was already used.", "link_invalid", 410);
    await endCurrentSession();
    await startSession(result.user.id);
    await clearLoginCookie();
    redirect(result.next ?? "/");
  });
}

/** "Join" on an invitation: creates the account, signs it in and opens the start page. */
export async function joinInviteAction(input: { token: string; name: string }): Promise<ActionResult> {
  return runAction(async () => {
    const { token, name } = z
      .object({
        token: tokenInput,
        name: z.string({ error: "Enter your name." }).trim().min(1, "Enter your name.").max(80, "Keep your name under 80 characters."),
      })
      .parse(input ?? {});
    if ((await setupGate()) !== "done") throw new AppError("This cloud is still being set up. Try again a little later.", "setup_unfinished", 409);
    const { sessionToken, expires } = await acceptInvite(token, { name }, await requestMeta());
    await endCurrentSession();
    await setSessionCookie(sessionToken, expires);
    redirect("/");
  });
}

/** Signs this browser out: revokes the session, clears the cookie, opens the sign-in page. */
export async function logoutAction(): Promise<void> {
  await signOut();
  redirect("/login");
}
