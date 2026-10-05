import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { ArrowUpRight, CircleCheck, LayoutGrid, Plus } from "lucide-react";
import { MOD_CATEGORIES, MOD_CATEGORY_LABELS, type Mod, type ModCategory, type ModOption, type ModTemplate } from "@godmode/shared";
import { CodeBlock } from "@/components/aicss/CodeBlock";
import { QueryError } from "@/components/integrations/query-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useModTemplates } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { ModIconTile, hooksModulePath, sortedPaths } from "./mod-parts";
import type { ModActions } from "./use-mod-actions";

const GRID = "grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3";

/** Mods Godmode ships: browse by category, read one through, add it. */
export function ModGallery({ mods, actions, onOpen, onAdded }: { mods: Mod[]; actions: ModActions; onOpen: (mod: Mod) => void; onAdded: (mod: Mod) => void }) {
  const templates = useModTemplates();
  const [category, setCategory] = useState<ModCategory | "">("");
  const [previewId, setPreviewId] = useState<string | null>(null);
  // Kept while the dialog closes, so it doesn't empty mid-animation.
  const [lastPreview, setLastPreview] = useState<ModTemplate | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);

  const all = templates.data ?? [];
  const categories = MOD_CATEGORIES.filter((c) => all.some((t) => t.category === c));
  const visible = category ? all.filter((t) => t.category === category) : all;
  const installed = useMemo(() => new Map(mods.filter((m) => m.templateId).map((m) => [m.templateId!, m])), [mods]);
  const preview = all.find((t) => t.id === previewId) ?? null;
  if (preview && preview !== lastPreview) setLastPreview(preview);
  const shown = preview ?? lastPreview;

  const add = (template: ModTemplate) => {
    if (addingId) return;
    setAddingId(template.id);
    actions.create
      .mutateAsync({ templateId: template.id })
      .then((mod) => {
        setPreviewId(null);
        onAdded(mod);
      })
      .catch(() => undefined)
      .finally(() => setAddingId(null));
  };

  return (
    <section aria-labelledby="mod-gallery-heading" className="space-y-4">
      <div>
        <h2 id="mod-gallery-heading" className="flex items-center gap-2 text-[17px] font-medium tracking-[-0.02em]">
          <LayoutGrid className="size-4 text-muted-foreground" /> Gallery
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Mods made and kept up to date by Godmode. Read the code of any of them before you add it.</p>
      </div>

      {categories.length > 1 && (
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Categories">
          {(["", ...categories] as const).map((c) => {
            const active = category === c;
            return (
              <button
                key={c || "all"}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setCategory(c)}
                className={cn(
                  "relative h-7 shrink-0 rounded-md border px-3 text-xs font-medium whitespace-nowrap transition outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  active ? "border-transparent text-primary-foreground" : "bg-card text-muted-foreground hover:border-foreground/20 hover:text-foreground",
                )}
              >
                {active && <motion.span layoutId="mod-cat" className="absolute -inset-px rounded-md bg-primary" transition={{ type: "spring", stiffness: 400, damping: 32 }} />}
                <span className="relative">{c ? MOD_CATEGORY_LABELS[c] : "All"}</span>
              </button>
            );
          })}
        </div>
      )}

      {templates.isError ? (
        <QueryError error={templates.error} onRetry={() => templates.refetch()} title="Couldn't load the gallery" />
      ) : templates.isLoading ? (
        <div className={GRID}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[188px] rounded-xl" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <p className="rounded-xl border border-dashed bg-card/50 px-4 py-6 text-center text-sm text-muted-foreground">The gallery is empty on this version of Godmode.</p>
      ) : (
        <div className={GRID}>
          {visible.map((t, i) => (
            <TemplateCard
              key={t.id}
              template={t}
              index={i}
              installed={installed.get(t.id)}
              adding={addingId === t.id}
              onPreview={() => setPreviewId(t.id)}
              onAdd={() => add(t)}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}

      <TemplateDialog
        template={shown}
        open={!!preview}
        onOpenChange={(o) => !o && setPreviewId(null)}
        installed={shown ? installed.get(shown.id) : undefined}
        adding={!!addingId}
        onAdd={add}
        onOpen={(mod) => {
          setPreviewId(null);
          onOpen(mod);
        }}
      />
    </section>
  );
}

function TemplateCard({
  template: t,
  index,
  installed,
  adding,
  onPreview,
  onAdd,
  onOpen,
}: {
  template: ModTemplate;
  index: number;
  installed: Mod | undefined;
  adding: boolean;
  onPreview: () => void;
  onAdd: () => void;
  onOpen: (mod: Mod) => void;
}) {
  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index, 12) * 0.03 }}
      className="relative flex flex-col rounded-xl border bg-card p-4 shadow-card transition-[border-color,box-shadow] hover:border-foreground/15 hover:shadow-float"
    >
      <div className="flex items-start gap-3">
        <ModIconTile icon={t.icon} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="min-w-0 text-sm font-medium tracking-[-0.01em]">
              {/* The whole card is this button's hit area; the actions below sit above it. */}
              <button
                type="button"
                onClick={onPreview}
                aria-haspopup="dialog"
                className="block max-w-full truncate text-left outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50"
              >
                {t.title}
              </button>
            </h3>
            {installed && (
              <Badge variant="outline" className="h-5 shrink-0 gap-1 border-brand/25 bg-brand-soft px-1.5 text-[10px] text-brand-strong">
                <CircleCheck /> Added
              </Badge>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{t.description}</p>
        </div>
      </div>

      {t.highlights.length > 0 && (
        <ul className="mt-3 space-y-1 border-t pt-3 text-xs leading-relaxed text-foreground/75">
          {t.highlights.slice(0, 3).map((h) => (
            <li key={h} className="flex gap-2">
              <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-muted-foreground/50" />
              <span className="min-w-0">{h}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 pt-3">
        <Badge variant="secondary" className="h-5 text-[10px] font-normal">
          {MOD_CATEGORY_LABELS[t.category] ?? t.category}
        </Badge>
        {installed ? (
          <Button size="sm" variant="secondary" className="relative shrink-0" onClick={() => onOpen(installed)} aria-label={`Open ${installed.title}`}>
            Open <ArrowUpRight />
          </Button>
        ) : (
          <Button size="sm" variant="secondary" className="relative shrink-0" onClick={onAdd} disabled={adding} aria-label={`Add ${t.title}`}>
            {adding ? <Spinner /> : <Plus />} Add
          </Button>
        )}
      </div>
    </motion.article>
  );
}

function defaultText(o: ModOption): string | null {
  if (o.sensitive) return null;
  if (typeof o.default === "boolean") return o.default ? "On" : "Off";
  if (Array.isArray(o.default)) return o.default.length ? o.default.join("  ·  ") : null;
  if (o.default === null || o.default === "") return null;
  return String(o.default);
}

function TemplateDialog({
  template: t,
  open,
  onOpenChange,
  installed,
  adding,
  onAdd,
  onOpen,
}: {
  template: ModTemplate | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  installed: Mod | undefined;
  adding: boolean;
  onAdd: (template: ModTemplate) => void;
  onOpen: (mod: Mod) => void;
}) {
  const [picked, setPicked] = useState<{ template: string; path: string } | null>(null);
  if (!t) return null;
  const paths = sortedPaths(t.files);
  const path = picked?.template === t.id && picked.path in t.files ? picked.path : hooksModulePath(t.files);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(46rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-2xl">
        <DialogHeader className="flex-row items-start gap-3.5 border-b bg-paper-2 px-6 pt-6 pr-12 pb-5 text-left">
          <ModIconTile icon={t.icon} raised />
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <DialogTitle className="leading-snug">{t.title}</DialogTitle>
              <Badge variant="secondary" className="h-5 text-[10px] font-normal">
                {MOD_CATEGORY_LABELS[t.category] ?? t.category}
              </Badge>
            </div>
            <DialogDescription>{t.description}</DialogDescription>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
          {t.highlights.length > 0 && (
            <section className="space-y-2">
              <h3 className="eyebrow">What it does</h3>
              <ul className="space-y-1.5 text-[13px] leading-relaxed">
                {t.highlights.map((h) => (
                  <li key={h} className="flex gap-2.5">
                    <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/60" />
                    <span className="min-w-0">{h}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {t.options.length > 0 && (
            <section className="space-y-2">
              <h3 className="eyebrow">Options</h3>
              <dl className="divide-y rounded-lg border bg-card">
                {t.options.map((o) => {
                  const fallback = defaultText(o);
                  return (
                    <div key={o.key} className="px-3.5 py-3">
                      <dt className="flex flex-wrap items-baseline gap-x-2 text-[13px] font-medium">
                        {o.title}
                        <span className="font-mono text-[11px] font-normal text-muted-foreground">{o.key}</span>
                      </dt>
                      <dd className="mt-0.5 space-y-1 text-xs leading-relaxed text-muted-foreground">
                        {o.description && <p>{o.description}</p>}
                        <p>
                          {o.sensitive ? (
                            "A secret you enter after adding the mod."
                          ) : fallback ? (
                            <>
                              Default <span className="font-mono text-[11.5px] break-all text-foreground/85">{fallback}</span>
                            </>
                          ) : (
                            "No default."
                          )}
                        </p>
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </section>
          )}

          {path && (
            <section className="space-y-2">
              <h3 className="eyebrow">Code</h3>
              {paths.length > 1 && (
                <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Files">
                  {paths.map((p) => (
                    <button
                      key={p}
                      type="button"
                      role="tab"
                      aria-selected={p === path}
                      onClick={() => setPicked({ template: t.id, path: p })}
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
              <CodeBlock lang={path} code={t.files[path].replace(/\n$/, "")} />
            </section>
          )}
        </div>

        <DialogFooter className="items-center border-t bg-paper-2 px-6 py-4 sm:justify-between">
          <p className="text-xs text-muted-foreground">{installed ? "You already added this mod." : "You set its options and who it runs for after adding it."}</p>
          {installed ? (
            <Button onClick={() => onOpen(installed)}>
              Open <ArrowUpRight />
            </Button>
          ) : (
            <Button onClick={() => onAdd(t)} disabled={adding}>
              {adding ? <Spinner /> : <Plus />} Add mod
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
