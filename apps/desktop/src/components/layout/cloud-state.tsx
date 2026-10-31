import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, CreditCard, RefreshCw } from "lucide-react";
import { MASCOT_CHARACTER, MASCOT_COLOR, type CloudUiContext } from "@godmode/shared";
import { Backdrop } from "@/components/brand";
import { Character } from "@/components/character";
import { Button } from "@/components/ui/button";
import { EASE_OUT, useReduceAnimations } from "@/lib/motion";

const RETRY_MS = 5_000;

export type CloudState =
  | { kind: "offline" }
  | { kind: "plan"; message: string }
  | { kind: "blocked"; title: string; message: string };

/**
 * Full-page states of cloud mode: the computer is offline (checks again every 5 s), the account's plan doesn't allow
 * it right now, or the computer refuses browser access. Each leads back to the cloud's list of computers.
 */
export function CloudStatePage({ cloud, state, onRetry }: { cloud: CloudUiContext; state: CloudState; onRetry: () => Promise<unknown> }) {
  const reduce = useReduceAnimations();
  const { t } = useTranslation(["layout", "common"]);
  const offline = state.kind === "offline";
  const busy = useRef(false);

  useEffect(() => {
    if (!offline) return;
    const id = setInterval(() => {
      if (busy.current) return;
      busy.current = true;
      void onRetry()
        .catch(() => undefined)
        .finally(() => (busy.current = false));
    }, RETRY_MS);
    return () => clearInterval(id);
  }, [offline, onRetry]);

  const title = state.kind === "offline" ? t("cloudState.offlineTitle") : state.kind === "plan" ? t("cloudState.planTitle") : state.title;
  const message =
    state.kind === "offline"
      ? t("cloudState.offlineMessage", { device: cloud.deviceName })
      : state.message;

  return (
    <div className="relative grid h-full place-items-center overflow-hidden bg-background px-5">
      <Backdrop />
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduce ? 0.25 : 0.45, ease: EASE_OUT }}
        className="relative flex max-w-md flex-col items-center gap-6 text-center"
      >
        <Character character={MASCOT_CHARACTER} color={MASCOT_COLOR} size={72} mood={offline ? "sleeping" : "attention"} title="Godmode" />
        <div>
          <p className="eyebrow">{cloud.deviceName}</p>
          <h1 className="mt-2 text-lg font-medium tracking-[-0.02em]">{title}</h1>
          <p className="mt-1.5 text-sm text-balance text-muted-foreground">{message}</p>
        </div>
        {offline && (
          <span className="inline-flex items-center gap-2 rounded-full border bg-card py-1.5 pr-3.5 pl-3 text-xs text-muted-foreground shadow-card" role="status">
            <span className="flex gap-1" aria-hidden>
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  className="size-1 rounded-full bg-muted-foreground"
                  animate={{ opacity: [0.25, 1, 0.25] }}
                  transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
                />
              ))}
            </span>
            {t("cloudState.checking")}
          </span>
        )}
        <div className="flex flex-wrap justify-center gap-2">
          {state.kind === "plan" && cloud.role === "owner" && (
            <Button asChild>
              <a href={cloud.billing}>
                <CreditCard /> {t("cloudState.openBilling")}
              </a>
            </Button>
          )}
          {state.kind === "blocked" && (
            <Button variant="outline" onClick={() => void onRetry().catch(() => undefined)}>
              <RefreshCw /> {t("common:actions.tryAgain")}
            </Button>
          )}
          <Button variant={state.kind === "plan" && cloud.role === "owner" ? "outline" : "default"} asChild>
            <a href={cloud.home}>
              <ArrowLeft /> {t("cloud.allComputers")}
            </a>
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
