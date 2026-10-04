"use client";

import { useState, useTransition, type FormEvent } from "react";
import { AuthError, AuthShell } from "@/components/auth-shell";
import { isNavigationError } from "@/components/confirm-dialog";
import { FormField, FormStack } from "@/components/form";
import { Callout } from "@/components/settings-kit";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { joinInviteAction } from "../../../actions";
import type { ShellInfo } from "../../../_lib/shell";

/** An invitation: who sent it, the address and role it is for, a name field and "Join". */
export function JoinView({
  shell,
  token,
  email,
  inviter,
  role,
  signedInAs,
}: {
  shell: ShellInfo;
  token: string;
  email: string;
  inviter: string | null;
  role: string;
  signedInAs: string | null;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setNameError(null);
    if (!name.trim()) {
      setNameError("Enter your name.");
      return;
    }
    startTransition(async () => {
      try {
        const result = await joinInviteAction({ token, name });
        // Success redirects; only a refusal comes back.
        if (result && !result.ok) setError(result.error);
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
      mascot="happy"
      title={`Join ${shell.appName}`}
      description={inviter ? `${inviter} invited you.` : "You have been invited."}
    >
      <form onSubmit={onSubmit} noValidate>
        <FormStack>
          <dl className="divide-y rounded-lg border bg-paper-2 px-3.5 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 py-2.5">
              <dt className="text-muted-foreground">Account</dt>
              <dd className="min-w-0 font-medium break-all">{email}</dd>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 py-2.5">
              <dt className="text-muted-foreground">Role</dt>
              <dd className="font-medium">{role}</dd>
            </div>
          </dl>
          {signedInAs && (
            <Callout tone="warning" role="note" title="Another account is signed in here">
              This browser is signed in as <span className="break-all">{signedInAs}</span>. Joining signs that account out here.
            </Callout>
          )}
          <FormField label="Your name" error={nameError} hint="Shown to the people you work with here.">
            <Input name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus required />
          </FormField>
          <AuthError message={error} />
          <SubmitButton pending={pending} pendingLabel="Joining…" className="w-full">
            Join
          </SubmitButton>
        </FormStack>
      </form>
    </AuthShell>
  );
}
