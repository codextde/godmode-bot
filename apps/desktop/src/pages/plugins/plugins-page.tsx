import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, FilePlus2, FolderInput, Plus, Puzzle, RefreshCw, WandSparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { modState, modUpdateAvailable, type Mod } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState, PageBody, PageHeader } from "@/components/common";
import { FeaturedPlugins } from "@/components/mods/featured-plugins";
import { ModCard } from "@/components/mods/mod-card";
import { DeleteModDialog, ImportModDialog, InstallPluginDialog, NewModDialog } from "@/components/mods/mod-dialogs";
import { ModGallery } from "@/components/mods/mod-gallery";
import { GitHubMark, isModTab, type ModTab } from "@/components/mods/mod-parts";
import { ModSheet } from "@/components/mods/mod-sheet";
import { useModActions } from "@/components/mods/use-mod-actions";
import { errorMessage } from "@/lib/api";
import { useMods } from "@/lib/hooks";
import { useReduceAnimations } from "@/lib/motion";

const STEPS = [
  { title: "page.steps.install.title", text: "page.steps.install.text" },
  { title: "page.steps.check.title", text: "page.steps.check.text" },
  { title: "page.steps.use.title", text: "page.steps.use.text" },
] as const;

/** Claude Code plugins: install from GitHub or the gallery, switch on and off, update, set options, choose who runs them. */
export default function PluginsPage() {
  const reduce = useReduceAnimations();
  const { t } = useTranslation(["mods", "common"]);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const list = useMods();
  const mods = list.data ?? [];
  const actions = useModActions();
  const [sheet, setSheet] = useState<{ id: string; tab: ModTab } | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const byId = (id: string | null | undefined) => (id ? (mods.find((m) => m.id === id) ?? null) : null);
  const open = (id: string, tab: ModTab = "overview") => setSheet({ id, tab });

  // Deep links from other screens: /plugins?plugin=<id> opens that plugin, &tab=code|contents|options|overview on that tab.
  const wantsMod = params.get("plugin");
  const wantsTab = params.get("tab");
  useEffect(() => {
    if (!wantsMod || !list.data) return;
    if (list.data.some((m) => m.id === wantsMod)) open(wantsMod, isModTab(wantsTab) ? wantsTab : "overview");
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("plugin");
        next.delete("tab");
        return next;
      },
      { replace: true },
    );
  }, [wantsMod, wantsTab, list.data, setParams]);

  // A plugin freshly created is in the cache before the sheet opens; one that is gone closes it.
  const current = byId(sheet?.id);
  useEffect(() => {
    if (sheet && list.data && !current) setSheet(null);
  }, [sheet, list.data, current]);

  const on = mods.filter((m) => modState(m) === "on").length;
  const waiting = mods.filter((m) => ["review", "broken"].includes(modState(m))).length;
  const fromGit = mods.filter((m) => m.source);
  const updates = fromGit.filter(modUpdateAvailable).length;
  const lookingAll = actions.checkUpdates.isPending && !actions.checkUpdates.variables;

  return (
    <div className="relative">
      <PageHeader
        icon={<Puzzle />}
        title={t("page.title")}
        description={t("page.description")}
        actions={
          <>
            <Button variant="outline" onClick={() => navigate(`/?prompt=${encodeURIComponent(t("page.askPrompt"))}`)}>
              <WandSparkles /> {t("page.askGodmode")}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button>
                  <Plus /> {t("page.addPlugin")} <ChevronDown className="-mr-1 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuItem onClick={() => setInstallOpen(true)}>
                  <GitHubMark className="size-4" /> {t("page.installFromGitHub")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setNewOpen(true)}>
                  <FilePlus2 /> {t("page.writeFromScratch")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setImportOpen(true)}>
                  <FolderInput /> {t("page.importFolder")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      <PageBody className="space-y-10">
        <section aria-labelledby="plugins-installed-heading" className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
            <div>
              <h2 id="plugins-installed-heading" className="text-[17px] font-medium tracking-[-0.02em]">
                {t("page.installed")}
              </h2>
              {mods.length > 0 && (
                <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                  {t("page.pluginCount", { count: mods.length })} · {t("page.onCount", { n: on })}
                  {updates > 0 && <span className="text-brand-strong"> · {t("page.updatesReady", { count: updates })}</span>}
                  {waiting > 0 && <span className="text-warning"> · {t("page.needLook", { count: waiting })}</span>}
                </p>
              )}
            </div>
            {fromGit.length > 0 && (
              <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={actions.checkUpdates.isPending} onClick={() => actions.checkUpdates.mutate(undefined)}>
                {lookingAll ? <Spinner /> : <RefreshCw />} {t("page.checkUpdates")}
              </Button>
            )}
          </div>

          {list.isLoading ? (
            <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-56 rounded-xl" />
              ))}
            </div>
          ) : list.isError ? (
            <EmptyState
              icon={<Puzzle />}
              title={t("page.loadError")}
              description={errorMessage(list.error)}
              action={
                <Button variant="outline" onClick={() => list.refetch()}>
                  <RefreshCw /> {t("common:actions.tryAgain")}
                </Button>
              }
            />
          ) : mods.length === 0 ? (
            <motion.ol
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              aria-label={t("page.howItWorks")}
              className="grid grid-cols-1 divide-y rounded-xl border bg-card shadow-card @3xl:grid-cols-3 @3xl:divide-x @3xl:divide-y-0"
            >
              {STEPS.map((step, i) => (
                <li key={step.title} className="flex gap-3 p-4">
                  <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-md border bg-paper-2 font-mono text-[11px] text-muted-foreground tabular-nums">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm leading-6 font-medium tracking-[-0.01em]">{t(step.title)}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t(step.text)}</p>
                  </div>
                </li>
              ))}
            </motion.ol>
          ) : (
            <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
              <AnimatePresence initial={false}>
                {mods.map((mod, i) => (
                  <motion.div
                    key={mod.id}
                    layout="position"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.97 }}
                    transition={reduce ? undefined : { delay: Math.min(i, 8) * 0.03 }}
                    className="flex min-w-0"
                  >
                    <ModCard mod={mod} actions={actions} onOpen={(tab) => open(mod.id, tab)} onDelete={() => setDeleteId(mod.id)} />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </section>

        <FeaturedPlugins mods={mods} actions={actions} onOpen={(mod: Mod) => open(mod.id)} />

        <ModGallery mods={mods} actions={actions} onOpen={(mod: Mod) => open(mod.id)} onAdded={(mod: Mod) => open(mod.id)} />
      </PageBody>

      <ModSheet
        mod={current}
        tab={sheet?.tab ?? "overview"}
        onTabChange={(tab) => setSheet((s) => (s ? { ...s, tab } : s))}
        onClose={() => setSheet(null)}
        onDelete={(mod) => setDeleteId(mod.id)}
        actions={actions}
      />
      <InstallPluginDialog open={installOpen} onOpenChange={setInstallOpen} actions={actions} onInstalled={(mod) => open(mod.id)} />
      <NewModDialog open={newOpen} onOpenChange={setNewOpen} actions={actions} onCreated={(mod) => open(mod.id, "code")} />
      <ImportModDialog open={importOpen} onOpenChange={setImportOpen} actions={actions} onImported={(mod) => open(mod.id)} />
      <DeleteModDialog mod={byId(deleteId)} onClose={() => setDeleteId(null)} actions={actions} />
    </div>
  );
}
