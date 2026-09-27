import { useState } from "react";
import { motion } from "motion/react";
import { ArrowRight, Bot, CircleCheck, CircleDashed, Plug, ShieldCheck } from "lucide-react";
import { FormError, SubmitButton } from "./auth-layout";
import { Confetti, StepCard } from "./step-kit";

export interface OnboardingSummary {
  doctorOk: boolean | null;
  vault: "created" | "unlocked" | "existing" | null;
  importedCookies: number | null;
  dashboardPassword: boolean | null;
}

const NEXT = [
  { to: "/agents/new", icon: <Bot />, title: "Hire your first agent", body: "Pick a template or describe the job." },
  { to: "/vault/2fa?import=1", icon: <ShieldCheck />, title: "Import 2FA codes", body: "Scan Google Authenticator exports." },
  { to: "/integrations", icon: <Plug />, title: "Connect your apps", body: "Gmail, Slack, GitHub and more via Composio." },
];

export function DoneStep({
  userName,
  summary,
  serverMode,
  onFinish,
}: {
  userName: string;
  summary: OnboardingSummary;
  serverMode: boolean;
  onFinish: (to: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const first = userName.trim().split(/\s+/)[0];

  const finish = async (to: string) => {
    if (busy) return;
    setBusy(to);
    setError(null);
    try {
      await onFinish(to);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const items: { label: string; ok: boolean | null; detail?: string }[] = [
    { label: "System check", ok: summary.doctorOk, detail: summary.doctorOk === false ? "Some tools still missing — see Settings → System" : undefined },
    {
      label: "Encrypted vault",
      ok: summary.vault !== null,
      detail: summary.vault === "created" ? "Created" : summary.vault ? "Unlocked" : undefined,
    },
    {
      label: "Browser sessions",
      ok: summary.importedCookies !== null ? true : null,
      detail: summary.importedCookies !== null ? `${summary.importedCookies.toLocaleString()} cookies imported` : "Skipped — import any time from Browser",
    },
  ];
  if (serverMode)
    items.push({
      label: "Dashboard password",
      ok: summary.dashboardPassword,
      detail: summary.dashboardPassword ? "Set" : "Not set — sign in with access tokens",
    });

  return (
    <StepCard className="relative overflow-hidden">
      <Confetti />
      <div className="flex flex-col items-center text-center">
        <motion.div
          initial={{ scale: 0, rotate: -30 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: "spring", stiffness: 240, damping: 14, delay: 0.1 }}
          className="grid size-16 place-items-center rounded-2xl bg-gradient-brand text-white shadow-lg shadow-glow-a/30"
        >
          <CircleCheck className="size-8" />
        </motion.div>
        <h2 className="mt-5 text-3xl font-semibold tracking-tight">
          You're all set{first ? `, ${first}` : ""}! <span className="inline-block origin-bottom-right animate-[wave_1.6s_ease-in-out_2]">👋</span>
        </h2>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          Your coworker is ready. Tell it what you need in plain words — it will sign in, browse and report back.
        </p>
      </div>

      <ul className="mx-auto mt-7 grid max-w-md gap-2">
        {items.map((it, i) => (
          <motion.li
            key={it.label}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25 + i * 0.07 }}
            className="flex items-center gap-3 rounded-xl border bg-card/50 px-3.5 py-2.5 text-sm"
          >
            {it.ok ? (
              <CircleCheck className="size-4 shrink-0 text-success" />
            ) : it.ok === false ? (
              <CircleDashed className="size-4 shrink-0 text-warning" />
            ) : (
              <CircleDashed className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="font-medium">{it.label}</span>
            {it.detail && <span className="ml-auto truncate text-xs text-muted-foreground">{it.detail}</span>}
          </motion.li>
        ))}
      </ul>

      <div className="mt-7 grid gap-2 sm:grid-cols-3">
        {NEXT.map((n, i) => (
          <motion.button
            key={n.to}
            type="button"
            disabled={!!busy}
            onClick={() => finish(n.to)}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.45 + i * 0.07 }}
            className="group rounded-2xl border bg-card/60 p-4 text-left transition hover:border-primary/30 hover:shadow-lg hover:shadow-glow-a/5 disabled:opacity-60"
          >
            <div className="mb-2.5 grid size-8 place-items-center rounded-lg bg-primary/10 text-primary [&_svg]:size-4">{n.icon}</div>
            <p className="flex items-center gap-1 text-sm font-medium">
              {n.title}
              <ArrowRight className="size-3.5 opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" />
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{n.body}</p>
          </motion.button>
        ))}
      </div>

      {error && (
        <div className="mt-5">
          <FormError message={error} />
        </div>
      )}

      <div className="mt-7 flex justify-center">
        <SubmitButton busy={busy === "/"} disabled={!!busy} type="button" onClick={() => finish("/")} className="w-auto px-8">
          Start working
        </SubmitButton>
      </div>
      <style>{`@keyframes wave { 0%,100% { transform: rotate(0) } 20% { transform: rotate(16deg) } 40% { transform: rotate(-8deg) } 60% { transform: rotate(14deg) } 80% { transform: rotate(-4deg) } }`}</style>
    </StepCard>
  );
}
