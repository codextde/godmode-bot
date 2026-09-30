import { useMemo, type ReactNode } from "react";
import { motion } from "motion/react";
import { Globe2, Layers } from "lucide-react";
import type { AgentCharacter, CharacterMood } from "@godmode/shared";
import { defaultCharacter } from "@godmode/shared";
import { Character } from "@/components/character";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useWorkspaceName } from "@/lib/hooks";
import { useAgentRunning } from "@/stores/live";

/** Consistent page header used by every screen: quiet icon tile, medium-weight title, muted description. */
export function PageHeader({
  title,
  description,
  icon,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-4 px-5 pt-6 pb-5 @2xl:px-8 @2xl:pt-8 @2xl:pb-6", className)}>
      <div className="flex min-w-0 items-start gap-3.5">
        {icon && (
          <div className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-lg border bg-card text-foreground shadow-card [&_svg]:size-[18px]">
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <h1 className="truncate text-[23px] leading-tight font-medium tracking-[-0.03em] @2xl:text-[26px]">{title}</h1>
          {description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("px-5 pb-10 @2xl:px-8", className)}>{children}</div>;
}

export function EmptyState({
  icon,
  art,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  /** Larger illustration (e.g. a character) shown instead of the icon tile. */
  art?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed bg-card/50 px-6 py-14 text-center",
        className,
      )}
    >
      {art && <div className="mb-4">{art}</div>}
      {icon && !art && (
        <div className="mb-4 grid size-11 place-items-center rounded-lg border bg-card text-foreground shadow-card [&_svg]:size-5">
          {icon}
        </div>
      )}
      <h3 className="text-base font-medium tracking-[-0.01em]">{title}</h3>
      {description && <p className="mt-1.5 max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </motion.div>
  );
}

/** Flat, softly tinted tiles — an agent's colour is an identity cue, not a light show. */
const COLOR_CLASSES: Record<string, string> = {
  violet: "bg-violet-500/12 ring-violet-600/15 dark:bg-violet-400/14",
  indigo: "bg-indigo-500/12 ring-indigo-600/15 dark:bg-indigo-400/14",
  sky: "bg-sky-500/12 ring-sky-600/15 dark:bg-sky-400/14",
  cyan: "bg-cyan-500/12 ring-cyan-600/15 dark:bg-cyan-400/14",
  emerald: "bg-emerald-500/12 ring-emerald-600/15 dark:bg-emerald-400/14",
  lime: "bg-lime-500/14 ring-lime-600/15 dark:bg-lime-400/14",
  amber: "bg-amber-500/14 ring-amber-600/15 dark:bg-amber-400/14",
  orange: "bg-orange-500/12 ring-orange-600/15 dark:bg-orange-400/14",
  rose: "bg-rose-500/12 ring-rose-600/15 dark:bg-rose-400/14",
  fuchsia: "bg-fuchsia-500/12 ring-fuchsia-600/15 dark:bg-fuchsia-400/14",
};

/** Tile classes for an agent colour (name kept for existing callers). */
export function colorGradient(color: string | undefined) {
  return COLOR_CLASSES[color ?? "violet"] ?? COLOR_CLASSES.violet;
}

const SWATCH_CLASSES: Record<string, string> = {
  violet: "bg-violet-500",
  indigo: "bg-indigo-500",
  sky: "bg-sky-500",
  cyan: "bg-cyan-500",
  emerald: "bg-emerald-500",
  lime: "bg-lime-500",
  amber: "bg-amber-500",
  orange: "bg-orange-500",
  rose: "bg-rose-500",
  fuchsia: "bg-fuchsia-500",
};

/** A solid dot of the colour — for colour pickers and tiny identity markers. */
export function colorSwatch(color: string | undefined) {
  return SWATCH_CLASSES[color ?? "violet"] ?? SWATCH_CLASSES.violet;
}

/** Rendered sizes of `AgentAvatar`; `sm` gets an enlarged face so it still reads at 16–24px. */
const AVATAR_SIZES = { sm: "size-6", md: "size-8", lg: "size-12", xl: "size-16" } as const;

/**
 * The agent's character — the creature itself is the avatar. It works while a run is live and naps while the agent is
 * disabled; `mood` overrides both (e.g. "attention" where the agent waits for the human). Decorative — the name is
 * almost always written next to it; label the surrounding link or button where it stands alone.
 */
export function AgentAvatar({
  agent,
  size = "md",
  mood,
  follow,
  still,
  className,
}: {
  agent: { id?: string; name?: string; avatar?: string; color: string; character?: AgentCharacter; enabled?: boolean };
  size?: keyof typeof AVATAR_SIZES;
  mood?: CharacterMood;
  follow?: boolean;
  still?: boolean;
  className?: string;
}) {
  const running = useAgentRunning(agent.id);
  const seed = agent.id ?? agent.avatar ?? agent.name ?? "agent";
  const character = useMemo(() => agent.character ?? defaultCharacter(seed), [agent.character, seed]);
  return (
    <Character
      character={character}
      color={agent.color}
      mood={mood ?? (running ? "working" : agent.enabled === false ? "sleeping" : "idle")}
      size={AVATAR_SIZES[size]}
      faceScale={size === "sm" ? 1.25 : size === "md" ? 1.1 : 1}
      follow={follow}
      still={still}
      phaseSeed={seed}
      className={className}
    />
  );
}

export function ScopeBadge({ workspaceId, className }: { workspaceId: string | null | undefined; className?: string }) {
  const name = useWorkspaceName(workspaceId);
  return (
    <Badge variant="secondary" className={cn("gap-1 font-normal", className)}>
      {workspaceId ? <Layers className="size-3" /> : <Globe2 className="size-3" />}
      {name}
    </Badge>
  );
}

export function StatusDot({ status, className }: { status: "ok" | "warn" | "error" | "idle" | "running"; className?: string }) {
  const map = {
    ok: "bg-success",
    warn: "bg-warning",
    error: "bg-destructive",
    idle: "bg-muted-foreground/50",
    running: "bg-brand animate-live-dot",
  } as const;
  return <span className={cn("inline-block size-2 rounded-full", map[status], className)} />;
}

export function DraftStatus({ onDiscard, className }: { onDiscard: () => void; className?: string }) {
  return (
    <motion.span
      initial={{ opacity: 0, y: 2 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn("inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground", className)}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-brand" />
      Draft saved
      <span aria-hidden className="opacity-40">
        ·
      </span>
      <button
        type="button"
        onClick={onDiscard}
        className="rounded-sm font-medium text-foreground/70 transition hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        Discard
      </button>
    </motion.span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-0.5 rounded-[4px] border bg-card px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}

/** Section card with title — used across settings/detail pages. */
export function Section({
  id,
  title,
  description,
  children,
  actions,
  className,
}: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={cn("scroll-mt-6 rounded-xl border bg-card p-5 shadow-card", className)}>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
