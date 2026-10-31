import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { KeyRound, LogIn } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ClaudeSignInSteps, maySignIn, signsInFromAfar, useClaudeLogin } from "@/components/onboarding/claude-sign-in";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/**
 * Above every page while runs find Claude Code signed out: one click signs it in again, right here. Gone by itself once
 * it works (a sign-in, or a run that got an answer).
 */
export function ClaudeSignedOutBanner() {
  const { t } = useTranslation(["layout", "common"]);
  const { pathname } = useLocation();
  const login = useClaudeLogin();
  const { status, state, start } = login;
  const out = status?.signedOut ?? null;
  // Settings → System shows the same sign-in in its checklist.
  const shown = !!out && !pathname.startsWith("/settings/system");
  // A sign-in started elsewhere (the chat, before a reload) shows its steps here on request.
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (state !== "waiting") setExpanded(false);
  }, [state]);

  return (
    <AnimatePresence initial={false}>
      {shown && (
        <motion.div
          key="claude-signed-out"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="shrink-0 overflow-hidden"
        >
          <div className="px-3 pt-3">
            <div role="alert" className="rounded-lg border border-warning/30 bg-warning/[0.07] py-1.5 pr-1.5 pl-3 text-[13px] shadow-card">
              <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="shrink-0 text-warning [&_svg]:size-4">{out.apiKey ? <KeyRound /> : state === "waiting" ? <Spinner /> : <LogIn />}</span>
                <p className="min-w-0 flex-1 leading-snug">
                  {out.apiKey ? (
                    <>
                      <span className="font-medium">{t("claudeSignedOut.keyRefused")}</span>
                      <span className="text-muted-foreground"> {t("claudeSignedOut.keyRefusedHint")}</span>
                    </>
                  ) : state === "waiting" ? (
                    <>
                      <span className="font-medium">{t("claudeSignedOut.signingIn")}</span>
                      {!login.mine && !signsInFromAfar && <span className="text-muted-foreground"> {t("claudeSignedOut.finishInBrowser")}</span>}
                    </>
                  ) : state === "failed" && status?.message ? (
                    <>
                      <span className="font-medium">{t("claudeSignedOut.failed")}</span>
                      <span className="text-muted-foreground"> {status.message}</span>
                    </>
                  ) : (
                    <>
                      <span className="font-medium">{t("claudeSignedOut.signedOut")}</span>
                      <span className="text-muted-foreground">
                        {" "}
                        {maySignIn ? t("claudeSignedOut.signInAgainHint") : t("claudeSignedOut.ownerSignInHint")}
                      </span>
                    </>
                  )}
                </p>
                {out.apiKey ? (
                  <Button size="sm" variant="outline" className="h-7 shrink-0 bg-card" asChild>
                    <Link to="/settings/api-keys">{t("claudeSignedOut.checkKey")}</Link>
                  </Button>
                ) : !maySignIn ? null : state !== "waiting" ? (
                  <Button size="sm" className="h-7 shrink-0" onClick={() => start.mutate()} disabled={start.isPending}>
                    {start.isPending ? <Spinner /> : <LogIn />}
                    {state === "failed" ? t("common:actions.tryAgain") : t("claudeSignedOut.signInAgain")}
                  </Button>
                ) : (
                  !login.mine &&
                  !expanded && (
                    <Button size="sm" variant="ghost" className="h-7 shrink-0" onClick={() => setExpanded(true)}>
                      {t("claudeSignedOut.showSteps")}
                    </Button>
                  )
                )}
              </div>
              {!out.apiKey && state === "waiting" && (login.mine || expanded) && <ClaudeSignInSteps login={login} className="my-1.5 mr-1.5 bg-card" />}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
