import { useEffect, useRef, useState, type ReactNode } from "react";
import { format, formatDistanceToNow } from "date-fns";
import { ArrowUp, Braces, Check, CircleAlert, CircleCheck, FolderTree, GitCommitHorizontal, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { modState, modUpdateAvailable, type Mod, type ModAbility } from "@godmode/shared";
import { Callout } from "@/components/settings/settings-kit";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useLocale } from "@/i18n/language";
import { useAllAgents } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { abilitiesOf, contentsAbilities, hookLabel, ModProblems, modAuthor, modOriginLabel, shortCommit, sortedPaths } from "./mod-parts";
import { RunsForEditor } from "./runs-for";
import type { ModActions } from "./use-mod-actions";

const MAX_DESCRIPTION = 600;

function Block({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** The Overview tab: what the mod is, who runs it, and — like an app's permissions — what it hooks into and can do. */
export function ModOverview({
  mod,
  actions,
  onOpenCode,
  onOpenFile,
  onDelete,
}: {
  mod: Mod;
  actions: ModActions;
  onOpenCode: () => void;
  onOpenFile: (path: string, line?: number | null) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation(["mods", "common"]);
  const { dateLocale } = useLocale();
  const { data: agents = [] } = useAllAgents();
  const state = modState(mod);
  const check = mod.check;
  const checking = actions.checking.has(mod.id);
  const source = mod.source;
  // From a repository: what it brings tells more than the validator's notes, which only cover function hooks.
  const abilities = source ? [...contentsAbilities(mod.contents), ...(check ? abilitiesOf(check).filter((a) => a.id !== "programs") : [])] : check ? abilitiesOf(check) : [];
  const everyday = abilities.filter((a) => a.level === "normal");
  const sensitive = abilities.filter((a) => a.level === "sensitive");
  const paths = sortedPaths(mod.files);
  const checkedAt = check ? new Date(check.checkedAt) : null;
  const author = modAuthor(mod, agents);
  const reviewTitle = source
    ? author
      ? t("overview.installedThis", { name: author.name })
      : t("overview.agentInstalledThis")
    : author
      ? t("overview.draftedThis", { name: author.name })
      : t("overview.agentDraftedThis");

  return (
    <div className="space-y-7 p-5">
      {state === "review" && (
        <Callout tone="warning" title={reviewTitle}>
          <p>{source ? t("overview.staysOffContents") : t("overview.staysOffCode")}</p>
          <Button size="xs" variant="outline" className="mt-2" onClick={onOpenCode}>
            {source ? <FolderTree /> : <Braces />} {source ? t("overview.seeContents") : t("overview.readCode")}
          </Button>
        </Callout>
      )}
      {state === "broken" && (
        <Callout tone="danger" title={t("overview.refusedTitle")}>
          <p>{source ? t("overview.refusedRepo") : t("overview.refusedCode")}</p>
          {!source && (
            <Button size="xs" variant="outline" className="mt-2" onClick={onOpenCode}>
              <Braces /> {t("overview.fixCode")}
            </Button>
          )}
        </Callout>
      )}

      <div className="grid grid-cols-1 gap-x-8 gap-y-7 @3xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="space-y-7">
          <div className="space-y-2">
            <Label htmlFor={`mod-description-${mod.id}`} className="text-sm font-medium">
              {t("common:words.description")}
            </Label>
            <DescriptionField mod={mod} actions={actions} />
          </div>

          {source && <VersionPanel mod={mod} actions={actions} />}

          <Block title={t("runsFor.label")} description={t("overview.runsForDescription")}>
            <RunsForEditor mod={mod} actions={actions} />
            {mod.scope === "agents" && mod.agentIds.length === 0 && <p className="text-xs text-warning/85">{t("overview.noAgentYet")}</p>}
          </Block>

          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 rounded-lg border bg-paper-2/60 px-3 py-2.5">
              {!check ? (
                <CircleAlert className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              ) : check.ok ? (
                <CircleCheck className="size-3.5 shrink-0 text-success" aria-hidden />
              ) : (
                <TriangleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden />
              )}
              <p className="min-w-0 flex-1 basis-40 text-xs leading-relaxed text-muted-foreground">
                {check && checkedAt ? (
                  <>
                    {t("overview.checkedWith")}
                    {check.claudeVersion && <span className="font-mono text-[11.5px] text-foreground/80"> {check.claudeVersion}</span>} ·{" "}
                    <time dateTime={check.checkedAt} title={format(checkedAt, "PPp", { locale: dateLocale })}>
                      {formatDistanceToNow(checkedAt, { addSuffix: true, locale: dateLocale })}
                    </time>
                  </>
                ) : (
                  t("overview.notCheckedNeedsClaude")
                )}
              </p>
              <Button size="xs" variant="outline" disabled={checking} onClick={() => actions.check.mutate({ mod })}>
                {checking ? <Spinner className="size-3" /> : <RefreshCw />} {check ? t("overview.checkAgain") : t("card.checkNow")}
              </Button>
            </div>
            {check && (check.errors.length > 0 || check.warnings.length > 0) && (
              <div className="space-y-2 px-1">
                <ModProblems problems={check.errors} tone="error" paths={paths} onOpenFile={onOpenFile} />
                <ModProblems problems={check.warnings} tone="warning" paths={paths} onOpenFile={onOpenFile} />
              </div>
            )}
          </div>
        </div>

        <div className="space-y-7">
          <Block
            title={t("overview.whatItCanDo")}
            description={source ? t("overview.toldFromContents") : check ? t("overview.toldFromHooks") : undefined}
          >
            {!check && !source ? (
              <Quiet>{t("overview.notCheckedReadCode")}</Quiet>
            ) : abilities.length === 0 ? (
              <Quiet>{source ? t("overview.nothingFound") : t("overview.nothingHooked")}</Quiet>
            ) : (
              <>
                {everyday.length > 0 && <AbilityList abilities={everyday} />}
                {sensitive.length > 0 && (
                  <div className="space-y-2">
                    <p className="eyebrow pt-1 text-[10.5px]">{t("overview.reachesOutside")}</p>
                    <AbilityList abilities={sensitive} sensitive />
                  </div>
                )}
              </>
            )}
          </Block>

          <Block title={t("card.hooksInto")}>
            {source ? (
              mod.contents?.hooks.length ? (
                <ul className="divide-y rounded-lg border bg-card">
                  {mod.contents.hooks.map((event) => (
                    <li key={event} className="flex items-baseline justify-between gap-3 px-3.5 py-2">
                      <span className="text-[13px]">{event.replace(/([a-z])([A-Z])/g, "$1 $2")}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">{event}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Quiet>{t("overview.noHooks")}</Quiet>
              )
            ) : !check ? (
              <Quiet>{t("overview.hooksUnknown")}</Quiet>
            ) : check.hooks.length === 0 ? (
              <Quiet>{t("overview.noHooksYet")}</Quiet>
            ) : (
              <ul className="divide-y rounded-lg border bg-card">
                {check.hooks.map((h, i) => (
                  <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3.5 py-2">
                    <span className="text-[13px]">{hookLabel(h)}</span>
                    <span className="flex min-w-0 items-baseline gap-1.5 font-mono text-[11px] text-muted-foreground">
                      <span className="text-foreground/75">{h.event}</span>
                      {h.matcher && <span className="truncate rounded-[4px] border bg-paper-2 px-1">{h.matcher}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Block>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-5">
        <p className="text-xs text-muted-foreground">
          {t("overview.originAdded", { origin: modOriginLabel(mod, agents), date: format(new Date(mod.createdAt), "PP", { locale: dateLocale }) })}
        </p>
        <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={onDelete}>
          <Trash2 /> {source ? t("overview.uninstall") : t("overview.deletePlugin")}
        </Button>
      </div>
    </div>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed px-3.5 py-3 text-xs leading-relaxed text-muted-foreground">{children}</p>;
}

function AbilityList({ abilities, sensitive }: { abilities: ModAbility[]; sensitive?: boolean }) {
  return (
    <ul className={cn("divide-y rounded-lg border", sensitive ? "divide-warning/20 border-warning/30 bg-warning/[0.05]" : "bg-card")}>
      {abilities.map((a) => (
        <li key={a.id} className="flex gap-2.5 px-3.5 py-2.5">
          {sensitive ? <TriangleAlert className="mt-[3px] size-3.5 shrink-0 text-warning" aria-hidden /> : <Check className="mt-[3px] size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
          <div className="min-w-0">
            <p className="text-[13px] leading-snug font-medium">{a.label}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{a.detail}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function DescriptionField({ mod, actions }: { mod: Mod; actions: ModActions }) {
  const { t } = useTranslation("mods");
  const [text, setText] = useState(mod.description);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(mod.description);
  }, [mod.description]);

  return (
    <Textarea
      id={`mod-description-${mod.id}`}
      value={text}
      maxLength={MAX_DESCRIPTION}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        const next = text.trim();
        if (next !== mod.description) actions.update.mutate({ mod, patch: { description: next } });
        setText(next);
      }}
      placeholder={t("overview.descriptionPlaceholder")}
      className="min-h-[4.5rem] text-[13px] leading-relaxed md:text-[13px]"
    />
  );
}

/** Where a plugin from a repository comes from, the version that runs, and whether a newer one waits. */
function VersionPanel({ mod, actions }: { mod: Mod; actions: ModActions }) {
  const { t } = useTranslation("mods");
  const { dateLocale } = useLocale();
  const source = mod.source!;
  const upgrading = actions.upgrading.has(mod.id);
  const looking = actions.checkUpdates.isPending && actions.checkUpdates.variables?.some((m) => m.id === mod.id) !== false;
  const update = modUpdateAvailable(mod);
  const installedAt = source.installedAt ? new Date(source.installedAt) : null;
  const checkedAt = source.checkedAt ? new Date(source.checkedAt) : null;
  const commitUrl = source.web?.startsWith("https://github.com/") ? `${source.web}/commit/${source.commit}` : null;
  const compareUrl = update && source.web?.startsWith("https://github.com/") ? `${source.web}/compare/${source.commit}...${source.latestCommit}` : null;

  return (
    <Block
      title={t("contents.version")}
      description={
        source.ref
          ? source.path
            ? t("version.followsRefFolder", { ref: source.ref, repo: source.repo, path: source.path })
            : t("version.followsRef", { ref: source.ref, repo: source.repo })
          : source.path
            ? t("version.followsDefaultFolder", { repo: source.repo, path: source.path })
            : t("version.followsDefault", { repo: source.repo })
      }
    >
      <div className="divide-y overflow-hidden rounded-lg border bg-card">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5">
          <span className="font-mono text-[15px] font-medium tracking-[-0.01em] tabular-nums">{source.version ?? shortCommit(source.commit)}</span>
          <a
            href={commitUrl ?? undefined}
            target="_blank"
            rel="noreferrer"
            className={cn("inline-flex items-center gap-1 font-mono text-[11.5px] text-muted-foreground", commitUrl && "rounded-sm outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50")}
          >
            <GitCommitHorizontal className="size-3.5" aria-hidden /> {shortCommit(source.commit)}
          </a>
          {installedAt && (
            <span className="ml-auto text-xs text-muted-foreground">
              <Trans
                t={t}
                i18nKey="version.installedAgo"
                values={{ ago: formatDistanceToNow(installedAt, { addSuffix: true, locale: dateLocale }) }}
                components={{ time: <time dateTime={source.installedAt} title={format(installedAt, "PPp", { locale: dateLocale })} /> }}
              />
            </span>
          )}
        </div>
        <div className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-2 px-3.5 py-2.5", update && "bg-brand-soft/50")}>
          {update ? (
            <ArrowUp className="size-3.5 shrink-0 text-brand-strong" aria-hidden />
          ) : source.checkError ? (
            <TriangleAlert className="size-3.5 shrink-0 text-warning" aria-hidden />
          ) : (
            <CircleCheck className="size-3.5 shrink-0 text-success" aria-hidden />
          )}
          <p className="min-w-0 flex-1 basis-44 text-xs leading-relaxed text-muted-foreground">
            {update ? (
              <>
                <span className="font-medium text-foreground">{t("card.updateReady")}</span>
                {source.latestVersion && source.latestVersion !== source.version && <span className="font-mono text-[11.5px] text-foreground/85"> {source.latestVersion}</span>}
                {source.latestCommit && <span className="font-mono text-[11.5px]"> ({shortCommit(source.latestCommit)})</span>}
                {compareUrl && (
                  <>
                    {" · "}
                    <a href={compareUrl} target="_blank" rel="noreferrer" className="rounded-sm underline decoration-foreground/25 underline-offset-[3px] outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
                      {t("version.whatChanged")}
                    </a>
                  </>
                )}
              </>
            ) : source.checkError ? (
              <span className="text-warning">{t("version.checkError", { error: source.checkError })}</span>
            ) : checkedAt ? (
              <Trans
                t={t}
                i18nKey="version.upToDateLooked"
                values={{ ago: formatDistanceToNow(checkedAt, { addSuffix: true, locale: dateLocale }) }}
                components={{ time: <time dateTime={source.checkedAt!} title={format(checkedAt, "PPp", { locale: dateLocale })} /> }}
              />
            ) : (
              t("version.notLookedYet")
            )}
          </p>
          {update ? (
            <Button size="xs" disabled={upgrading} onClick={() => actions.upgrade.mutate(mod)}>
              {upgrading ? <Spinner className="size-3" /> : <ArrowUp />} {upgrading ? t("card.updating") : t("card.update")}
            </Button>
          ) : (
            <Button size="xs" variant="outline" disabled={looking || upgrading} onClick={() => actions.checkUpdates.mutate([mod])}>
              {looking ? <Spinner className="size-3" /> : <RefreshCw />} {t("card.checkUpdates")}
            </Button>
          )}
        </div>
      </div>
    </Block>
  );
}
