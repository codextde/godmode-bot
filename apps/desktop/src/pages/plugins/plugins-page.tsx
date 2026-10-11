import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, FilePlus2, FolderInput, Plus, Puzzle, RefreshCw, WandSparkles } from "lucide-react";
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

/** The sentence the human finishes in a new chat. */
const ASK_PROMPT = "Write a Claude Code plugin for Godmode that ";

const STEPS = [
  { title: "Install one", text: "Pick a featured plugin, paste any GitHub repository, or add a small one Godmode made." },
  { title: "Godmode checks it with Claude Code", text: "You see what it brings and what it can reach before it runs anywhere." },
  { title: "Your agents use it", text: "Switched on, it loads into each run of the agents you choose. Updates are one click." },
];

/** Claude Code plugins: install from GitHub or the gallery, switch on and off, update, set options, choose who runs them. */
export default function PluginsPage() {
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
        title="Plugins"
        description="Give your agents new skills, subagents, commands and guardrails. These are Claude Code plugins: install them from GitHub, add one Godmode made, or write your own — and switch them off, update or remove them any time."
        actions={
          <>
            <Button variant="outline" onClick={() => navigate(`/?prompt=${encodeURIComponent(ASK_PROMPT)}`)}>
              <WandSparkles /> Ask Godmode to write one
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button>
                  <Plus /> Add plugin <ChevronDown className="-mr-1 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuItem onClick={() => setInstallOpen(true)}>
                  <GitHubMark className="size-4" /> Install from GitHub…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setNewOpen(true)}>
                  <FilePlus2 /> Write one from scratch
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setImportOpen(true)}>
                  <FolderInput /> Import a plugin folder…
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
                Installed
              </h2>
              {mods.length > 0 && (
                <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                  {mods.length === 1 ? "1 plugin" : `${mods.length} plugins`} · {on} on
                  {updates > 0 && <span className="text-brand-strong"> · {updates === 1 ? "1 update ready" : `${updates} updates ready`}</span>}
                  {waiting > 0 && <span className="text-warning"> · {waiting === 1 ? "1 needs a look" : `${waiting} need a look`}</span>}
                </p>
              )}
            </div>
            {fromGit.length > 0 && (
              <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={actions.checkUpdates.isPending} onClick={() => actions.checkUpdates.mutate(undefined)}>
                {lookingAll ? <Spinner /> : <RefreshCw />} Check for updates
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
              title="Couldn't load your plugins"
              description={errorMessage(list.error)}
              action={
                <Button variant="outline" onClick={() => list.refetch()}>
                  <RefreshCw /> Try again
                </Button>
              }
            />
          ) : mods.length === 0 ? (
            <motion.ol
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              aria-label="How plugins work"
              className="grid grid-cols-1 divide-y rounded-xl border bg-card shadow-card @3xl:grid-cols-3 @3xl:divide-x @3xl:divide-y-0"
            >
              {STEPS.map((step, i) => (
                <li key={step.title} className="flex gap-3 p-4">
                  <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-md border bg-paper-2 font-mono text-[11px] text-muted-foreground tabular-nums">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm leading-6 font-medium tracking-[-0.01em]">{step.title}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{step.text}</p>
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
                    transition={{ delay: Math.min(i, 8) * 0.03 }}
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
