"use client";

import { useEffect, useState, useTransition, type FormEvent } from "react";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { ArrowLeft, Mail } from "lucide-react";
import { AuthError, AuthShell } from "@/components/auth-shell";
import { isNavigationError } from "@/components/confirm-dialog";
import { FormField, FormStack } from "@/components/form";
import { Callout } from "@/components/settings-kit";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp";
import { requestLoginAction, verifyCodeAction } from "../../actions";
import type { ShellInfo } from "../../_lib/shell";

const CODE_LENGTH = 8;
const RESEND_SECONDS = 30;
const FAILED = "Could not reach the server. Check your connection and try again.";

/** Sign in: the e-mail field, then "Check your inbox" with the code from the e-mail and a way to send it again. */
export function LoginView({
  shell,
  next,
  error: initialError,
  access,
  codeLogin,
  linkMinutes,
  mailInLog,
  farewell = null,
}: {
  shell: ShellInfo;
  next: string | null;
  error: string | null;
  /** The static line about who can sign in. */
  access: string;
  codeLogin: boolean;
  linkMinutes: number;
  mailInLog: boolean;
  /** Shown once after an account was deleted. */
  farewell?: string | null;
}) {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const [sending, startSending] = useTransition();
  const [checking, startChecking] = useTransition();

  // Counts the resend cooldown down to zero.
  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setWait((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  const send = (address: string, again: boolean) => {
    setError(null);
    setNotice(null);
    startSending(async () => {
      try {
        const result = await requestLoginAction({ email: address, next });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setSentTo(address.trim());
        setCode("");
        setWait(RESEND_SECONDS);
        if (again) setNotice("We sent it again.");
      } catch {
        setError(FAILED);
      }
    });
  };

  const check = (value: string) => {
    if (value.length !== CODE_LENGTH || checking) return;
    setError(null);
    setNotice(null);
    startChecking(async () => {
      try {
        const result = await verifyCodeAction(value);
        // Success redirects; only a refusal comes back.
        if (result && !result.ok) {
          setError(result.error);
          setCode("");
        }
      } catch (err) {
        if (isNavigationError(err)) throw err;
        setError(FAILED);
      }
    });
  };

  const onEmailSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      setError("Enter your e-mail address.");
      return;
    }
    send(email, false);
  };

  const onCodeSubmit = (e: FormEvent) => {
    e.preventDefault();
    check(code);
  };

  const logNotice = mailInLog && (
    <Callout tone="muted" role="note">
      E-mail delivery is not set up on this cloud yet. Ask your administrator for your sign-in link.
    </Callout>
  );

  if (sentTo) {
    return (
      <AuthShell
        appName={shell.appName}
        legal={shell.legal}
        announcement={shell.announcement}
        mascot="happy"
        title="Check your inbox"
        description={
          <>
            If <span className="font-medium break-all text-foreground">{sentTo}</span> can sign in here, an e-mail with a sign-in link is on its
            way. The link works for {linkMinutes} minutes.
          </>
        }
        footer={access}
      >
        <FormStack>
          {codeLogin ? (
            <form onSubmit={onCodeSubmit} className="flex flex-col gap-5" noValidate>
              <FormField label="Code from the e-mail" hint="Or open the link in the e-mail on any device.">
                <InputOTP
                  maxLength={CODE_LENGTH}
                  pattern={REGEXP_ONLY_DIGITS}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={setCode}
                  onComplete={check}
                  disabled={checking}
                  autoFocus
                >
                  <InputOTPGroup>
                    {[0, 1, 2, 3].map((i) => (
                      <InputOTPSlot key={i} index={i} />
                    ))}
                  </InputOTPGroup>
                  <InputOTPSeparator />
                  <InputOTPGroup>
                    {[4, 5, 6, 7].map((i) => (
                      <InputOTPSlot key={i} index={i} />
                    ))}
                  </InputOTPGroup>
                </InputOTP>
              </FormField>
              <AuthError message={error} />
              <SubmitButton pending={checking} pendingLabel="Signing in…" disabled={code.length !== CODE_LENGTH} className="w-full">
                Sign in
              </SubmitButton>
            </form>
          ) : (
            <>
              <p className="text-sm leading-relaxed text-muted-foreground">Open the link in the e-mail to sign in. You can close this page.</p>
              <AuthError message={error} />
            </>
          )}
          {logNotice}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => {
                setSentTo(null);
                setError(null);
                setNotice(null);
                setCode("");
              }}
            >
              <ArrowLeft /> Different address
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={wait > 0 || sending} onClick={() => send(sentTo, true)}>
              {sending ? "Sending…" : wait > 0 ? `Send again in ${wait} s` : "Send again"}
            </Button>
          </div>
          <p aria-live="polite" className="sr-only">
            {notice}
          </p>
        </FormStack>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      appName={shell.appName}
      legal={shell.legal}
      announcement={shell.announcement}
      title="Sign in"
      description="Enter your e-mail address and we will send you a sign-in link. No password needed."
      footer={access}
    >
      <form onSubmit={onEmailSubmit} noValidate>
        <FormStack>
          {farewell ? <Callout tone="muted">{farewell}</Callout> : null}
          <FormField label="E-mail">
            <Input
              type="email"
              name="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              required
            />
          </FormField>
          <AuthError message={error} />
          <SubmitButton pending={sending} pendingLabel="Sending…" icon={<Mail />} className="w-full">
            Send sign-in link
          </SubmitButton>
          {logNotice}
        </FormStack>
      </form>
    </AuthShell>
  );
}
