import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { Globe2, HandHeart, LockKeyhole, PartyPopper, Stethoscope, AppWindow } from "lucide-react";
import type { Bootstrap } from "@godmode/shared";
import { Aurora, Wordmark } from "@/components/brand";
import { BrowserStep } from "@/components/onboarding/browser-step";
import { DoneStep, type OnboardingSummary } from "@/components/onboarding/done-step";
import { RemoteStep } from "@/components/onboarding/remote-step";
import { StepProgress, StepRail, type StepMeta } from "@/components/onboarding/step-kit";
import { SystemStep } from "@/components/onboarding/system-step";
import { VaultStep } from "@/components/onboarding/vault-step";
import { WelcomeStep } from "@/components/onboarding/welcome-step";
import { api } from "@/lib/api";
import { isTauri } from "@/lib/core";
import { isMac } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

type StepId = "welcome" | "system" | "vault" | "browser" | "remote" | "done";

const STEP_META: Record<StepId, Omit<StepMeta, "id">> = {
  welcome: { title: "Welcome", hint: "Say hello", icon: <HandHeart /> },
  system: { title: "System check", hint: "Claude Code, browser & tools", icon: <Stethoscope /> },
  vault: { title: "Vault", hint: "Encrypted logins & 2FA", icon: <LockKeyhole /> },
  browser: { title: "Browser sessions", hint: "Import Chrome sign-ins", icon: <AppWindow />, optional: true },
  remote: { title: "Remote dashboard", hint: "Password for web access", icon: <Globe2 /> },
  done: { title: "Done", hint: "Start working", icon: <PartyPopper /> },
};

const SESSION_KEY = "godmode-onboarding";

function loadSession(): { step?: StepId; userName?: string } {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveSession(v: { step: StepId; userName: string }) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

const variants = {
  enter: (dir: number) => ({ opacity: 0, x: dir * 40, filter: "blur(6px)" }),
  center: { opacity: 1, x: 0, filter: "blur(0px)" },
  exit: (dir: number) => ({ opacity: 0, x: dir * -40, filter: "blur(6px)" }),
};

export function OnboardingPage({ bootstrap }: { bootstrap: Bootstrap }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const serverMode = bootstrap.mode === "server";

  // The step list is fixed on mount — bootstrap changes mid-flow (e.g. vault created) must not shift indices.
  const [steps] = useState<StepId[]>(() => {
    const list: StepId[] = ["welcome", "system"];
    if (!(bootstrap.vault.initialized && bootstrap.vault.unlocked)) list.push("vault");
    list.push("browser");
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
  const [summary, setSummary] = useState<OnboardingSummary>({
    doctorOk: null,
    vault: bootstrap.vault.initialized && bootstrap.vault.unlocked ? "existing" : null,
    importedCookies: null,
    dashboardPassword: bootstrap.settings.server.hasDashboardPassword,
  });

  const go = (to: number) => {
    const next = Math.max(0, Math.min(steps.length - 1, to));
    setDirection(next >= index ? 1 : -1);
    setIndex(next);
    saveSession({ step: steps[next], userName });
  };
  const next = () => go(index + 1);
  const back = () => go(index - 1);

  const finish = async (to: string) => {
    await api.settings.update({ onboardingComplete: true, general: { userName: userName.trim() } });
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
    navigate(to, { replace: true });
    await Promise.all([qc.invalidateQueries({ queryKey: qk.bootstrap }), qc.invalidateQueries({ queryKey: qk.settings })]);
  };

  const stepId = steps[index];
  const meta: StepMeta[] = steps.map((id) => ({ id, ...STEP_META[id] }));

  let content: ReactNode;
  switch (stepId) {
    case "welcome":
      content = <WelcomeStep userName={userName} onUserName={setUserName} onNext={next} />;
      break;
    case "system":
      content = (
        <SystemStep
          onBack={back}
          onNext={() => {
            const report = qc.getQueryData<{ dependencies: { required: boolean; ok: boolean }[] }>(qk.doctor);
            setSummary((s) => ({ ...s, doctorOk: report ? report.dependencies.every((d) => !d.required || d.ok) : null }));
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
    case "browser":
      content = (
        <BrowserStep
          onBack={back}
          onDone={(importedCookies) => {
            setSummary((s) => ({ ...s, importedCookies }));
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
      <Aurora />
      <div aria-hidden className="bg-grid pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_top,black_10%,transparent_65%)]" />

      <header
        data-tauri-drag-region
        className={cn("relative z-10 flex shrink-0 items-center justify-between px-6 pt-5 pb-2 lg:px-10", isTauri && isMac && "pt-10")}
      >
        <Wordmark />
        <p className="text-xs text-muted-foreground" aria-live="polite">
          Step {index + 1} of {steps.length}
        </p>
      </header>

      <div className="relative z-10 flex min-h-0 flex-1 gap-10 px-6 lg:px-10">
        <aside className="hidden w-60 shrink-0 pt-10 lg:block">
          <StepRail steps={meta} current={index} />
          <p className="mt-8 text-xs leading-relaxed text-muted-foreground">
            Everything stays on this machine. You can change any of this later in Settings.
          </p>
        </aside>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl pt-6 pb-12 lg:pt-10">
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
