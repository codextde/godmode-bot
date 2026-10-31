import {
  Bell,
  Bot,
  EyeOff,
  FileLock,
  Filter,
  Gauge,
  GitBranch,
  Layers,
  Puzzle,
  ScrollText,
  Shield,
  Sparkles,
  Terminal,
  Timer,
  TriangleAlert,
  Video,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  MOD_HOOKS_PATH,
  MOD_MANIFEST_PATH,
  modAbilities,
  modHookLabel,
  type Agent,
  type Mod,
  type ModAbility,
  type ModCheck,
  type ModContents,
  type ModHook,
  type ModIcon,
  type ModProblem,
  type ModState,
} from "@godmode/shared";
import { LiveDot } from "@/components/aicss/Motion";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { intlLocale, t } from "@/i18n";
import { cn } from "@/lib/utils";

export const MOD_TABS = ["overview", "options", "code", "contents"] as const;
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
  video: Video,
  layers: Layers,
  sparkles: Sparkles,
  bot: Bot,
};

export const MOD_ICON_LABEL = {
  puzzle: "icons.puzzle",
  shield: "icons.shield",
  "file-lock": "icons.fileLock",
  terminal: "icons.terminal",
  "eye-off": "icons.eyeOff",
  gauge: "icons.gauge",
  timer: "icons.timer",
  "git-branch": "icons.gitBranch",
  scroll: "icons.scroll",
  bell: "icons.bell",
  filter: "icons.filter",
  wand: "icons.wand",
  video: "icons.video",
  layers: "icons.layers",
  sparkles: "icons.sparkles",
  bot: "icons.bot",
} as const satisfies Record<ModIcon, string>;

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

export const MOD_STATE_LABEL = {
  on: "state.on",
  off: "state.off",
  review: "state.review",
  broken: "state.broken",
} as const satisfies Record<ModState, string>;

const STATE_BADGE: Record<ModState, string> = {
  on: "border-brand/25 bg-brand-soft text-brand-strong",
  off: "border-border bg-secondary text-muted-foreground",
  review: "border-warning/30 bg-warning/[0.07] text-warning",
  broken: "border-destructive/25 bg-destructive/[0.06] text-destructive",
};

export function ModStateBadge({ state, className }: { state: ModState; className?: string }) {
  const { t } = useTranslation("mods");
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
      {t(MOD_STATE_LABEL[state])}
    </span>
  );
}

/** The agent that drafted the mod ("agent:<id>"), when it still exists. */
export function modAuthor(mod: Pick<Mod, "createdBy">, agents: Agent[]): Agent | undefined {
  const id = mod.createdBy.startsWith("agent:") ? mod.createdBy.slice(6) : null;
  return id ? agents.find((a) => a.id === id) : undefined;
}

export function modOriginLabel(mod: Pick<Mod, "origin" | "createdBy" | "source">, agents: Agent[]): string {
  if (mod.origin === "git") {
    if (mod.createdBy.startsWith("agent:")) {
      const author = modAuthor(mod, agents);
      return author ? t("mods:origin.installedBy", { name: author.name }) : t("mods:origin.installedByAgent");
    }
    return mod.source?.web?.startsWith("https://github.com/") ? t("mods:origin.installedFromGitHub") : t("mods:origin.installedFromRepo");
  }
  if (mod.origin === "template") return t("mods:origin.template");
  if (mod.origin === "import") return t("mods:origin.imported");
  if (mod.origin === "agent") {
    const author = modAuthor(mod, agents);
    return author ? t("mods:origin.draftedBy", { name: author.name }) : t("mods:origin.draftedByAgent");
  }
  return t("mods:origin.yours");
}

/** A hook's event in words, in the app language. */
export function hookLabel(hook: ModHook): string {
  if (hook.event === "tool.call") {
    const tool = hook.matcher ? /(?:^|,\s*)tool=([^,]+)/.exec(hook.matcher)?.[1] : null;
    if (tool) return t("mods:hook.toolCalls", { tool });
  }
  return t(`mods:hook.${hook.event.replace(/\./g, "_")}` as never, { defaultValue: modHookLabel(hook) });
}

/** What a mod hooks into, in words, each named once. */
export function hookLabels(hooks: ModHook[]): string[] {
  return [...new Set(hooks.map(hookLabel))];
}

/** What a checked mod can do, in the app language. */
export function abilitiesOf(check: Pick<ModCheck, "hooks" | "calls" | "startsPrograms">): ModAbility[] {
  return modAbilities(check).map((a) => {
    const key = a.id.replace(/-/g, "_");
    return { ...a, label: t(`mods:ability.${key}.label` as never, { defaultValue: a.label }), detail: t(`mods:ability.${key}.detail` as never, { defaultValue: a.detail }) };
  });
}

export function sensitiveAbilities(check: ModCheck | null): ModAbility[] {
  return check ? abilitiesOf(check).filter((a) => a.level === "sensitive") : [];
}

export const CHIP = "inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded-[5px] border px-1.5 text-[11px] whitespace-nowrap";

export function HookChips({ hooks, max = 4 }: { hooks: ModHook[]; max?: number }) {
  const { t } = useTranslation("mods");
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
              aria-label={t("hookChips.more", { n: rest.length, list: rest.join(", ") })}
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
  const { t } = useTranslation("mods");
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
              <span className="sr-only">{tone === "error" ? t("problems.errorIn") : t("problems.warningIn")}</span>
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

/** GitHub's mark (lucide has no brand icons). */
export function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

/** "~4.3k tokens", "~130 tokens". */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return t("mods:format.tokens", { value: tokens.toLocaleString(intlLocale()) });
  const digits = tokens >= 10_000 ? 0 : 1;
  return t("mods:format.tokensK", { value: (tokens / 1000).toLocaleString(intlLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }) });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024).toLocaleString(intlLocale())} KB`;
  const digits = bytes < 10 * 1024 ** 2 ? 1 : 0;
  return `${(bytes / 1024 ** 2).toLocaleString(intlLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits })} MB`;
}

/** What a plugin from a repository brings, in words: "47 skills", "19 subagents", … */
export function contentsSummary(contents: ModContents | null): string[] {
  if (!contents) return [];
  return [
    contents.skills.length ? t("mods:summary.skills", { count: contents.skills.length }) : null,
    contents.agents.length ? t("mods:summary.subagents", { count: contents.agents.length }) : null,
    contents.commands.length ? t("mods:summary.commands", { count: contents.commands.length }) : null,
    contents.hooks.length ? t("mods:summary.hooks", { count: contents.hooks.length }) : null,
    contents.mcpServers.length ? t("mods:summary.mcpServers", { count: contents.mcpServers.length }) : null,
  ].filter((x): x is string => !!x);
}

/** What a plugin from a repository can do, told from what it brings — like an app's permissions. */
export function contentsAbilities(contents: ModContents | null): ModAbility[] {
  if (!contents) return [];
  const out: ModAbility[] = [];
  if (contents.skills.length) out.push({ id: "skills", label: t("mods:abilities.skills", { count: contents.skills.length }), detail: t("mods:abilities.skillsDetail"), level: "normal" });
  if (contents.agents.length) out.push({ id: "agents", label: t("mods:abilities.subagents", { count: contents.agents.length }), detail: t("mods:abilities.subagentsDetail"), level: "normal" });
  if (contents.commands.length) out.push({ id: "commands", label: t("mods:abilities.commands", { count: contents.commands.length }), detail: t("mods:abilities.commandsDetail"), level: "normal" });
  if (contents.hooks.length) {
    const events = contents.hooks.slice(0, 4).join(", ");
    out.push({
      id: "hooks",
      label: t("mods:abilities.hooks", { count: contents.hooks.length }),
      detail: contents.hooks.length > 4 ? t("mods:abilities.hooksDetailMore", { events }) : t("mods:abilities.hooksDetail", { events }),
      level: "sensitive",
    });
  }
  if (contents.mcpServers.length) {
    out.push({ id: "mcp", label: t("mods:abilities.mcpServers", { count: contents.mcpServers.length }), detail: t("mods:abilities.mcpServersDetail"), level: "sensitive" });
  }
  return out;
}
