import { Link } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Bot, MoveRight, User, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useBootstrap } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";

type Direction = "to-you" | "to-agents";

const COPY = {
  "to-you": { key: "toYou", to: "/tasks", label: "nav.tasks" },
  "to-agents": { key: "toAgents", to: "/inbox", label: "nav.inbox" },
} as const satisfies Record<Direction, { key: string; to: string; label: string }>;

function Node({ icon, label, active }: { icon: React.ReactNode; label: string; active?: boolean }) {
  return (
    <span
      aria-label={label}
      className={cn(
        "grid size-7 place-items-center rounded-full border [&_svg]:size-3.5",
        active ? "border-brand/30 bg-brand/10 text-brand" : "bg-card text-muted-foreground",
      )}
    >
      {icon}
    </span>
  );
}

/** Says which way the work flows on Needs you and Agent tasks, and links the other page. */
export function DirectionHint({ direction, className }: { direction: Direction; className?: string }) {
  const { t } = useTranslation("layout");
  const key = `direction-${direction}`;
  const hidden = useUi((s) => s.hiddenHints.includes(key));
  const hide = useUi((s) => s.hideHint);
  const copy = COPY[direction];
  const counts = useBootstrap().data?.counts;
  const attention = counts?.attention;
  const otherCount =
    direction === "to-you"
      ? (attention?.review ?? 0) + (attention?.blocked ?? 0)
      : (attention?.total ?? (counts?.openQuestions ?? 0) + (counts?.openMissingLogins ?? 0));
  const agents = <Node icon={<Bot />} label={t("directionHint.agents")} active={direction === "to-agents"} />;
  const you = <Node icon={<User />} label={t("directionHint.you")} active={direction === "to-you"} />;

  return (
    <AnimatePresence initial={false}>
      {!hidden && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.18 }}
          className={cn("overflow-hidden px-5 @2xl:px-8", className)}
        >
          <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-card/60 py-2.5 pr-2 pl-3">
            <div className="flex shrink-0 items-center gap-1" aria-hidden>
              {direction === "to-you" ? agents : you}
              <MoveRight className="size-3.5 text-muted-foreground/70" />
              {direction === "to-you" ? you : agents}
            </div>
            <p className="min-w-0 flex-1 basis-72 text-sm leading-snug">
              <span className="font-medium">{t(`directionHint.${copy.key}.title`)}</span> <span className="text-muted-foreground">{t(`directionHint.${copy.key}.body`)}</span>
            </p>
            <div className="flex shrink-0 items-center gap-1">
              <Link
                to={copy.to}
                className="group flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <span className="hidden @3xl:inline">{t(`directionHint.${copy.key}.lead`)}</span>
                <span className="font-medium text-foreground">{t(copy.label)}</span>
                {otherCount ? <span className="rounded-full bg-muted px-1.5 font-mono text-[11px] tabular-nums">{otherCount}</span> : null}
                <ArrowRight className="size-3.5 transition group-hover:translate-x-0.5" />
              </Link>
              <button
                type="button"
                onClick={() => hide(key)}
                aria-label={t("directionHint.hideLabel")}
                title={t("directionHint.hide")}
                className="grid size-7 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none [&_svg]:size-3.5"
              >
                <X />
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
