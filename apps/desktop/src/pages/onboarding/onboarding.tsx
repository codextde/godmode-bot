import { useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Globe2, LockKeyhole, PartyPopper, Sparkles } from "lucide-react";
import type { Bootstrap, InterfaceMode } from "@godmode/shared";
import { Backdrop, Wordmark } from "@/components/brand";
import { DoneStep, type OnboardingSummary } from "@/components/onboarding/done-step";
import { RemoteStep } from "@/components/onboarding/remote-step";
import { SetupStep } from "@/components/onboarding/setup-step";
import { StepProgress, StepRail, type StepMeta } from "@/components/onboarding/step-kit";
import { VaultStep } from "@/components/onboarding/vault-step";
import { api } from "@/lib/api";
import { isTauri, storageKey } from "@/lib/core";
import { isMac } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

type StepId = "setup" | "vault" | "remote" | "done";

const STEP_ICONS: Record<StepId, ReactNode> = {
  setup: <Sparkles />,
  vault: <LockKeyhole />,
  remote: <Globe2 />,
  done: <PartyPopper />,
};

const SESSION_KEY = storageKey("godmode-onboarding");

function loadSession(): { step?: StepId; userName?: string; mode?: InterfaceMode } {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveSession(v: { step: StepId; userName: string; mode: InterfaceMode }) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

const variants = {
  enter: (dir: number) => ({ opacity: 0, x: dir * 20 }),
  center: { opacity: 1, x: 0 },
  exit: (dir: number) => ({ opacity: 0, x: dir * -20 }),
};

export function OnboardingPage({ bootstrap }: { bootstrap: Bootstrap }) {
  const { t } = useTranslation("onboarding");
  const qc = useQueryClient();
  const navigate = useNavigate();
  const serverMode = bootstrap.mode === "server";

  // The step list is fixed on mount — bootstrap changes mid-flow (e.g. vault created) must not shift indices.
  const [steps] = useState<StepId[]>(() => {
    const list: StepId[] = ["setup"];
    if (!(bootstrap.vault.initialized && bootstrap.vault.unlocked)) list.push("vault");
    if (serverMode) list.push("remote");
    list.push("done");
    return list;
  });
  const [index, setIndex] = useState(() => {
    const saved = loadSession().step;
    const i = saved ? steps.indexOf(saved) : -1;
    // Never resume past the vault step while the vault still needs to be created or unlocked.
    const vaultIdx = steps.indexOf("vault");
    if (vaultIdx !== -1 && i > vaultIdx) return vaultIdx;
    return i > 0 ? i : 0;
  });
  const [direction, setDirection] = useState(1);
  const [userName, setUserName] = useState(() => loadSession().userName ?? bootstrap.settings.general.userName ?? "");
  const [mode, setMode] = useState<InterfaceMode>(() => loadSession().mode ?? (bootstrap.settings.general.mode === "easy" ? "easy" : "pro"));
  const [summary, setSummary] = useState<OnboardingSummary>({
    doctorOk: null,
    vault: bootstrap.vault.initialized && bootstrap.vault.unlocked ? "existing" : null,
    dashboardPassword: bootstrap.settings.server.hasDashboardPassword,
  });

  const scroller = useRef<HTMLElement>(null);
  const go = (to: number) => {
    const next = Math.max(0, Math.min(steps.length - 1, to));
    scroller.current?.scrollTo({ top: 0 });
    setDirection(next >= index ? 1 : -1);
    setIndex(next);
    saveSession({ step: steps[next], userName, mode });
  };
  const next = () => go(index + 1);
  const back = () => go(index - 1);

  const finish = async (to: string) => {
    await api.settings.update({ onboardingComplete: true, general: { userName: userName.trim(), mode } });
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
    navigate(to, { replace: true });
    await Promise.all([qc.invalidateQueries({ queryKey: qk.bootstrap }), qc.invalidateQueries({ queryKey: qk.settings })]);
  };

  const stepId = steps[index];
  const meta: StepMeta[] = steps.map((id) => ({ id, title: t(`steps.${id}.title`), hint: t(`steps.${id}.hint`), icon: STEP_ICONS[id] }));

  let content: ReactNode;
  switch (stepId) {
    case "setup":
      content = (
        <SetupStep
          userName={userName}
          onUserName={setUserName}
          mode={mode}
          onMode={setMode}
          onNext={(doctorOk) => {
            setSummary((s) => ({ ...s, doctorOk }));
            next();
          }}
        />
      );
      break;
    case "vault":
      content = (
        <VaultStep
          vault={bootstrap.vault}
          userName={userName}
          onBack={back}
          onDone={(vault) => {
            setSummary((s) => ({ ...s, vault }));
            next();
          }}
        />
      );
      break;
    case "remote":
      content = (
        <RemoteStep
          hasPassword={bootstrap.settings.server.hasDashboardPassword}
          userName={userName}
          onBack={back}
          onDone={(dashboardPassword) => {
            setSummary((s) => ({ ...s, dashboardPassword }));
            next();
          }}
        />
      );
      break;
    case "done":
      content = <DoneStep userName={userName} summary={summary} serverMode={serverMode} onFinish={finish} />;
      break;
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-background">
      <Backdrop rails={false} />

      <header
        data-tauri-drag-region
        className={cn("relative z-10 flex shrink-0 items-center justify-between px-6 pt-5 pb-2 lg:px-10", isTauri && isMac && "pt-10")}
      >
        <Wordmark />
        <p className="font-mono text-[11px] text-muted-foreground tabular-nums" aria-live="polite">
          {t("kit.stepOf", { current: index + 1, total: steps.length })}
        </p>
      </header>

      <div className="relative z-10 flex min-h-0 flex-1 gap-10 px-6 lg:px-10">
        <aside className="hidden w-60 shrink-0 pt-10 lg:block">
          <StepRail steps={meta} current={index} />
          <p className="mt-8 border-t border-dashed pt-5 text-xs leading-relaxed text-muted-foreground">
            {t("staysHere")}
          </p>
        </aside>
        <main ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl pt-8 pb-14 lg:pt-14">
            <StepProgress steps={meta} current={index} />
            <AnimatePresence mode="wait" custom={direction} initial={false}>
              <motion.div
                key={stepId}
                custom={direction}
                variants={variants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              >
                {content}
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
      </div>
    </div>
  );
}
