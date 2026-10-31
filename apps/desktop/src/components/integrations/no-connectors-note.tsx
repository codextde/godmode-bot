import { useId, useState } from "react";
import { useNavigate } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, CircleCheck, Globe, KeyRound, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { storageKey } from "@/lib/core";

const DISMISS_KEY = storageKey("godmode-integrations-no-connectors");

const STEPS = [
  { icon: Globe, label: "noConnectors.steps.open" },
  { icon: KeyRound, label: "noConnectors.steps.fill" },
  { icon: ShieldCheck, label: "noConnectors.steps.twoFactor" },
  { icon: CircleCheck, label: "noConnectors.steps.signedIn" },
] as const;

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/** Integrations are optional: agents sign in to websites with vault logins and 2FA, so apps need no MCP connector. */
export function NoConnectorsNote() {
  const { t } = useTranslation("integrations");
  const navigate = useNavigate();
  const [hidden, setHidden] = useState(dismissed);
  const titleId = useId();

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
    setHidden(true);
  };

  return (
    <AnimatePresence>
      {!hidden && (
        <motion.section
          key="note"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, height: 0, marginBottom: 0 }}
          transition={{ duration: 0.2 }}
          className="mb-6 overflow-hidden rounded-xl border border-brand/25 bg-card shadow-card"
          aria-labelledby={titleId}
        >
          <div className="grid grid-cols-1 gap-6 p-5 @4xl:grid-cols-[1fr_minmax(0,280px)] @4xl:items-center @2xl:p-6">
            <div className="flex items-start gap-4">
              <div className="grid size-10 shrink-0 place-items-center rounded-lg border border-brand/25 bg-brand-soft text-brand-strong">
                <ShieldCheck className="size-5" />
              </div>
              <div className="min-w-0">
                <h2 id={titleId} className="text-[15px] leading-snug font-medium tracking-[-0.01em]">{t("noConnectors.title")}</h2>
                <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                  {t("noConnectors.description")}
                </p>
                <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                  {t("noConnectors.hint")}
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => navigate("/vault/logins")}>
                    {t("noConnectors.saveLogin")} <ArrowRight />
                  </Button>
                  <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={dismiss}>
                    {t("noConnectors.gotIt")}
                  </Button>
                </div>
              </div>
            </div>
            <ol className="hidden rounded-lg border bg-paper-2 p-3 @4xl:block" aria-hidden>
              {STEPS.map((s, i) => (
                <motion.li
                  key={s.label}
                  initial={{ opacity: 0, x: 6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.08 + i * 0.06, duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
                  className="relative flex items-center gap-2.5 py-1.5 text-xs"
                >
                  <span
                    className={
                      i === STEPS.length - 1
                        ? "grid size-6 place-items-center rounded-md border border-brand/25 bg-brand-soft text-brand-strong"
                        : "grid size-6 place-items-center rounded-md border bg-card text-foreground"
                    }
                  >
                    <s.icon className="size-3.5" />
                  </span>
                  <span className={i === STEPS.length - 1 ? "font-medium text-foreground" : "text-muted-foreground"}>{t(s.label)}</span>
                </motion.li>
              ))}
            </ol>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
