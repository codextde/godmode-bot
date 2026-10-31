import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import { AlertTriangle, ChevronRight, Folder, FolderOpen, Lock, Trash2 } from "lucide-react";
import type { AgentFileEntry } from "@godmode/shared";
import { formatBytes } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { t as translate } from "@/i18n";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fileIcon, nameOf, parentOf } from "./file-editor";
import { joinPath, pinsAmong, plural, reservedPlace, useDeleteFiles, useMoveFiles } from "./use-files";

/* ------------------------------------------------------------------ */
/* Delete                                                               */
/* ------------------------------------------------------------------ */

/** Looks at what is about to go first: its size, whether the agent still names it, and what has to stay. */
export function DeleteDialog({
  agentId,
  agentName,
  paths,
  onClose,
  onDeleted,
}: {
  agentId: string;
  agentName: string;
  paths: string[] | null;
  onClose: () => void;
  onDeleted?: (paths: string[]) => void;
}) {
  const { t } = useTranslation(["files", "common"]);
  const open = !!paths?.length;
  const info = useQuery({
    queryKey: ["files", agentId, "inspect", paths],
    queryFn: () => api.agents.inspectFiles(agentId, paths!),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  });
  const remove = useDeleteFiles(agentId, (r) => onDeleted?.(r.deleted.map((d) => d.path)));
  const entries = info.data ?? [];
  const going = entries.filter((e) => !e.locked);
  const staying = entries.filter((e) => e.locked);
  const named = going.filter((e) => e.namedBy.length);
  const bytes = going.reduce((n, e) => n + e.bytes, 0);
  const files = going.reduce((n, e) => n + e.files, 0);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{paths?.length === 1 ? t("dialogs.delete.titleOne", { name: nameOf(paths[0]!) }) : t("dialogs.delete.titleMany", { items: plural(paths?.length ?? 0, "item") })}</DialogTitle>
          <DialogDescription>{t("dialogs.delete.description", { name: agentName })}</DialogDescription>
        </DialogHeader>
        {info.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-9" />
            <Skeleton className="h-9 w-4/5" />
          </div>
        ) : info.isError ? (
          <p className="text-sm text-destructive">{errorMessage(info.error)}</p>
        ) : (
          <div className="space-y-3">
            {going.length > 0 && (
              <div className="rounded-lg border bg-paper-2/60">
                <ul className="max-h-48 divide-y overflow-y-auto">
                  {going.slice(0, 50).map((e) => (
                    <li key={e.path} className="flex items-center gap-2.5 px-3 py-2 text-[13px]">
                      {e.type === "dir" ? <Folder className="size-4 shrink-0 text-muted-foreground" /> : fileIcon(e.path)}
                      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={e.path}>
                        {e.path}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatBytes(e.bytes)}</span>
                    </li>
                  ))}
                </ul>
                <div className="border-t px-3 py-1.5 text-xs text-muted-foreground">
                  {formatBytes(bytes)}
                  {files > going.length && ` · ${plural(files, "file")}`}
                </div>
              </div>
            )}
            {named.length > 0 && (
              <div className="flex gap-2.5 rounded-lg border border-warning/25 bg-warning/[0.07] px-3 py-2.5 text-xs">
                <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" />
                <div className="space-y-1">
                  <p className="font-medium text-foreground">{named.length === 1 ? t("dialogs.delete.stillNamesOne", { name: agentName }) : t("dialogs.delete.stillNamesMany", { name: agentName, n: named.length })}</p>
                  {named.slice(0, 4).map((e) => (
                    <p key={e.path} className="text-muted-foreground">
                      <Trans t={t} i18nKey="dialogs.delete.namedIn" values={{ file: nameOf(e.path), names: e.namedBy.slice(0, 2).join(", ") }} components={{ mono: <span className="font-mono" /> }} />
                    </p>
                  ))}
                  <p className="text-muted-foreground">{named.length === 1 ? t("dialogs.delete.mayNeedOne") : t("dialogs.delete.mayNeedMany")}</p>
                </div>
              </div>
            )}
            {staying.length > 0 && (
              <div className="space-y-1 text-xs text-muted-foreground">
                {staying.map((e) => (
                  <p key={e.path} className="flex items-start gap-1.5">
                    <Lock className="mt-px size-3.5 shrink-0" />
                    <span>
                      <Trans
                        t={t}
                        i18nKey="dialogs.delete.stays"
                        values={{ name: nameOf(e.path) || e.path, reason: e.locked }}
                        components={{ mono: <span className="font-mono text-foreground" /> }}
                      />
                    </span>
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={!going.length || remove.isPending}
            onClick={() =>
              remove.mutate(
                going.map((e) => e.path),
                { onSuccess: onClose },
              )
            }
          >
            {remove.isPending ? <Spinner /> : <Trash2 />} {t("dialogs.delete.moveToBin")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Name: rename, new note, new folder                                   */
/* ------------------------------------------------------------------ */

export type NameDialogMode = { kind: "rename"; path: string } | { kind: "note"; dir: string } | { kind: "folder"; dir: string };

/** The file a new note becomes: "plan" is plan.md. */
function noteFile(name: string) {
  const n = name.trim();
  return /\.(md|markdown|txt)$/i.test(n) ? n : `${n}.md`;
}

function nameProblem(name: string, taken: Set<string>, kind: NameDialogMode["kind"], current?: string): string | null {
  const n = name.trim();
  if (!n) return translate("files:dialogs.name.errors.empty");
  if (n.includes("/") || n.includes("\\")) return translate("files:dialogs.name.errors.slash");
  if (n === "." || n === ".." || n.startsWith(".")) return translate("files:dialogs.name.errors.dot");
  if (n.length > 200) return translate("files:dialogs.name.errors.tooLong");
  const final = kind === "note" ? noteFile(n) : n;
  // A new spelling of its own name (Notes.md → notes.md) is fine.
  if (current && final.toLowerCase() === current.toLowerCase()) return null;
  if (taken.has(final.toLowerCase())) return translate("files:dialogs.name.errors.taken", { name: final });
  return null;
}

export function NameDialog({
  agentId,
  mode,
  siblings,
  onClose,
  onCreated,
  onRenamed,
}: {
  agentId: string;
  mode: NameDialogMode | null;
  /** Names already in the folder, so nothing is overwritten; null while they load. */
  siblings: string[] | null;
  onClose: () => void;
  onCreated?: (path: string, kind: "note" | "folder") => void;
  onRenamed?: (from: string, to: string) => void;
}) {
  const { t } = useTranslation(["files", "common"]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const move = useMoveFiles(agentId, (moves) => moves[0] && onRenamed?.(moves[0].from, moves[0].to));
  const renaming = mode?.kind === "rename" ? mode.path : null;
  const info = useQuery({
    queryKey: ["files", agentId, "inspect", [renaming]],
    queryFn: () => api.agents.inspectFiles(agentId, [renaming!]),
    enabled: !!renaming,
    staleTime: 0,
    gcTime: 0,
  });
  const pins = pinsAmong(info.data?.[0]?.namedBy ?? []);
  const current = mode?.kind === "rename" ? nameOf(mode.path) : undefined;
  const taken = useMemo(() => new Set((siblings ?? []).map((s) => s.toLowerCase())), [siblings]);

  useEffect(() => {
    if (!mode) return;
    setError(null);
    setBusy(false);
    setName(mode.kind === "rename" ? nameOf(mode.path) : mode.kind === "note" ? t("dialogs.name.defaultNote") : t("dialogs.name.defaultFolder"));
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const dot = el.value.lastIndexOf(".");
      el.setSelectionRange(0, mode.kind !== "folder" && dot > 0 ? dot : el.value.length);
    });
  }, [mode]);

  const problem = mode ? nameProblem(name, taken, mode.kind, current) : null;
  const loading = siblings === null;
  const dir = mode ? (mode.kind === "rename" ? parentOf(mode.path) : mode.dir) : "";

  const submit = async () => {
    if (!mode || problem || busy || loading) return;
    const n = name.trim();
    if (mode.kind === "rename") {
      if (n === current) return onClose();
      move.mutate([{ from: mode.path, to: joinPath(dir, n) }], { onSuccess: onClose });
      return;
    }
    setBusy(true);
    try {
      if (mode.kind === "folder") {
        const r = await api.agents.createFolder(agentId, joinPath(dir, n));
        onCreated?.(r.path, "folder");
      } else {
        const file = noteFile(n);
        const path = joinPath(dir, file);
        const title = file.replace(/\.(md|markdown|txt)$/i, "").replace(/[-_]+/g, " ");
        // Create-only: if something took the name meanwhile, the server says so instead of overwriting it.
        await api.agents.writeFile(agentId, path, /\.txt$/i.test(file) ? "" : `# ${title.charAt(0).toUpperCase()}${title.slice(1)}\n\n`, true);
        onCreated?.(path, "note");
      }
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const title = mode?.kind === "rename" ? t("dialogs.name.titleRename", { name: current }) : mode?.kind === "note" ? t("dialogs.name.titleNote") : t("dialogs.name.titleFolder");
  return (
    <Dialog open={!!mode} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            <Trans
              t={t}
              i18nKey={mode?.kind === "rename" ? "dialogs.name.inRename" : "dialogs.name.in"}
              values={{ dir: dir || t("dialogs.name.theRepository") }}
              components={{ mono: <span className="font-mono text-foreground" /> }}
            />
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="space-y-2"
        >
          <Input ref={inputRef} value={name} onChange={(e) => setName(e.target.value)} aria-label={t("common:words.name")} aria-invalid={!!problem && name !== current} className="font-mono text-[13px]" />
          {(error || (problem && name)) && <p className="text-xs text-destructive">{error ?? problem}</p>}
          {pins.length > 0 && (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" />
              <span>{t("dialogs.name.pinned", { names: pins.slice(0, 2).join(", ") })}</span>
            </p>
          )}
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button disabled={!!problem || busy || loading || move.isPending} onClick={() => void submit()}>
            {(busy || move.isPending) && <Spinner />}
            {mode?.kind === "rename" ? t("common:actions.rename") : t("common:actions.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Move                                                                 */
/* ------------------------------------------------------------------ */

function FolderTree({
  agentId,
  dir,
  depth,
  picked,
  onPick,
  blocked,
}: {
  agentId: string;
  dir: string;
  depth: number;
  picked: string;
  onPick: (dir: string) => void;
  /** Folders being moved: nothing goes into them. */
  blocked: Set<string>;
}) {
  const { t } = useTranslation("files");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const q = useQuery({ queryKey: qk.agentFiles(agentId, dir), queryFn: () => api.agents.files(agentId, dir) });
  const dirs = (q.data ?? []).filter((e: AgentFileEntry) => e.type === "dir" && !nameOf(e.path).startsWith("."));
  if (q.isLoading) return <Skeleton className="my-1 h-6 w-3/5" style={{ marginLeft: depth * 14 + 8 }} />;
  if (!dirs.length) return null;
  return (
    <ul className="space-y-px">
      {dirs.map((e) => {
        const isOpen = open.has(e.path);
        const disabled = reservedPlace(e.path) || [...blocked].some((b) => e.path === b || e.path.startsWith(`${b}/`));
        return (
          <li key={e.path}>
            <div className="flex items-center" style={{ paddingLeft: depth * 14 }}>
              <button
                type="button"
                aria-label={isOpen ? t("dialogs.move.fold") : t("dialogs.move.unfold")}
                onClick={() =>
                  setOpen((s) => {
                    const next = new Set(s);
                    if (next.has(e.path)) next.delete(e.path);
                    else next.add(e.path);
                    return next;
                  })
                }
                className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent"
              >
                <ChevronRight className={cn("size-3.5 transition-transform", isOpen && "rotate-90")} />
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onPick(e.path)}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px] transition hover:bg-accent/60 disabled:opacity-40",
                  picked === e.path && "bg-secondary font-medium",
                )}
              >
                {isOpen ? <FolderOpen className="size-4 shrink-0 text-muted-foreground" /> : <Folder className="size-4 shrink-0 text-muted-foreground" />}
                <span className="truncate">{nameOf(e.path)}</span>
              </button>
            </div>
            {isOpen && <FolderTree agentId={agentId} dir={e.path} depth={depth + 1} picked={picked} onPick={onPick} blocked={blocked} />}
          </li>
        );
      })}
    </ul>
  );
}

export function MoveDialog({
  agentId,
  paths,
  onClose,
  onMoved,
}: {
  agentId: string;
  paths: string[] | null;
  onClose: () => void;
  onMoved?: (moves: { from: string; to: string }[]) => void;
}) {
  const { t } = useTranslation(["files", "common"]);
  const [picked, setPicked] = useState("workspace");
  const move = useMoveFiles(agentId, onMoved);
  const info = useQuery({
    queryKey: ["files", agentId, "inspect", paths],
    queryFn: () => api.agents.inspectFiles(agentId, paths!),
    enabled: !!paths?.length,
    staleTime: 0,
    gcTime: 0,
  });
  const pinned = (info.data ?? []).map((e) => ({ path: e.path, pins: pinsAmong(e.namedBy) })).filter((e) => e.pins.length);
  useEffect(() => {
    if (paths?.length) setPicked(parentOf(paths[0]!).startsWith("memory") ? "memory" : "workspace");
  }, [paths]);
  const blocked = useMemo(() => new Set(paths ?? []), [paths]);
  const already = !!paths?.length && paths.every((p) => parentOf(p) === picked);
  const roots = ["workspace", "memory"];

  return (
    <Dialog open={!!paths?.length} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{paths?.length === 1 ? t("dialogs.move.titleOne", { name: nameOf(paths[0]!) }) : t("dialogs.move.titleMany", { items: plural(paths?.length ?? 0, "item") })}</DialogTitle>
          <DialogDescription>{t("dialogs.move.description")}</DialogDescription>
        </DialogHeader>
        <div className="max-h-72 overflow-y-auto rounded-lg border p-1.5">
          {roots.map((root) => (
            <div key={root}>
              <button
                type="button"
                onClick={() => setPicked(root)}
                className={cn("flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] font-medium transition hover:bg-accent/60", picked === root && "bg-secondary")}
              >
                <FolderOpen className="size-4 text-muted-foreground" /> {root}/
              </button>
              <FolderTree agentId={agentId} dir={root} depth={1} picked={picked} onPick={setPicked} blocked={blocked} />
            </div>
          ))}
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground">{t("dialogs.move.to", { dir: picked })}</p>
        {pinned.length > 0 && (
          <div className="flex gap-2.5 rounded-lg border border-warning/25 bg-warning/[0.07] px-3 py-2.5 text-xs">
            <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" />
            <div className="space-y-1">
              <p className="font-medium text-foreground">{t("dialogs.move.notUpdated")}</p>
              {pinned.slice(0, 4).map((e) => (
                <p key={e.path} className="text-muted-foreground">
                  <Trans t={t} i18nKey="dialogs.move.namedIn" values={{ file: nameOf(e.path), names: e.pins.slice(0, 2).join(", ") }} components={{ mono: <span className="font-mono" /> }} />
                </p>
              ))}
              <p className="text-muted-foreground">{t("dialogs.move.changeHint")}</p>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            disabled={already || move.isPending}
            onClick={() =>
              move.mutate(
                (paths ?? []).map((from) => ({ from, to: joinPath(picked, nameOf(from)) })),
                { onSettled: onClose },
              )
            }
          >
            {move.isPending && <Spinner />} {pinned.length ? t("dialogs.move.moveAnyway") : t("dialogs.move.moveHere")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
