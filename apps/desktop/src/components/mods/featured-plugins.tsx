import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { ArrowUpRight, CircleCheck, Download, ExternalLink, Sparkles, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Mod, ModCatalogEntry } from "@godmode/shared";
import { QueryError } from "@/components/integrations/query-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useModCatalog } from "@/lib/hooks";
import { GitHubMark, ModIconTile } from "./mod-parts";
import type { ModActions } from "./use-mod-actions";
import { useReduceAnimations } from "@/lib/motion";

const GRID = "grid grid-cols-1 gap-4 @3xl:grid-cols-2";

function installedFrom(mods: Mod[], entry: ModCatalogEntry): Mod | undefined {
  const repo = entry.repo.toLowerCase();
  return mods.find((m) => m.source?.repo.toLowerCase() === repo);
}

/** Whole Claude Code plugins Godmode recommends: one click installs them from GitHub. */
export function FeaturedPlugins({ mods, actions, onOpen }: { mods: Mod[]; actions: ModActions; onOpen: (mod: Mod) => void }) {
  const { t } = useTranslation("mods");
  const catalog = useModCatalog();
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [lastPreview, setLastPreview] = useState<ModCatalogEntry | null>(null);
  const [installing, setInstalling] = useState<ReadonlySet<string>>(new Set());
  const entries = catalog.data ?? [];
  const preview = entries.find((e) => e.id === previewId) ?? null;
  if (preview && preview !== lastPreview) setLastPreview(preview);
  const shown = preview ?? lastPreview;
  const installed = useMemo(() => new Map(entries.map((e) => [e.id, installedFrom(mods, e)])), [entries, mods]);

  const install = (entry: ModCatalogEntry) => {
    if (installing.has(entry.id)) return;
    setInstalling((s) => new Set(s).add(entry.id));
    actions.install
      .mutateAsync({ source: entry.repo, catalogId: entry.id, label: entry.title })
      .then((mod) => {
        setPreviewId(null);
        onOpen(mod);
      })
      .catch(() => undefined)
      .finally(() =>
        setInstalling((s) => {
          const next = new Set(s);
          next.delete(entry.id);
          return next;
        }),
      );
  };

  return (
    <section aria-labelledby="plugins-featured-heading" className="space-y-4">
      <div>
        <h2 id="plugins-featured-heading" className="flex items-center gap-2 text-[17px] font-medium tracking-[-0.02em]">
          <Sparkles className="size-4 text-muted-foreground" /> {t("featured.title")}
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("featured.description")}</p>
      </div>

      {catalog.isError ? (
        <QueryError error={catalog.error} onRetry={() => catalog.refetch()} title={t("featured.loadError")} />
      ) : catalog.isLoading ? (
        <div className={GRID}>
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-[232px] rounded-xl" />
          ))}
        </div>
      ) : (
        <div className={GRID}>
          {entries.map((entry, i) => (
            <FeaturedCard
              key={entry.id}
              entry={entry}
              index={i}
              installed={installed.get(entry.id)}
              installing={installing.has(entry.id)}
              onPreview={() => setPreviewId(entry.id)}
              onInstall={() => install(entry)}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}

      <FeaturedDialog
        entry={shown}
        open={!!preview}
        onOpenChange={(o) => !o && setPreviewId(null)}
        installed={shown ? installed.get(shown.id) : undefined}
        installing={!!shown && installing.has(shown.id)}
        onInstall={install}
        onOpen={(mod) => {
          setPreviewId(null);
          onOpen(mod);
        }}
      />
    </section>
  );
}

function RepoLine({ entry }: { entry: ModCatalogEntry }) {
  const { t } = useTranslation("mods");
  return (
    <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <GitHubMark className="size-3 shrink-0" />
      <span className="truncate font-mono text-[11.5px] text-foreground/80">{entry.repo}</span>
      <span aria-hidden className="opacity-50">
        ·
      </span>
      <span className="shrink-0">{t("featured.byAuthor", { author: entry.author })}</span>
    </p>
  );
}

function FeaturedCard({
  entry,
  index,
  installed,
  installing,
  onPreview,
  onInstall,
  onOpen,
}: {
  entry: ModCatalogEntry;
  index: number;
  installed: Mod | undefined;
  installing: boolean;
  onPreview: () => void;
  onInstall: () => void;
  onOpen: (mod: Mod) => void;
}) {
  const reduce = useReduceAnimations();
  const { t } = useTranslation(["mods", "common"]);
  return (
    <motion.article
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index, 8) * 0.04 }}
      className="relative flex flex-col overflow-hidden rounded-xl border bg-card shadow-card transition-[border-color,box-shadow] hover:border-foreground/15 full-motion:hover:shadow-float"
    >
      <div className="flex items-start gap-3.5 p-4 pb-3">
        <ModIconTile icon={entry.icon} raised />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="min-w-0 text-[15px] leading-snug font-medium tracking-[-0.01em]">
              {/* The whole card is this button's hit area; the actions below sit above it. */}
              <button
                type="button"
                onClick={onPreview}
                aria-haspopup="dialog"
                className="block max-w-full truncate text-left outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50"
              >
                {entry.title}
              </button>
            </h3>
            {installed && (
              <Badge variant="outline" className="h-5 shrink-0 gap-1 border-brand/25 bg-brand-soft px-1.5 text-[10px] text-brand-strong">
                <CircleCheck /> {t("page.installed")}
              </Badge>
            )}
          </div>
          <RepoLine entry={entry} />
        </div>
      </div>

      <p className="px-4 text-[13px] leading-relaxed text-muted-foreground">{entry.description}</p>

      <ul className="mx-4 mt-3 space-y-1 border-t pt-3 text-xs leading-relaxed text-foreground/75">
        {entry.highlights.slice(0, 3).map((h) => (
          <li key={h} className="flex gap-2">
            <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-muted-foreground/50" />
            <span className="min-w-0">{h}</span>
          </li>
        ))}
      </ul>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 px-4 pt-4 pb-4">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {entry.requires.length > 0 && <span className="eyebrow mr-0.5 text-[10.5px]">{t("featured.needs")}</span>}
          {entry.requires.map((r) => (
            <span key={r} className="inline-flex h-5 items-center rounded-[5px] border bg-paper-2 px-1.5 text-[11px] whitespace-nowrap text-foreground/80">
              {r}
            </span>
          ))}
        </div>
        {installed ? (
          <Button size="sm" variant="secondary" className="relative shrink-0" onClick={() => onOpen(installed)} aria-label={t("featured.openAria", { title: installed.title })}>
            {t("common:actions.open")} <ArrowUpRight />
          </Button>
        ) : (
          <Button size="sm" className="relative shrink-0" onClick={onInstall} disabled={installing} aria-label={t("featured.installAria", { title: entry.title })}>
            {installing ? <Spinner /> : <Download />} {installing ? t("featured.installing") : t("featured.install")}
          </Button>
        )}
      </div>
    </motion.article>
  );
}

function FeaturedDialog({
  entry,
  open,
  onOpenChange,
  installed,
  installing,
  onInstall,
  onOpen,
}: {
  entry: ModCatalogEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  installed: Mod | undefined;
  installing: boolean;
  onInstall: (entry: ModCatalogEntry) => void;
  onOpen: (mod: Mod) => void;
}) {
  const { t } = useTranslation(["mods", "common"]);
  if (!entry) return null;
  const web = `https://github.com/${entry.repo}`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(44rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-xl">
        <DialogHeader className="flex-row items-start gap-3.5 border-b bg-paper-2 px-6 pt-6 pr-12 pb-5 text-left">
          <ModIconTile icon={entry.icon} raised />
          <div className="min-w-0 space-y-1">
            <DialogTitle className="leading-snug">{entry.title}</DialogTitle>
            <RepoLine entry={entry} />
            <DialogDescription className="pt-1">{entry.description}</DialogDescription>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <section className="space-y-2">
            <h3 className="eyebrow">{t("featured.whatItDoes")}</h3>
            <ul className="space-y-1.5 text-[13px] leading-relaxed">
              {entry.highlights.map((h) => (
                <li key={h} className="flex gap-2.5">
                  <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/60" />
                  <span className="min-w-0">{h}</span>
                </li>
              ))}
            </ul>
          </section>

          {entry.usage && (
            <section className="space-y-2">
              <h3 className="eyebrow">{t("featured.tryInChat")}</h3>
              <p className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2.5 font-mono text-[12.5px] text-foreground/90">
                <Terminal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                {entry.usage}
              </p>
            </section>
          )}

          {entry.requires.length > 0 && (
            <section className="space-y-2">
              <h3 className="eyebrow">{t("featured.needsOnComputer")}</h3>
              <div className="flex flex-wrap gap-1.5">
                {entry.requires.map((r) => (
                  <span key={r} className="inline-flex h-6 items-center rounded-md border bg-card px-2 text-xs text-foreground/85">
                    {r}
                  </span>
                ))}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">{t("featured.missingHint")}</p>
            </section>
          )}

          <p className="rounded-lg border border-warning/30 bg-warning/[0.06] px-3.5 py-3 text-xs leading-relaxed text-foreground/85">
            {entry.license ? t("featured.warningLicense", { license: entry.license }) : t("featured.warning")}
          </p>
        </div>

        <DialogFooter className="items-center border-t bg-paper-2 px-6 py-4 sm:justify-between">
          <Button variant="ghost" size="sm" asChild className="text-muted-foreground">
            <a href={web} target="_blank" rel="noreferrer">
              <ExternalLink /> {t("featured.viewOnGitHub")}
            </a>
          </Button>
          {installed ? (
            <Button onClick={() => onOpen(installed)}>
              {t("common:actions.open")} <ArrowUpRight />
            </Button>
          ) : (
            <Button onClick={() => onInstall(entry)} disabled={installing}>
              {installing ? <Spinner /> : <Download />} {installing ? t("featured.installing") : t("featured.installPlugin")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
