import type { ReactNode } from "react";
import { motion } from "motion/react";
import { Globe2, Layers } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useWorkspaceName } from "@/lib/hooks";
import { useAgentRunning } from "@/stores/live";

/** Consistent page header used by every screen. */
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
    <div className={cn("flex flex-wrap items-start justify-between gap-4 px-8 pt-8 pb-6", className)}>
      <div className="flex min-w-0 items-start gap-3.5">
        {icon && (
          <div className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-xl border bg-card text-primary shadow-sm [&_svg]:size-5">
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("px-8 pb-10", className)}>{children}</div>;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
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
        "flex flex-col items-center justify-center rounded-2xl border border-dashed bg-card/40 px-6 py-14 text-center",
        className,
      )}
    >
      {icon && (
        <div className="mb-4 grid size-12 place-items-center rounded-2xl bg-gradient-brand text-white shadow-lg shadow-glow-a/20 [&_svg]:size-6">
          {icon}
        </div>
      )}
      <h3 className="text-base font-semibold">{title}</h3>
      {description && <p className="mt-1.5 max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </motion.div>
  );
}

const COLOR_CLASSES: Record<string, string> = {
  violet: "from-violet-500 to-purple-600",
  indigo: "from-indigo-500 to-blue-600",
  sky: "from-sky-400 to-blue-500",
  cyan: "from-cyan-400 to-teal-500",
  emerald: "from-emerald-400 to-green-600",
  lime: "from-lime-400 to-green-500",
  amber: "from-amber-400 to-orange-500",
  orange: "from-orange-400 to-red-500",
  rose: "from-rose-400 to-pink-600",
  fuchsia: "from-fuchsia-400 to-purple-600",
};

export function colorGradient(color: string | undefined) {
  return COLOR_CLASSES[color ?? "violet"] ?? COLOR_CLASSES.violet;
}

/** Emoji avatar with gradient tile; glows while the agent is running. */
export function AgentAvatar({
  agent,
  size = "md",
  className,
}: {
  agent: { id?: string; avatar: string; color: string };
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}) {
  const running = useAgentRunning(agent.id);
  const sizes = { sm: "size-6 text-sm rounded-md", md: "size-9 text-lg rounded-xl", lg: "size-12 text-2xl rounded-2xl", xl: "size-16 text-3xl rounded-2xl" };
  return (
    <div
      className={cn(
        "relative grid shrink-0 place-items-center bg-gradient-to-br shadow-sm ring-1 ring-white/10",
        colorGradient(agent.color),
        sizes[size],
        running && "animate-pulse-ring",
        className,
      )}
    >
      <span className="drop-shadow-sm">{agent.avatar || "🤖"}</span>
      {running && <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-background bg-success" />}
    </div>
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
    running: "bg-primary animate-pulse",
  } as const;
  return <span className={cn("inline-block size-2 rounded-full", map[status], className)} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}

/** Section card with title — used across settings/detail pages. */
export function Section({
  title,
  description,
  children,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-2xl border bg-card/60 p-5 backdrop-blur-sm", className)}>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
