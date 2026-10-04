"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { AuthError, AuthShell } from "@/components/auth-shell";
import { isNavigationError } from "@/components/confirm-dialog";
import { Callout } from "@/components/settings-kit";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { confirmLinkAction } from "../../../actions";
import type { ShellInfo } from "../../../_lib/shell";

/** "Sign in as <email>" with one button, or the friendly dead-link page. */
export function VerifyView({
  shell,
  token,
  email,
  signedInAs,
}: {
  shell: ShellInfo;
  token: string;
  /** The address the link signs in; null when the link is used, expired or unknown. */
  email: string | null;
  /** Set when this browser is signed in to a different account. */
  signedInAs: string | null;
}) {
  const [dead, setDead] = useState(email === null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (dead || email === null) {
    return (
      <AuthShell
        appName={shell.appName}
        legal={shell.legal}
        announcement={shell.announcement}
        mascot="thinking"
        title="This link no longer works"
        description="Sign-in links work once and expire after a few minutes. Send yourself a new one."
        footer={
          <Button asChild>
            <Link href="/login">Send a new link</Link>
          </Button>
        }
      />
    );
  }

  const confirm = () => {
    setError(null);
    startTransition(async () => {
      try {
        const result = await confirmLinkAction(token);
        // Success redirects; only a refusal comes back.
        if (result && !result.ok) setDead(true);
      } catch (err) {
        if (isNavigationError(err)) throw err;
        setError("Could not reach the server. Check your connection and try again.");
      }
    });
  };

  return (
    <AuthShell
      appName={shell.appName}
      legal={shell.legal}
      announcement={shell.announcement}
      title="Confirm sign-in"
      description={
        <>
          Sign in as <span className="font-medium break-all text-foreground">{email}</span> in this browser.
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {signedInAs && (
          <Callout tone="warning" role="note" title="Another account is signed in here">
            This browser is signed in as <span className="break-all">{signedInAs}</span>. Continuing signs that account out here and signs in{" "}
            <span className="break-all">{email}</span>.
          </Callout>
        )}
        <AuthError message={error} />
        <SubmitButton type="button" onClick={confirm} pending={pending} pendingLabel="Signing in…" className="w-full">
          {signedInAs ? "Switch account" : "Sign in"}
        </SubmitButton>
        {signedInAs && (
          <Button variant="ghost" asChild className="w-full text-muted-foreground">
            <Link href="/">Stay signed in as {signedInAs.length > 28 ? "the current account" : signedInAs}</Link>
          </Button>
        )}
      </div>
    </AuthShell>
  );
}
