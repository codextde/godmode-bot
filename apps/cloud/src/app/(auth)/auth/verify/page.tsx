import type { Metadata } from "next";
import { getSession } from "@/lib/session";
import { peekLoginToken } from "@/server/auth/login";
import { shellInfo } from "../../_lib/shell";
import { VerifyView } from "./_components/verify-view";

export const metadata: Metadata = { title: "Confirm sign-in" };

/**
 * The page behind the link in the sign-in e-mail. Opening it uses nothing (mail scanners open links): it only names
 * the address; the button posts the action that consumes the link.
 */
export default async function VerifyPage({ searchParams }: PageProps<"/auth/verify">) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  const [shell, link, session] = await Promise.all([shellInfo(), peekLoginToken(token), getSession()]);
  const signedInAs = session && link && session.user.email !== link.email ? session.user.email : null;
  return <VerifyView shell={shell} token={token} email={link?.email ?? null} signedInAs={signedInAs} />;
}
