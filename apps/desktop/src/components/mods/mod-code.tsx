import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, FileCode2, FileJson2, FileText, Pencil, Plus, Save, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { MAX_MOD_BYTES, MAX_MOD_FILE_BYTES, MAX_MOD_FILES, MOD_HOOKS_PATH, MOD_MANIFEST_PATH, modPathProblem, type Mod, type ModCheck } from "@godmode/shared";
import { CopyButton } from "@/components/chat/copy-button";
import { ConfirmDialog } from "@/components/integrations/confirm-dialog";
import { Callout } from "@/components/settings/settings-kit";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { modKey } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { CodeEditor } from "./code-editor";
import { languageLabel, languageOf } from "./highlight";
import { HookChips, ModProblems, sortedPaths } from "./mod-parts";
import type { ModActions } from "./use-mod-actions";

type Files = Record<string, string>;

function sameFiles(a: Files, b: Files): boolean {
  if (a === b) return true;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/**
 * The working copy of a mod's files. It follows the saved files while nothing is edited (an agent or another window
 * may change them) and keeps the human's edits once there are some.
 */
export function useModDraft(mod: Mod) {
  const [base, setBase] = useState(mod.files);
  const [files, setFiles] = useState(mod.files);
  const [revision, setRevision] = useState(0);
  const isDirty = useMemo(() => !sameFiles(files, base), [files, base]);

  useEffect(() => {
    if (base === mod.files || isDirty) return;
    setBase(mod.files);
    setFiles(mod.files);
  }, [mod.files, base, isDirty]);

  const dirtyPaths = useMemo(() => new Set(Object.keys(files).filter((p) => files[p] !== base[p])), [files, base]);
  const edit = (next: (files: Files) => Files) => {
    setFiles(next);
    setRevision((r) => r + 1);
  };

  return {
    files,
    isDirty,
    dirtyPaths,
    /** Counts edits, so a check result knows whether the code changed since. */
    revision,
    /** The saved files changed elsewhere while this copy was being edited. */
    stale: isDirty && !sameFiles(base, mod.files),
    write: (path: string, content: string) => edit((f) => ({ ...f, [path]: content })),
    rename: (from: string, to: string) => edit((f) => Object.fromEntries(Object.entries(f).map(([p, c]) => [p === from ? to : p, c]))),
    remove: (path: string) => edit((f) => Object.fromEntries(Object.entries(f).filter(([p]) => p !== path))),
    adopt: (next: Files) => {
      setBase(next);
      setFiles(next);
    },
  };
}

export type ModDraft = ReturnType<typeof useModDraft>;

const FIXED = new Set([MOD_MANIFEST_PATH, MOD_HOOKS_PATH]);

function tooLarge(files: Files): string | null {
  const encoder = new TextEncoder();
  let total = 0;
  for (const [path, content] of Object.entries(files)) {
    const bytes = encoder.encode(content).length;
    if (bytes > MAX_MOD_FILE_BYTES) return `${path} is larger than ${MAX_MOD_FILE_BYTES / 1000} kB.`;
    total += bytes;
  }
  return total > MAX_MOD_BYTES ? `Together the files are larger than ${MAX_MOD_BYTES / 1000} kB.` : null;
}

/** The Code tab: the mod's files on the left, an editor on the right, and what Claude Code's validator says below. */
export function ModCode({
  mod,
  draft,
  actions,
  author,
  activePath,
  jump,
  onOpenFile,
}: {
  mod: Mod;
  draft: ModDraft;
  actions: ModActions;
  /** The agent that drafted the code, while the mod waits for review. */
  author: string;
  activePath: string | null;
  jump: { line: number } | null;
  onOpenFile: (path: string, line?: number | null) => void;
}) {
  const qc = useQueryClient();
  const [result, setResult] = useState<{ check: ModCheck | null; revision: number } | null>(null);
  const paths = useMemo(() => sortedPaths(draft.files), [draft.files]);
  const path = activePath !== null && activePath in draft.files ? activePath : (paths[0] ?? null);

  const check = useMutation({
    mutationFn: ({ files }: { files: Files; revision: number }) => api.mods.checkFiles({ files }),
    onSuccess: (res, { revision }) => setResult({ check: res.check, revision }),
    onError: (e) => toastApiError(e, "Couldn't check the code", qc),
  });

  const save = useMutation({
    mutationFn: (files: Files) => api.mods.update(mod.id, { files }),
    onSuccess: (next) => {
      draft.adopt(next.files);
      actions.put(next);
      setResult(null);
      if (!next.check) toast.success("Code saved", { description: "It wasn't checked — Claude Code isn't installed on this computer." });
      else if (next.check.ok) toast.success("Code saved", { description: "The check passed. It applies from the next message." });
      else toast.warning("Code saved, but the check failed", { description: "Runs don't load the mod until it passes." });
    },
    onError: (e) => toastApiError(e, "Couldn't save the code", qc),
  });

  const busy = check.isPending || save.isPending;
  const guard = (): boolean => {
    const problem = tooLarge(draft.files);
    if (problem) toast.error("Too large for a mod", { description: problem });
    return !problem;
  };
  const runCheck = () => {
    if (!busy && guard()) check.mutate({ files: draft.files, revision: draft.revision });
  };
  const runSave = () => {
    if (!busy && draft.isDirty && guard()) save.mutate(draft.files);
  };

  const shown = result ? result.check : mod.check;
  const note = result
    ? result.revision !== draft.revision
      ? "Checked before your last edit"
      : draft.isDirty
        ? "This draft, not saved yet"
        : "The saved code"
    : draft.isDirty
      ? "The saved code — your changes aren't checked yet"
      : "The saved code";

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        // The editor answers the shortcut itself; this catches it from the file list and the buttons.
        if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "s") return;
        e.preventDefault();
        runSave();
      }}
    >
      {(mod.needsReview || draft.stale) && (
        <div className="shrink-0 space-y-2 border-b p-3">
          {mod.needsReview && (
            <Callout tone="warning" title={`${author} wrote this code`}>
              Read it through before anything else. Switching the mod on is your approval: from then on it runs in every turn of the agents it is for.
            </Callout>
          )}
          {draft.stale && (
            <Callout title="The saved code changed while you were editing">
              <p>Saving replaces it with what you have here.</p>
              <Button type="button" size="xs" variant="outline" className="mt-2" onClick={() => draft.adopt(mod.files)}>
                Load the saved code instead
              </Button>
            </Callout>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col @2xl:flex-row">
        <FileList paths={paths} active={path} draft={draft} onOpenFile={onOpenFile} />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {path === null ? (
            <p className="p-5 text-sm text-muted-foreground">This mod has no files yet. Add one to start.</p>
          ) : (
            <>
              <div className="flex h-9 shrink-0 items-center gap-2 border-b pr-1.5 pl-3 text-xs">
                <span className="min-w-0 truncate font-mono text-foreground/85" title={path}>
                  {path}
                </span>
                {draft.dirtyPaths.has(path) && <span className="size-1.5 shrink-0 rounded-full bg-foreground/60" role="img" aria-label="Unsaved changes" />}
                <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
                  {languageLabel(path)} · {draft.files[path].split("\n").length} lines
                </span>
                <CopyButton text={draft.files[path]} label="Copy this file" />
              </div>
              <CodeEditor
                key={path}
                label={`Code of ${path}`}
                language={languageOf(path)}
                value={draft.files[path]}
                onChange={(content) => draft.write(path, content)}
                onSave={runSave}
                jump={activePath === path ? jump : null}
              />
            </>
          )}

          <div className="flex shrink-0 flex-wrap items-center gap-2 border-t bg-paper-2/70 px-3 py-2">
            <p className="mr-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
              {draft.isDirty ? (
                <>
                  <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-foreground/60" /> Unsaved changes
                </>
              ) : (
                "No unsaved changes"
              )}
            </p>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="outline" size="sm" disabled={busy} onClick={runCheck}>
                  {check.isPending ? <Spinner /> : <ShieldCheck />} Check
                </Button>
              </TooltipTrigger>
              <TooltipContent>Run Claude Code's validator over this draft, without saving</TooltipContent>
            </Tooltip>
            <Button type="button" size="sm" disabled={!draft.isDirty || busy} onClick={runSave} aria-keyshortcuts="Meta+S Control+S">
              {save.isPending ? <Spinner /> : <Save />} Save
              <kbd className="font-mono text-[10px] tracking-wide opacity-55">{modKey}S</kbd>
            </Button>
          </div>
        </div>
      </div>

      <CheckPanel check={shown} busy={busy} note={note} paths={paths} onOpenFile={onOpenFile} />
    </div>
  );
}

function FileIcon({ path }: { path: string }) {
  const language = languageOf(path);
  const Icon = language === "json" ? FileJson2 : language === "ts" ? FileCode2 : FileText;
  return <Icon className="size-3.5 shrink-0" aria-hidden />;
}

function FileList({
  paths,
  active,
  draft,
  onOpenFile,
}: {
  paths: string[];
  active: string | null;
  draft: ModDraft;
  onOpenFile: (path: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const problem = (path: string, renamed?: string): string | null => {
    if (!path) return "Enter a path, like hooks/helper.ts.";
    const refused = modPathProblem(path);
    if (refused) return refused;
    if (path !== renamed && path in draft.files) return "A file with this path already exists.";
    if (!renamed && paths.length >= MAX_MOD_FILES) return `A mod holds at most ${MAX_MOD_FILES} files.`;
    return null;
  };

  return (
    <aside aria-label="Files" className="flex max-h-44 shrink-0 flex-col border-b bg-paper-2/60 @2xl:max-h-none @2xl:w-60 @2xl:border-r @2xl:border-b-0">
      <div className="flex shrink-0 items-center justify-between py-1.5 pr-1.5 pl-3">
        <h3 className="eyebrow text-[10.5px]">Files</h3>
        <Button type="button" variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground" onClick={() => setAdding(true)}>
          <Plus /> New file
        </Button>
      </div>
      <ul className="min-h-0 flex-1 space-y-px overflow-y-auto px-1.5 pb-2">
        {paths.map((p) => {
          const fixed = FIXED.has(p);
          const slash = p.lastIndexOf("/") + 1;
          if (renaming === p) {
            return (
              <li key={p}>
                <PathInput
                  label={`New path for ${p}`}
                  initial={p}
                  validate={(next) => problem(next, p)}
                  onCancel={() => setRenaming(null)}
                  onSubmit={(next) => {
                    setRenaming(null);
                    if (next === p) return;
                    draft.rename(p, next);
                    if (active === p) onOpenFile(next);
                  }}
                />
              </li>
            );
          }
          return (
            <li key={p} className="group/file relative">
              <button
                type="button"
                aria-current={active === p ? "true" : undefined}
                onClick={() => onOpenFile(p)}
                title={p}
                className={cn(
                  "flex h-7 w-full min-w-0 items-center gap-2 rounded-md pl-2 text-left font-mono text-[12px] transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  fixed ? "pr-6" : "pr-[3.25rem]",
                  active === p ? "bg-card text-foreground shadow-card ring-1 ring-border" : "text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground",
                )}
              >
                <FileIcon path={p} />
                <span className="truncate">
                  <span className="opacity-60">{p.slice(0, slash)}</span>
                  {p.slice(slash)}
                </span>
              </button>
              {draft.dirtyPaths.has(p) && (
                <span
                  role="img"
                  aria-label="Unsaved changes"
                  className={cn(
                    "pointer-events-none absolute top-1/2 right-2.5 size-1.5 -translate-y-1/2 rounded-full bg-foreground/60",
                    !fixed && "group-focus-within/file:hidden group-hover/file:hidden",
                  )}
                />
              )}
              {!fixed && (
                <span className="absolute inset-y-0 right-0.5 flex items-center opacity-0 transition-opacity group-focus-within/file:opacity-100 group-hover/file:opacity-100">
                  <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground" aria-label={`Rename ${p}`} onClick={() => setRenaming(p)}>
                    <Pencil />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-destructive" aria-label={`Delete ${p}`} onClick={() => setDeleting(p)}>
                    <Trash2 />
                  </Button>
                </span>
              )}
            </li>
          );
        })}
        {adding && (
          <li>
            <PathInput
              label="Path of the new file"
              initial=""
              validate={(next) => problem(next)}
              onCancel={() => setAdding(false)}
              onSubmit={(next) => {
                setAdding(false);
                draft.write(next, "");
                onOpenFile(next);
              }}
            />
          </li>
        )}
      </ul>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deleting ?? ""}”?`}
        description="The file leaves the mod when you save."
        confirmLabel="Delete file"
        onConfirm={() => {
          if (deleting) draft.remove(deleting);
          setDeleting(null);
        }}
      />
    </aside>
  );
}

/** An inline path field for a new or renamed file: Enter takes it, Escape or leaving it empty gives up. */
function PathInput({
  label,
  initial,
  validate,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial: string;
  validate: (path: string) => string | null;
  onSubmit: (path: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  // The field goes away once it is taken or given up; a blur that follows must not take it again.
  const settled = useRef(false);
  const cancel = () => {
    settled.current = true;
    onCancel();
  };
  const submit = () => {
    if (settled.current) return;
    const path = value.trim();
    const problem = validate(path);
    if (problem) return setError(problem);
    settled.current = true;
    onSubmit(path);
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        autoFocus
        aria-label={label}
        aria-invalid={!!error}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => e.key === "Escape" && cancel()}
        onBlur={() => {
          if (settled.current) return;
          const path = value.trim();
          if (!path || path === initial) cancel();
          else submit();
        }}
        placeholder="hooks/helper.ts"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        className="h-7 w-full rounded-md border border-input bg-card px-2 font-mono text-[12px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive"
      />
      {error && (
        <p role="alert" className="px-1 pt-1 pb-0.5 text-[11px] leading-snug text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

function CheckPanel({
  check,
  busy,
  note,
  paths,
  onOpenFile,
}: {
  check: ModCheck | null;
  busy: boolean;
  note: string;
  paths: string[];
  onOpenFile: (path: string, line?: number | null) => void;
}) {
  const problems = check ? check.errors.length : 0;
  return (
    <section aria-label="Check result" aria-live="polite" className="max-h-48 shrink-0 overflow-y-auto border-t px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {busy ? (
          <>
            <Spinner className="size-3.5" />
            <span className="text-muted-foreground">Checking with Claude Code…</span>
          </>
        ) : !check ? (
          <>
            <CircleAlert className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-muted-foreground">Not checked yet. The check needs Claude Code on this computer.</span>
          </>
        ) : check.ok ? (
          <>
            <CircleCheck className="size-3.5 shrink-0 text-success" aria-hidden />
            <span className="font-medium">The check passed</span>
          </>
        ) : (
          <>
            <TriangleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden />
            <span className="font-medium text-destructive">
              {problems === 0 ? "The check failed" : problems === 1 ? "1 problem to fix" : `${problems} problems to fix`}
            </span>
          </>
        )}
        {!busy && check && <span className="ml-auto text-[11px] text-muted-foreground">{note}</span>}
      </div>
      {check && !busy && (
        <div className="mt-2 space-y-2">
          {check.ok && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="eyebrow mr-1 text-[10.5px]">Hooks into</span>
              {check.hooks.length ? <HookChips hooks={check.hooks} max={12} /> : <span className="text-xs text-muted-foreground">Nothing yet</span>}
            </div>
          )}
          <ModProblems problems={check.errors} tone="error" paths={paths} onOpenFile={onOpenFile} />
          <ModProblems problems={check.warnings} tone="warning" paths={paths} onOpenFile={onOpenFile} />
        </div>
      )}
    </section>
  );
}
