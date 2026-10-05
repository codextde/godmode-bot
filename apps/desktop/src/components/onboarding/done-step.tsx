import { useState } from "react";
import { motion } from "motion/react";
import { ArrowRight, Bot, CircleCheck, CircleDashed, Plug, ShieldCheck } from "lucide-react";
import { MASCOT_CHARACTER, MASCOT_COLOR, type LicenseState } from "@godmode/shared";
import { Character } from "@/components/character";
import { FormError, SubmitButton } from "./auth-layout";
import { Confetti, StepCard } from "./step-kit";

export interface OnboardingSummary {
  doctorOk: boolean | null;
  vault: "created" | "unlocked" | "existing" | null;
  importedCookies: number | null;
  dashboardPassword: boolean | null;
  license: LicenseState | null;
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
  const license = summary.license;
  const licensed = !!license?.keyHint && !license.blocked && ["active", "trial", "past_due", "unverified"].includes(license.status);
  items.push({
    label: "Godmode Pro",
    ok: licensed ? true : license?.blocked ? false : null,
    detail: licensed ? (license!.status === "trial" ? "Free trial active" : "Activated") : license?.status === "grace" ? "Add your key in Settings → License" : "Skipped",
  });
  if (serverMode)
    items.push({
      label: "Dashboard password",
      ok: summary.dashboardPassword,
      detail: summary.dashboardPassword ? "Set" : "Not set — sign in with access tokens",
    });

  return (
    <div>
      <Confetti />
      <div className="mb-8 flex flex-col items-center text-center">
        <motion.div
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 260, damping: 20, delay: 0.1 }}
        >
          <Character character={MASCOT_CHARACTER} color={MASCOT_COLOR} size={88} mood="happy" follow title="Godmode" />
        </motion.div>
        <p className="eyebrow mt-7">Setup complete</p>
        <h2 className="heading-display mt-3 text-[40px] sm:text-[48px]">
          You're all set{first ? `, ${first}` : ""}.
          <span className="block text-foreground/35">Your coworker is ready.</span>
        </h2>
        <p className="mt-4 max-w-md text-[15px] leading-relaxed text-muted-foreground">
          Tell it what you need in plain words — it will sign in, browse and report back.
        </p>
      </div>

      <StepCard>
        <ul className="divide-y overflow-hidden rounded-xl border bg-paper-2">
          {items.map((it, i) => (
            <motion.li
              key={it.label}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.25 + i * 0.07 }}
              className="flex items-center gap-3 px-3.5 py-2.5 text-sm"
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

        <p className="eyebrow mt-7 mb-3">Next up</p>
        <div className="grid gap-2 sm:grid-cols-3">
          {NEXT.map((n, i) => (
            <motion.button
              key={n.to}
              type="button"
              disabled={!!busy}
              onClick={() => finish(n.to)}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.45 + i * 0.07 }}
              className="group rounded-lg border bg-card p-4 text-left shadow-card transition hover:border-foreground/15 hover:shadow-float focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60"
            >
              <div className="mb-2.5 grid size-8 place-items-center rounded-md border bg-secondary text-foreground [&_svg]:size-4">{n.icon}</div>
              <p className="flex items-center gap-1 text-sm font-medium tracking-[-0.01em]">
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

        <div className="mt-7 flex justify-center border-t pt-5">
          <SubmitButton busy={busy === "/"} disabled={!!busy} type="button" onClick={() => finish("/")} className="w-auto px-8">
            Start working
          </SubmitButton>
        </div>
      </StepCard>
    </div>
  );
}
