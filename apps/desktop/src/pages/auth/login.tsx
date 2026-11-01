import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion, useAnimationControls } from "motion/react";
import { KeyRound, LockKeyhole, ShieldCheck, Terminal } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AuthLayout, FormError, SubmitButton, shake } from "@/components/onboarding/auth-layout";
import { InlineCode } from "@/components/onboarding/doctor-checklist";
import { PasswordInput } from "@/components/vault/password-input";
import { ApiRequestError, api, errorMessage } from "@/lib/api";
import { setSessionToken } from "@/lib/core";
import { qk } from "@/lib/queryKeys";
import { t } from "@/i18n";

function loginError(err: unknown, kind: "password" | "token"): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 429) {
      const retry = (err.details as { retryAfter?: number } | undefined)?.retryAfter;
      return retry ? t("auth:login.tooManyRetry", { seconds: Math.ceil(retry) }) : t("auth:login.tooMany");
    }
    if (err.status === 401 || err.status === 403) return kind === "password" ? t("auth:login.wrongPassword") : t("auth:login.wrongToken");
  }
  return errorMessage(err);
}

/** Web dashboard sign-in (served by `godmode serve`). */
export function LoginPage({ hasPassword }: { hasPassword: boolean }) {
  const { t } = useTranslation("auth");
  const [tab, setTab] = useState<"password" | "token">(hasPassword ? "password" : "token");
  return (
    <AuthLayout
      badge={<LockKeyhole />}
      title={
        <>
          {t("login.title")}
          <span className="block text-foreground/35">{t("login.subtitle")}</span>
        </>
      }
      description={t("login.description")}
      footer={
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck className="size-3.5 text-brand-strong" />
          {t("login.footer")}
        </span>
      }
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as "password" | "token")} className="gap-5">
        <TabsList className="grid h-9 w-full grid-cols-2 rounded-lg">
          <TabsTrigger value="password" className="rounded-md">
            <KeyRound /> {t("login.passwordTab")}
          </TabsTrigger>
          <TabsTrigger value="token" className="rounded-md">
            <Terminal /> {t("login.tokenTab")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="password">
          {hasPassword ? (
            <PasswordForm />
          ) : (
            <div className="rounded-lg border border-dashed bg-paper-2 p-4 text-sm text-muted-foreground">
              <Trans t={t} i18nKey="login.noPassword" components={{ b: <span className="font-medium text-foreground" /> }} />
              <Button variant="secondary" className="mt-3 w-full" onClick={() => setTab("token")}>
                {t("login.useToken")}
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
  const { t } = useTranslation("auth");
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
    }
    setBusy(false);
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <motion.div animate={controls} className="space-y-2">
        <Label htmlFor="login-password">{t("login.passwordLabel")}</Label>
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
        {t("login.signIn")}
      </SubmitButton>
    </form>
  );
}

function TokenForm() {
  const { t } = useTranslation(["auth", "common"]);
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
    }
    setBusy(false);
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <motion.div animate={controls} className="space-y-2">
        <Label htmlFor="login-token">{t("login.tokenTab")}</Label>
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
          placeholder={t("login.tokenPlaceholder")}
        />
        <p id="login-token-hint" className="text-xs text-muted-foreground">
          <InlineCode text={t("login.tokenHint")} />
        </p>
      </motion.div>
      <FormError message={error} />
      <SubmitButton busy={busy} disabled={!token.trim()}>
        {t("common:actions.continue")}
      </SubmitButton>
    </form>
  );
}
