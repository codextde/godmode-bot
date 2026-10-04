import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { safeNext } from "@/server/auth/policy";
import { getSettings } from "@/server/settings";
import { shellInfo } from "../_lib/shell";
import { LoginView } from "./_components/login-view";

export const metadata: Metadata = { title: "Sign in" };

/** Calm sentences for `?error=`; the parameter itself is never shown. */
const ERRORS: Record<string, string> = {
  expired: "That sign-in link has expired or was already used. Request a new one below.",
  link: "That sign-in link has expired or was already used. Request a new one below.",
  session: "Your session has ended. Sign in again.",
  denied: "That sign-in was not accepted. Request a new link, or ask your administrator.",
};

function first(value: string | string[] | undefined): string | null {
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const next = safeNext(first(params.next));
  if (await getSession()) redirect(next ?? "/");

  const [shell, auth, email] = await Promise.all([shellInfo(), getSettings("auth"), getSettings("email")]);
  const errorCode = first(params.error);
  // One static line, the same for every visitor: it describes the cloud, never an address.
  const access = auth.inviteOnly
    ? "Only invited people can sign in."
    : auth.allowedDomains.length
      ? `Open to addresses at ${auth.allowedDomains.join(", ")}.`
      : "New here? Signing in creates your account.";

  return (
    <LoginView
      shell={shell}
      next={next}
      error={errorCode ? (ERRORS[errorCode] ?? "Could not sign you in. Request a new link below.") : null}
      access={access}
      codeLogin={auth.codeLogin}
      linkMinutes={auth.magicLinkMinutes}
      mailInLog={email.transport === "log"}
      farewell={first(params.deleted) === "1" ? "Your account was deleted. You have been signed out everywhere." : null}
    />
  );
}
