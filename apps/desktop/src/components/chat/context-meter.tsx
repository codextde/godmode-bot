import { Link } from "react-router";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { ArrowRight, FoldVertical, Loader2, X } from "lucide-react";
import type { CompactInfo, ContextGauge, ConversationContext } from "@godmode/shared";
import { contextGauge, tokensLabel } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSettings } from "@/lib/hooks";
import { cn } from "@/lib/utils";

export { tokensLabel, type ContextGauge };

export function useContextGauge(context: ConversationContext | null | undefined): ContextGauge | null {
  return contextGauge(context, useSettings().data?.runner.autoCompactPercent);
}

const TONE = {
  calm: { ring: "text-foreground/55", bar: "bg-foreground/70", text: "text-muted-foreground" },
  warn: { ring: "text-warning", bar: "bg-warning", text: "text-warning" },
  full: { ring: "text-destructive", bar: "bg-destructive", text: "text-destructive" },
} as const;

function Ring({ share, tone, busy }: { share: number; tone: ContextGauge["tone"]; busy?: boolean }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 18 18" className={cn("size-[17px] -rotate-90", TONE[tone].ring, busy && "animate-spin [animation-duration:1.6s]")} aria-hidden>
      <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeOpacity={0.18} strokeWidth="2.2" />
      <motion.circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeDasharray={c}
        initial={false}
        animate={{ strokeDashoffset: c * (1 - (busy ? 0.25 : Math.max(0.04, share))) }}
        transition={{ duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }}
      />
    </svg>
  );
}

/** The composer's context ring: how full the chat's session is, with Compress one click away. */
export function ContextMeter({
  gauge,
  agentName,
  running,
  compressing,
  onCompress,
  disabled,
}: {
  gauge: ContextGauge;
  agentName: string;
  running: boolean;
  compressing: boolean;
  onCompress: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("chat");
  const pct = gauge.share === null ? null : Math.round(gauge.share * 100);
  const tone = TONE[gauge.tone];
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={pct === null ? t("meter.ariaTokens", { tokens: tokensLabel(gauge.tokens) }) : t("meter.ariaPct", { pct })}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-1.5 text-[12px] font-medium text-muted-foreground tabular-nums transition outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-accent data-[state=open]:text-foreground"
            >
              <Ring share={gauge.share ?? 0} tone={gauge.tone} busy={compressing} />
              {gauge.tone !== "calm" && pct !== null && <span className={cn("@max-md/composer:hidden", tone.text)}>{pct}%</span>}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{compressing ? t("meter.compressingChat") : pct === null ? t("meter.tokensInChat", { tokens: tokensLabel(gauge.tokens) }) : t("meter.ariaPct", { pct })}</TooltipContent>
      </Tooltip>
      <PopoverContent side="top" align="end" className="w-[19rem] p-0">
        <div className="px-4 pt-3.5 pb-3">
          <div className="eyebrow pb-2">{t("meter.title")}</div>
          <div className="flex items-baseline justify-between gap-3">
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-semibold tracking-tight tabular-nums">{tokensLabel(gauge.tokens)}</span>
              <span className="text-xs text-muted-foreground">{gauge.window ? t("meter.ofTokens", { window: tokensLabel(gauge.window) }) : t("meter.tokens")}</span>
            </div>
            {pct !== null && <span className={cn("text-sm font-medium tabular-nums", tone.text)}>{pct}%</span>}
          </div>
          {gauge.share !== null && (
            <div className="relative mt-2.5 h-1.5 rounded-full bg-foreground/[0.08]">
              <motion.div
                className={cn("h-full rounded-full", tone.bar)}
                initial={false}
                animate={{ width: `${Math.max(1.5, gauge.share * 100)}%` }}
                transition={{ duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }}
              />
              {gauge.autoAt !== null && (
                <span className="absolute -top-1 h-3.5 w-px bg-foreground/40" style={{ left: `${gauge.autoAt * 100}%` }} title={t("meter.autoAtTitle", { pct: Math.round(gauge.autoAt * 100) })} />
              )}
            </div>
          )}
          <p className="mt-3 text-[12.5px] leading-relaxed text-muted-foreground">
            {t("meter.explain", { name: agentName })}
          </p>
        </div>
        <div className="flex items-center justify-between gap-2 border-t bg-muted/40 px-3 py-2.5">
          <Link to="/settings/ai#auto-compact" className="text-[12px] text-muted-foreground transition hover:text-foreground">
            {gauge.autoAt === null ? t("meter.autoOff") : t("meter.autoAt", { pct: Math.round(gauge.autoAt * 100) })}
          </Link>
          <Button size="sm" variant={gauge.tone === "calm" ? "outline" : "default"} disabled={disabled || compressing || !gauge.compressible} onClick={onCompress} className="h-7 gap-1.5 text-[12.5px]">
            {compressing ? <Loader2 className="size-3.5 animate-spin" /> : <FoldVertical className="size-3.5" />}
            {compressing ? t("meter.compressing") : !gauge.compressible ? t("meter.nothing") : running ? t("meter.afterStep") : t("meter.now")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Above the composer once the chat gets long. */
export function CompressBar({ gauge, agentName, running, onCompress, onDismiss }: { gauge: ContextGauge; agentName: string; running: boolean; onCompress: () => void; onDismiss: () => void }) {
  const { t } = useTranslation("chat");
  const pct = gauge.share === null ? null : Math.round(gauge.share * 100);
  const auto = gauge.autoAt !== null ? Math.round(gauge.autoAt * 100) : null;
  return (
    <div className={cn("mb-2 flex items-center gap-3 rounded-xl border px-3 py-2 text-[13px] shadow-card", gauge.tone === "full" ? "border-destructive/25 bg-destructive/[0.05]" : "border-warning/30 bg-warning/[0.06]")}>
      <span className={cn("grid size-7 shrink-0 place-items-center rounded-lg", gauge.tone === "full" ? "bg-destructive/10 text-destructive" : "bg-warning/15 text-warning")}>
        <FoldVertical className="size-4" />
      </span>
      <span className="min-w-0 flex-1 leading-snug">
        <span className="font-medium text-foreground">{t("meter.gettingLong")}</span>
        <span className="text-muted-foreground">
          {" "}
          · {pct !== null ? t("meter.barTokensPct", { tokens: tokensLabel(gauge.tokens), pct }) : t("meter.barTokens", { tokens: tokensLabel(gauge.tokens) })}.{" "}
          {auto !== null ? t("meter.autoBy", { name: agentName, pct: auto }) : t("meter.keepQuick")}
        </span>
      </span>
      <Button size="xs" onClick={onCompress} className="shrink-0 gap-1">
        {running ? t("meter.compressNext") : t("meter.now")} <ArrowRight className="size-3" />
      </Button>
      <button type="button" aria-label={t("meter.hide")} onClick={onDismiss} className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-foreground/5 hover:text-foreground">
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** Where the conversation was summarized: a quiet divider, earlier messages stay readable above it. */
export function CompactedDivider({ info }: { info: CompactInfo }) {
  const { t } = useTranslation("chat");
  const saved = info.preTokens && info.postTokens !== null ? Math.max(0, Math.round((1 - info.postTokens / info.preTokens) * 100)) : null;
  return (
    <motion.div initial={{ opacity: 0, scaleX: 0.9 }} animate={{ opacity: 1, scaleX: 1 }} transition={{ duration: 0.35, ease: [0.2, 0.8, 0.2, 1] }} className="flex items-center gap-3 py-1.5" role="separator">
      <span className="h-px flex-1 bg-gradient-to-r from-transparent to-border" />
      <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-[11.5px] text-muted-foreground shadow-card">
        <FoldVertical className="size-3.5 text-success" />
        <span className="font-medium text-foreground">{info.auto ? t("meter.compressedAuto") : t("meter.compressed")}</span>
        {info.preTokens !== null && info.postTokens !== null && (
          <span className="tabular-nums">
            · {tokensLabel(info.preTokens)} → {tokensLabel(info.postTokens)}
            {saved !== null && saved > 0 ? ` (−${saved}%)` : ""}
          </span>
        )}
      </span>
      <span className="h-px flex-1 bg-gradient-to-l from-transparent to-border" />
    </motion.div>
  );
}
