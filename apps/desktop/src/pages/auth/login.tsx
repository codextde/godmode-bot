import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion, useAnimationControls } from "motion/react";
import { KeyRound, LockKeyhole, ShieldCheck, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AuthLayout, FormError, SubmitButton, shake } from "@/components/onboarding/auth-layout";
import { InlineCode } from "@/components/onboarding/doctor-checklist";
import { PasswordInput } from "@/components/vault/password-input";
import { ApiRequestError, api, errorMessage } from "@/lib/api";
import { setSessionToken } from "@/lib/core";
import { qk } from "@/lib/queryKeys";

function loginError(err: unknown, kind: "password" | "token"): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 429) {
      const retry = (err.details as { retryAfter?: number } | undefined)?.retryAfter;
      return retry ? `Too many attempts — try again in ${Math.ceil(retry)} s.` : "Too many attempts — wait a minute and try again.";
    }
    if (err.status === 401 || err.status === 403) return kind === "password" ? "That password isn't right." : "That access token isn't valid.";
  }
  return errorMessage(err);
}

/** Web dashboard sign-in (served by `godmode serve`). */
export function LoginPage({ hasPassword }: { hasPassword: boolean }) {
  const [tab, setTab] = useState<"password" | "token">(hasPassword ? "password" : "token");
  return (
    <AuthLayout
      badge={<LockKeyhole />}
      title={
        <>
          Sign in to Godmode.
          <span className="block text-foreground/35">Your coworker is waiting.</span>
        </>
      }
      description="This dashboard controls an AI coworker with access to your logins. Sign in to continue."
      footer={
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck className="size-3.5 text-brand-strong" />
          Session is stored in an HttpOnly, same-site cookie. Failed attempts are rate limited.
        </span>
      }
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as "password" | "token")} className="gap-5">
        <TabsList className="grid h-9 w-full grid-cols-2 rounded-lg">
          <TabsTrigger value="password" className="rounded-md">
            <KeyRound /> Password
          </TabsTrigger>
          <TabsTrigger value="token" className="rounded-md">
            <Terminal /> Access token
          </TabsTrigger>
        </TabsList>
        <TabsContent value="password">
          {hasPassword ? (
            <PasswordForm />
          ) : (
            <div className="rounded-lg border border-dashed bg-paper-2 p-4 text-sm text-muted-foreground">
              No dashboard password has been set yet. Sign in with an access token — you can set a password afterwards in{" "}
              <span className="font-medium text-foreground">Settings → Security</span>.
              <Button variant="secondary" className="mt-3 w-full" onClick={() => setTab("token")}>
                Use an access token
              </Button>
            </div>
          )}
        </TabsContent>
        <TabsContent value="token">
          <TokenForm />
        </TabsContent>
      </Tabs>
    </AuthLayout>
  );
}

function PasswordForm() {
  const qc = useQueryClient();
  const controls = useAnimationControls();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.auth.login(password);
      await qc.invalidateQueries({ queryKey: qk.authStatus });
    } catch (err) {
      setError(loginError(err, "password"));
      void controls.start(shake);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <motion.div animate={controls} className="space-y-2">
        <Label htmlFor="login-password">Dashboard password</Label>
        <PasswordInput
          id="login-password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError(null);
          }}
          aria-invalid={!!error}
          aria-describedby={error ? "login-password-error" : undefined}
          placeholder="••••••••••"
        />
      </motion.div>
      <FormError id="login-password-error" message={error} />
      <SubmitButton busy={busy} disabled={!password}>
        Sign in
      </SubmitButton>
    </form>
  );
}

function TokenForm() {
  const qc = useQueryClient();
  const controls = useAnimationControls();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = token.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.auth.token(value);
      setSessionToken(value);
      await qc.invalidateQueries({ queryKey: qk.authStatus });
    } catch (err) {
      setError(loginError(err, "token"));
      void controls.start(shake);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <motion.div animate={controls} className="space-y-2">
        <Label htmlFor="login-token">Access token</Label>
        <PasswordInput
          id="login-token"
          autoFocus
          autoComplete="off"
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setError(null);
          }}
          aria-invalid={!!error}
          aria-describedby="login-token-hint"
          placeholder="Paste the token"
        />
        <p id="login-token-hint" className="text-xs text-muted-foreground">
          <InlineCode text="Run `godmode token` on the machine running Godmode to print it." />
        </p>
      </motion.div>
      <FormError message={error} />
      <SubmitButton busy={busy} disabled={!token.trim()}>
        Continue
      </SubmitButton>
    </form>
  );
}
