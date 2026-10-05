import {
  Bell,
  EyeOff,
  FileLock,
  Filter,
  Gauge,
  GitBranch,
  Puzzle,
  ScrollText,
  Shield,
  Terminal,
  Timer,
  TriangleAlert,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import {
  MOD_HOOKS_PATH,
  MOD_MANIFEST_PATH,
  modAbilities,
  modHookLabel,
  type Agent,
  type Mod,
  type ModAbility,
  type ModCheck,
  type ModHook,
  type ModIcon,
  type ModProblem,
  type ModState,
} from "@godmode/shared";
import { LiveDot } from "@/components/aicss/Motion";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const MOD_TABS = ["overview", "options", "code"] as const;
export type ModTab = (typeof MOD_TABS)[number];

export function isModTab(value: string | null): value is ModTab {
  return (MOD_TABS as readonly string[]).includes(value ?? "");
}

export const MOD_ICON: Record<ModIcon, LucideIcon> = {
  puzzle: Puzzle,
  shield: Shield,
  "file-lock": FileLock,
  terminal: Terminal,
  "eye-off": EyeOff,
  gauge: Gauge,
  timer: Timer,
  "git-branch": GitBranch,
  scroll: ScrollText,
  bell: Bell,
  filter: Filter,
  wand: WandSparkles,
};

export const MOD_ICON_LABEL: Record<ModIcon, string> = {
  puzzle: "Puzzle piece",
  shield: "Shield",
  "file-lock": "Locked file",
  terminal: "Terminal",
  "eye-off": "Hidden",
  gauge: "Gauge",
  timer: "Timer",
  "git-branch": "Git branch",
  scroll: "Scroll",
  bell: "Bell",
  filter: "Filter",
  wand: "Wand",
};

export function ModGlyph({ icon, className }: { icon: ModIcon; className?: string }) {
  const Icon = MOD_ICON[icon] ?? Puzzle;
  return <Icon className={className} aria-hidden />;
}

/** The mod's icon on a tile; with a `state` the tile lifts while the mod is on and carries a status dot. */
export function ModIconTile({
  icon,
  state,
  size = "md",
  raised = state === "on",
  className,
}: {
  icon: ModIcon;
  state?: ModState;
  size?: "sm" | "md";
  raised?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("relative shrink-0", className)}>
      <div
        className={cn(
          "grid place-items-center rounded-lg border",
          size === "md" ? "size-10 [&_svg]:size-5" : "size-9 [&_svg]:size-[18px]",
          raised ? "bg-card text-foreground shadow-card" : state ? "bg-paper-2 text-muted-foreground" : "bg-paper-2 text-foreground",
        )}
      >
        <ModGlyph icon={icon} />
      </div>
      {state && (
        <span className="absolute -right-1 -bottom-1 grid place-items-center rounded-full bg-card p-[2px]">
          {state === "on" ? (
            <LiveDot live={false} className="bg-brand" />
          ) : (
            <span
              aria-hidden
              className={cn("block size-[7px] rounded-full", state === "broken" ? "bg-destructive" : state === "review" ? "bg-warning" : "bg-muted-foreground/40")}
            />
          )}
        </span>
      )}
    </div>
  );
}

export const MOD_STATE_LABEL: Record<ModState, string> = {
  on: "On",
  off: "Off",
  review: "Needs review",
  broken: "Needs fixing",
};

const STATE_BADGE: Record<ModState, string> = {
  on: "border-brand/25 bg-brand-soft text-brand-strong",
  off: "border-border bg-secondary text-muted-foreground",
  review: "border-warning/30 bg-warning/[0.07] text-warning",
  broken: "border-destructive/25 bg-destructive/[0.06] text-destructive",
};

export function ModStateBadge({ state, className }: { state: ModState; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-[5px] border px-1.5 text-[11px] font-medium whitespace-nowrap [&_svg]:size-3",
        STATE_BADGE[state],
        className,
      )}
    >
      {state === "on" ? (
        <LiveDot live={false} className="size-1.5 bg-brand" />
      ) : state === "off" ? (
        <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/50" />
      ) : (
        <TriangleAlert aria-hidden />
      )}
      {MOD_STATE_LABEL[state]}
    </span>
  );
}

/** The agent that drafted the mod ("agent:<id>"), when it still exists. */
export function modAuthor(mod: Pick<Mod, "createdBy">, agents: Agent[]): Agent | undefined {
  const id = mod.createdBy.startsWith("agent:") ? mod.createdBy.slice(6) : null;
  return id ? agents.find((a) => a.id === id) : undefined;
}

export function modOriginLabel(mod: Pick<Mod, "origin" | "createdBy">, agents: Agent[]): string {
  if (mod.origin === "template") return "From the gallery";
  if (mod.origin === "import") return "Imported";
  if (mod.origin === "agent") return `Drafted by ${modAuthor(mod, agents)?.name ?? "an agent"}`;
  return "Written by you";
}

/** What a mod hooks into, in words, each named once. */
export function hookLabels(hooks: ModHook[]): string[] {
  return [...new Set(hooks.map(modHookLabel))];
}

export function sensitiveAbilities(check: ModCheck | null): ModAbility[] {
  return check ? modAbilities(check).filter((a) => a.level === "sensitive") : [];
}

export const CHIP = "inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded-[5px] border px-1.5 text-[11px] whitespace-nowrap";

export function HookChips({ hooks, max = 4 }: { hooks: ModHook[]; max?: number }) {
  const labels = hookLabels(hooks);
  const rest = labels.slice(max);
  return (
    <>
      {labels.slice(0, max).map((label) => (
        <span key={label} className={cn(CHIP, "bg-paper-2 text-foreground/80")}>
          <span className="truncate">{label}</span>
        </span>
      ))}
      {rest.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              aria-label={`${rest.length} more: ${rest.join(", ")}`}
              className={cn(CHIP, "bg-paper-2 text-muted-foreground tabular-nums outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50")}
            >
              +{rest.length}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-72">{rest.join(" · ")}</TooltipContent>
        </Tooltip>
      )}
    </>
  );
}

/** Something a mod does outside the conversation: a warning-tinted chip that explains itself on hover or focus. */
export function AbilityChip({ ability }: { ability: ModAbility }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={cn(CHIP, "border-warning/30 bg-warning/[0.07] text-warning outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50")}>
          <TriangleAlert className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{ability.label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{ability.detail}</TooltipContent>
    </Tooltip>
  );
}

/** A mod's files in the order they are listed: the manifest and hooks.json first, then by path. */
export function sortedPaths(files: Record<string, string>): string[] {
  const rank = (path: string) => (path === MOD_MANIFEST_PATH ? 0 : path === MOD_HOOKS_PATH ? 1 : 2);
  return Object.keys(files).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** The module a mod's hooks.json names, else its first code file. */
export function hooksModulePath(files: Record<string, string>): string | null {
  const paths = sortedPaths(files);
  try {
    const named = (JSON.parse(files[MOD_HOOKS_PATH] ?? "{}") as { modules?: unknown }).modules;
    const first = Array.isArray(named) && typeof named[0] === "string" ? named[0] : null;
    if (first) {
      const dir = MOD_HOOKS_PATH.slice(0, MOD_HOOKS_PATH.lastIndexOf("/") + 1);
      const resolved = (dir + first.replace(/^\.\//, "")).replace(/[^/]+\/\.\.\//g, "");
      if (resolved in files) return resolved;
    }
  } catch {
    /* fall through to the first code file */
  }
  return paths.find((p) => /\.[cm]?[jt]sx?$/.test(p)) ?? paths.find((p) => p !== MOD_MANIFEST_PATH) ?? paths[0] ?? null;
}

/** The file (and line) a problem's `where` points at: "hooks/register.ts:12", "plugin.json › userConfig.paths". */
export function problemTarget(where: string, paths: string[]): { path: string; line: number | null } | null {
  const longestFirst = [...paths].sort((a, b) => b.length - a.length);
  const follows = (prefix: string) => where === prefix || (where.startsWith(prefix) && /^[\s:›(,]/.test(where.slice(prefix.length)));
  const path = longestFirst.find(follows) ?? longestFirst.find((p) => follows(p.slice(p.lastIndexOf("/") + 1)));
  if (!path) return null;
  const line = /:(\d+)/.exec(where)?.[1];
  return { path, line: line ? Number(line) : null };
}

export function ModProblems({
  problems,
  tone,
  paths,
  onOpenFile,
  className,
}: {
  problems: ModProblem[];
  tone: "error" | "warning";
  /** With `onOpenFile`: the mod's files, so a problem that names one opens it. */
  paths?: string[];
  onOpenFile?: (path: string, line: number | null) => void;
  className?: string;
}) {
  if (!problems.length) return null;
  const color = tone === "error" ? "text-destructive" : "text-warning";
  return (
    <ul className={cn("space-y-1.5", className)}>
      {problems.map((p, i) => {
        const target = onOpenFile && paths ? problemTarget(p.where, paths) : null;
        return (
          <li key={i} className="flex items-start gap-2 text-xs leading-relaxed">
            <TriangleAlert className={cn("mt-[3px] size-3.5 shrink-0", color)} aria-hidden />
            <p className="min-w-0 break-words">
              <span className="sr-only">{tone === "error" ? "Error" : "Warning"} in </span>
              {target ? (
                <button
                  type="button"
                  onClick={() => onOpenFile?.(target.path, target.line)}
                  className={cn(
                    "rounded-sm font-mono text-[11.5px] underline decoration-current/30 underline-offset-[3px] outline-none hover:decoration-current focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    color,
                  )}
                >
                  {p.where}
                </button>
              ) : (
                <span className={cn("font-mono text-[11.5px]", color)}>{p.where}</span>
              )}
              <span className="text-foreground/85"> {p.message}</span>
            </p>
          </li>
        );
      })}
    </ul>
  );
}
