import { useState, type ReactNode } from "react";
import { Bot, ExternalLink, Plug, Slash, Sparkles, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Mod } from "@godmode/shared";
import { CodeBlock } from "@/components/aicss/CodeBlock";
import { Button } from "@/components/ui/button";
import { intlLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import { formatBytes, formatTokens, shortCommit, sortedPaths } from "./mod-parts";

const NAME_CHIP = "inline-flex h-6 max-w-full min-w-0 items-center rounded-md border bg-card px-2 font-mono text-[11.5px] text-foreground/85";
/** Long lists show this many until the human asks for all. */
const FIRST = 24;

function Group({ icon, title, hint, names, prefix = "" }: { icon: ReactNode; title: string; hint: string; names: string[]; prefix?: string }) {
  const { t } = useTranslation("mods");
  const [all, setAll] = useState(false);
  if (!names.length) return null;
  const shown = all ? names : names.slice(0, FIRST);
  return (
    <section className="space-y-2.5">
      <div className="flex items-baseline gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
          {icon} {title}
        </h3>
        <span className="rounded-[4px] border bg-card px-1 font-mono text-[10px] leading-4 text-muted-foreground tabular-nums">{names.length}</span>
        <p className="min-w-0 truncate text-xs text-muted-foreground">{hint}</p>
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {shown.map((name) => (
          <li key={name} className={NAME_CHIP}>
            <span className="truncate">
              {prefix}
              {name}
            </span>
          </li>
        ))}
        {names.length > FIRST && (
          <li>
            <button
              type="button"
              onClick={() => setAll((v) => !v)}
              className="h-6 rounded-md px-2 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {all ? t("contents.showFewer") : t("contents.showAll", { n: names.length })}
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}

/** The Contents tab of a plugin from a repository: what it brings, and its manifest and hooks to read. */
export function PluginContents({ mod }: { mod: Mod }) {
  const { t } = useTranslation("mods");
  const source = mod.source!;
  const c = mod.contents;
  const paths = sortedPaths(mod.files);
  const [picked, setPicked] = useState<string | null>(null);
  const path = picked && picked in mod.files ? picked : (paths[0] ?? null);
  const browse = source.web?.startsWith("https://github.com/") ? `${source.web}/tree/${source.commit}${source.path ? `/${source.path}` : ""}` : null;

  return (
    <div className="space-y-7 overflow-y-auto p-5">
      {c ? (
        <>
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border @2xl:grid-cols-4">
            {[
              [t("contents.version"), source.version ?? "—"],
              [t("contents.commit"), shortCommit(source.commit)],
              [t("contents.files"), `${c.files.toLocaleString(intlLocale())} · ${formatBytes(c.bytes)}`],
              [t("contents.everySession"), c.alwaysOnTokens != null ? formatTokens(c.alwaysOnTokens) : "—"],
            ].map(([label, value]) => (
              <div key={label} className="bg-card px-3.5 py-2.5">
                <dt className="eyebrow text-[10.5px]">{label}</dt>
                <dd className="mt-0.5 truncate font-mono text-[13px] text-foreground tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>

          <Group icon={<Sparkles />} title={t("contents.skills")} hint={t("contents.skillsHint")} names={c.skills} />
          <Group icon={<Bot />} title={t("contents.subagents")} hint={t("contents.subagentsHint")} names={c.agents} />
          <Group icon={<Slash />} title={t("contents.commands")} hint={t("contents.commandsHint")} names={c.commands} prefix="/" />
          <Group icon={<Zap />} title={t("contents.hooks")} hint={t("contents.hooksHint")} names={c.hooks} />
          <Group icon={<Plug />} title={t("contents.mcpServers")} hint={t("contents.mcpServersHint")} names={c.mcpServers} />
          {!c.skills.length && !c.agents.length && !c.commands.length && !c.hooks.length && !c.mcpServers.length && (
            <p className="rounded-lg border border-dashed px-3.5 py-3 text-xs text-muted-foreground">{t("contents.nothingFound")}</p>
          )}
        </>
      ) : (
        <p className="rounded-lg border border-dashed px-3.5 py-3 text-xs text-muted-foreground">{t("contents.unknown")}</p>
      )}

      {path && (
        <section className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">{t("contents.manifestAndHooks")}</h3>
            {browse && (
              <Button variant="ghost" size="xs" asChild className="text-muted-foreground">
                <a href={browse} target="_blank" rel="noreferrer">
                  <ExternalLink /> {t("contents.browseGitHub")}
                </a>
              </Button>
            )}
          </div>
          {paths.length > 1 && (
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label={t("contents.files")}>
              {paths.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="tab"
                  aria-selected={p === path}
                  onClick={() => setPicked(p)}
                  className={cn(
                    "h-6 rounded-md border px-2 font-mono text-[11px] transition outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    p === path ? "border-foreground/25 bg-paper-2 text-foreground" : "bg-card text-muted-foreground hover:border-foreground/20 hover:text-foreground",
                  )}
                >
                  {p}
                </button>
              ))}
            </div>
          )}
          <CodeBlock lang={path} code={prettyJson(mod.files[path] ?? "")} />
        </section>
      )}
    </div>
  );
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text.replace(/\n$/, "");
  }
}
