import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator } from "react-native";
import { useTranslation } from "react-i18next";
import { useFullAccess } from "./full-access";
import { HomeNotice } from "./home-notice";
import { ActionPill, SignInSteps } from "./program-parts";
import { Card } from "./ui";
import { recheckDoctor, useClaudeLogin } from "@/lib/programs";
import { settingsApi, sq } from "@/lib/settings-api";
import { useColors } from "@/lib/theme";

/** While runs find Claude signed out, at the top of Home. Gone by itself once it works again. */
export function ClaudeSignedOutBanner() {
  const { fullAccess } = useFullAccess();
  if (fullAccess === undefined) return null;
  return fullAccess ? <SignInHere /> : <SignInOnComputer />;
}

/** A limited phone can't sign in: what it may read says so, the steps wait on the computer. */
function SignInOnComputer() {
  const { t } = useTranslation("components");
  const doctor = useQuery({ queryKey: sq.doctor, queryFn: () => settingsApi.doctor.get(), staleTime: 5 * 60_000 });
  const auth = doctor.data?.dependencies.find((d) => d.id === "claude-auth");
  if (!auth || auth.ok) return null;
  return (
    <HomeNotice
      icon="personCircle"
      tone="warning"
      title={t("claudeSignedOut.signedOut")}
      body={t("claudeSignedOut.onComputer")}
      actions={<ActionPill label={t("claudeSignedOut.details")} tone="neutral" onPress={() => router.push("/settings/health")} />}
    />
  );
}

function SignInHere() {
  const c = useColors();
  const { t } = useTranslation(["components", "programs", "common"]);
  const signedIn = useCallback(() => void recheckDoctor(), []);
  // Fails here on screen, not with a second alert over the chat or System health that started it.
  const login = useClaudeLogin(true, signedIn, { quiet: true });
  const { status, waiting, start } = login;
  // Started here, or asked for: a sign-in started elsewhere is only mentioned.
  const [steps, setSteps] = useState(false);
  if (steps && !waiting && !start.isPending) setSteps(false);
  const out = status?.signedOut;
  if (!out) return null;

  if (out.apiKey) {
    return (
      <HomeNotice
        icon="key"
        tone="warning"
        title={t("claudeSignedOut.keyRefused")}
        body={t("claudeSignedOut.keyRefusedHint")}
        actions={<ActionPill label={t("claudeSignedOut.checkKey")} tone="neutral" onPress={() => router.push("/settings/vault/api-keys")} />}
      />
    );
  }
  if (waiting && steps) {
    return (
      <Card style={{ overflow: "hidden" }}>
        <SignInSteps
          title={t("programs:signIn.title")}
          url={status?.url ?? null}
          submitting={login.submit.isPending}
          cancelling={login.cancel.isPending}
          onSubmit={login.send}
          onCancel={() => login.cancel.mutate()}
        />
      </Card>
    );
  }
  if (waiting) {
    return (
      <HomeNotice
        lead={<ActivityIndicator size="small" color={c.warning} />}
        tone="warning"
        title={t("claudeSignedOut.signingIn")}
        actions={<ActionPill label={t("claudeSignedOut.showSteps")} tone="neutral" onPress={() => setSteps(true)} />}
      />
    );
  }
  const failed = status?.state === "failed" && !!status.message;
  return (
    <HomeNotice
      icon="personCircle"
      tone="warning"
      title={failed ? t("claudeSignedOut.failed") : t("claudeSignedOut.signedOut")}
      body={failed ? status.message : t("claudeSignedOut.signInAgainHint")}
      actions={
        <ActionPill
          label={failed ? t("common:actions.tryAgain") : t("claudeSignedOut.signInAgain")}
          busy={start.isPending}
          onPress={() => {
            setSteps(true);
            start.mutate();
          }}
        />
      }
    />
  );
}
