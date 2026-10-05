import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ChevronDown, FileKey, FileSpreadsheet, Lock, Search, ShieldCheck, Trash2, TriangleAlert, Upload, X } from "lucide-react";
import type { PasswordImportPreview, PasswordImportResult, PasswordImportRow, PasswordImportSource } from "@godmode/shared";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DrawCheck } from "@/components/aicss/Motion";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";
import { Favicon } from "./favicon";
import { isGrantCancelled, useVaultGrant, withGrant } from "./grant";
import { isVaultLocked, toastApiError } from "./vault-utils";
import { WorkspaceSelect } from "./workspace-select";

type Source = "chrome" | "1password" | "other";
type Filter = "all" | "new" | "update" | "unchanged" | "conflict";

const SOURCE_NAMES: Record<PasswordImportSource, string> = {
  chrome: "Chrome",
  "1password": "1Password",
  bitwarden: "Bitwarden",
  apple: "Apple Passwords",
  firefox: "Firefox",
  lastpass: "LastPass",
  dashlane: "Dashlane",
  protonpass: "Proton Pass",
  keepass: "KeePass",
  csv: "CSV",
};

const GRANT_REASON = "Enter your vault passphrase to compare the export with your saved logins.";
const isExportFile = (f: File) => /\.(csv|1pux|txt)$/i.test(f.name) || f.type === "text/csv";
/** An export can be older than the vault, so replacing a saved password is always an explicit choice. */
const preselected = (r: PasswordImportRow) => r.action !== "unchanged" && !r.conflictKey && !r.replacesPassword;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function PasswordImportDialog({
  open,
  onOpenChange,
  defaultWorkspaceId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultWorkspaceId: string | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-3xl">
        {open && <ImportFlow defaultWorkspaceId={defaultWorkspaceId} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

type Stage =
  | { kind: "pick" }
  | { kind: "review"; file: File; preview: PasswordImportPreview; scope: string | null }
  | { kind: "done"; file: File; result: PasswordImportResult };

function noLoginsMessage(file: File, p: PasswordImportPreview): string {
  if (p.total === 0) return `${file.name} has no entries.`;
  const reasons = new Map<string, number>();
  for (const s of p.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
  const why = [...reasons].map(([reason, n]) => `${reason.toLowerCase()} ×${n}`).join(", ");
  return `No website logins in ${file.name}${why ? ` — ${why}` : ""}.`;
}

function ImportFlow({ defaultWorkspaceId, onClose }: { defaultWorkspaceId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [source, setSource] = useState<Source>("chrome");
  const [workspaceId, setWorkspaceId] = useState<string | null>(defaultWorkspaceId);
  const [step, setStep] = useState<Stage>({ kind: "pick" });
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const ensureGrant = useVaultGrant();

  // Ask for the passphrase before uploading, so a large export is not sent twice.
  const preview = useMutation({
    mutationFn: async ({ file, scope }: { file: File; scope: string | null }) => {
      await ensureGrant(GRANT_REASON);
      const p = await withGrant((grant) => api.credentials.importPreview(file, scope, grant), GRANT_REASON);
      return { file, scope, preview: p };
    },
    onMutate: () => setError(null),
    onSuccess: ({ file, scope, preview: p }) => {
      if (p.rows.length === 0) {
        setError(noLoginsMessage(file, p));
        setStep({ kind: "pick" });
        return;
      }
      setSelected(new Set(p.rows.filter(preselected).map((r) => r.id)));
      setStep({ kind: "review", file, preview: p, scope });
    },
    onError: (e) => {
      if (step.kind === "review") setWorkspaceId(step.scope);
      if (isGrantCancelled(e)) return;
      if (isVaultLocked(e)) toastApiError(e, "Vault locked", qc);
      else setError(errorMessage(e));
    },
  });

  const run = useMutation({
    mutationFn: ({ file, scope, ids }: { file: File; scope: string | null; ids: number[] }) =>
      withGrant((grant) => api.credentials.import(file, scope, ids, grant), GRANT_REASON).then((result) => ({ file, result })),
    onSuccess: ({ file, result }) => {
      setStep({ kind: "done", file, result });
      void qc.invalidateQueries({ queryKey: qk.credentials });
      void qc.invalidateQueries({ queryKey: qk.totp });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
    },
    onError: (e) => !isGrantCancelled(e) && toastApiError(e, "Import failed", qc),
  });

  const readFile = (file: File) => {
    if (preview.isPending) return;
    if (!isExportFile(file)) {
      setError("Choose the .csv or .1pux file your password manager exported.");
      return;
    }
    preview.mutate({ file, scope: workspaceId });
  };

  const changeScope = (next: string | null) => {
    setWorkspaceId(next);
    if (step.kind === "review") preview.mutate({ file: step.file, scope: next });
  };

  const readRef = useRef(readFile);
  readRef.current = readFile;
  useEffect(() => {
    if (step.kind !== "pick") return;
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (file) readRef.current(file);
    };
    // On the document: ahead of the app-wide drop guard on window.
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, [step.kind]);

  const importIds = step.kind === "review" ? step.preview.rows.filter((r) => r.action !== "unchanged" && selected.has(r.id)).map((r) => r.id) : [];

  return (
    <div className="flex max-h-[min(90vh,880px)] flex-col">
      <div className="flex items-start gap-3.5 px-6 pt-6 pb-4">
        <div className="grid size-11 shrink-0 place-items-center rounded-lg border bg-card text-foreground shadow-card">
          <FileKey className="size-5" />
        </div>
        <div className="min-w-0 pr-8">
          <DialogTitle className="text-lg">Import passwords</DialogTitle>
          <DialogDescription className="mt-1">
            {step.kind === "review"
              ? "Pick what to bring over. Logins you already saved are updated, not duplicated."
              : step.kind === "done"
                ? `Finished importing ${step.file.name}.`
                : "Bring your logins over from Chrome, 1Password or another password manager. Nothing is saved until you confirm."}
          </DialogDescription>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-5">
        {step.kind === "done" ? (
          <ResultView result={step.result} fileName={step.file.name} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-paper-2 px-3 py-2.5">
              <Label htmlFor="password-import-scope" className="shrink-0 text-xs text-muted-foreground">
                Save to
              </Label>
              <WorkspaceSelect id="password-import-scope" value={workspaceId} onChange={changeScope} disabled={preview.isPending || run.isPending} className="h-8 w-56 bg-card" />
              <span className="text-[11px] text-muted-foreground">{workspaceId ? "Only agents in this workspace can use them." : "Agents in every workspace can use them."}</span>
            </div>

            {step.kind === "pick" ? (
              <>
                <SourcePicker value={source} onChange={setSource} />
                <SourceGuide source={source} />
                <ExportDropZone busy={preview.isPending} onFile={readFile} />
              </>
            ) : (
              <ReviewView
                file={step.file}
                preview={step.preview}
                selected={selected}
                onSelectedChange={setSelected}
                refreshing={preview.isPending}
                onChangeFile={() => setStep({ kind: "pick" })}
              />
            )}
            {error && (
              <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {error}
              </p>
            )}
          </>
        )}
      </div>

      <div className="flex flex-col-reverse gap-3 border-t bg-paper-2 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="size-3.5 shrink-0 text-brand-strong" /> Passwords go straight into your encrypted vault · the file is never stored
        </p>
        <div className="flex justify-end gap-2">
          {step.kind === "done" ? (
            <Button onClick={onClose}>Done</Button>
          ) : step.kind === "review" ? (
            <>
              <Button variant="ghost" onClick={() => setStep({ kind: "pick" })} disabled={run.isPending}>
                <ArrowLeft /> Back
              </Button>
              <Button onClick={() => run.mutate({ file: step.file, scope: step.scope, ids: importIds })} disabled={importIds.length === 0 || run.isPending || preview.isPending} className="min-w-36">
                {run.isPending && <Spinner />}
                {importIds.length ? `Import ${plural(importIds.length, "login")}` : "Nothing selected"}
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pick                                                                 */
/* ------------------------------------------------------------------ */

function SourcePicker({ value, onChange }: { value: Source; onChange: (s: Source) => void }) {
  const options: { id: Source; label: string; hint: string; mark: ReactNode }[] = [
    { id: "chrome", label: "Chrome", hint: "Edge, Brave & Arc too", mark: <ChromeMark /> },
    { id: "1password", label: "1Password", hint: ".1pux or .csv", mark: <OnePasswordMark /> },
    {
      id: "other",
      label: "Other",
      hint: "Bitwarden, Safari, Firefox…",
      mark: (
        <span className="grid size-7 place-items-center rounded-full bg-secondary text-muted-foreground ring-1 ring-border ring-inset">
          <FileSpreadsheet className="size-3.5" />
        </span>
      ),
    },
  ];
  return (
    <div role="radiogroup" aria-label="Import from" className="grid grid-cols-3 gap-2">
      {options.map((o) => {
        const active = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.id)}
            className={cn(
              "relative flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-[background-color,border-color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              active ? "border-foreground/25 bg-card shadow-card" : "border-transparent bg-paper-2 hover:bg-accent/60",
            )}
          >
            {o.mark}
            <span className="min-w-0">
              <span className="block text-sm font-medium">{o.label}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{o.hint}</span>
            </span>
            {active && <motion.span layoutId="import-source" className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-brand" />}
          </button>
        );
      })}
    </div>
  );
}

function GuideStep({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3 text-sm">
      <span className="grid size-5 shrink-0 place-items-center rounded-[5px] border bg-secondary font-mono text-[11px] font-medium text-foreground tabular-nums">{n}</span>
      <span className="min-w-0 text-foreground/85">{children}</span>
    </li>
  );
}

const B = ({ children }: { children: ReactNode }) => <span className="font-medium text-foreground">{children}</span>;

function SourceGuide({ source }: { source: Source }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={source}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.15 }}
        className="rounded-xl border bg-card shadow-card"
      >
        {source === "chrome" && (
          <>
            <ol className="space-y-2.5 p-3.5">
              <GuideStep n={1}>
                <span className="inline-flex flex-wrap items-center gap-1">
                  Open
                  <span className="inline-flex items-center rounded-md border bg-paper-2 py-px pr-0.5 pl-2 font-mono text-xs">
                    chrome://password-manager/settings
                    <CopyButton value="chrome://password-manager/settings" size="icon-xs" label="Copy address" toastLabel="Address copied — paste it into Chrome" />
                  </span>
                  in Chrome.
                </span>
              </GuideStep>
              <GuideStep n={2}>
                Next to <B>Export passwords</B>, click <B>Download file</B> and confirm with your computer password.
              </GuideStep>
              <GuideStep n={3}>
                Drop <B>Chrome Passwords.csv</B> below.
              </GuideStep>
            </ol>
            <p className="border-t px-3.5 py-2.5 text-xs text-muted-foreground">Edge, Brave, Arc, Opera and Vivaldi export the same file from their password settings.</p>
          </>
        )}
        {source === "1password" && (
          <>
            <ol className="space-y-2.5 p-3.5">
              <GuideStep n={1}>
                In the 1Password desktop app, choose <B>File → Export</B> and pick your account.
              </GuideStep>
              <GuideStep n={2}>
                Enter your account password and choose <B>1PUX</B> — it keeps 2FA codes and tags. <B>CSV</B> works too.
              </GuideStep>
              <GuideStep n={3}>Drop the exported file below.</GuideStep>
            </ol>
            <p className="border-t px-3.5 py-2.5 text-xs text-muted-foreground">Archived items, credit cards and notes are left out. 2FA codes are saved and linked to their login.</p>
          </>
        )}
        {source === "other" && (
          <>
            <dl className="grid gap-x-6 gap-y-2 p-3.5 text-sm sm:grid-cols-2">
              {[
                ["Bitwarden", "Tools → Export vault → .csv"],
                ["Apple Passwords", "File → Export All Passwords"],
                ["Firefox", "about:logins → ⋯ → Export Logins"],
                ["LastPass · Dashlane", "Advanced → Export → CSV"],
                ["Proton Pass", "Settings → Export → CSV"],
                ["KeePassXC", "Database → Export → CSV"],
              ].map(([name, where]) => (
                <div key={name} className="min-w-0">
                  <dt className="font-medium">{name}</dt>
                  <dd className="truncate text-xs text-muted-foreground">{where}</dd>
                </div>
              ))}
            </dl>
            <p className="border-t px-3.5 py-2.5 text-xs text-muted-foreground">Any CSV with a url and a password column works — the columns are detected automatically.</p>
          </>
        )}
      </motion.div>
    </AnimatePresence>
  );
}

function ExportDropZone({ busy, onFile }: { busy: boolean; onFile: (file: File) => void }) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Choose a password export"
      aria-busy={busy}
      onClick={() => !busy && input.current?.click()}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !busy) {
          e.preventDefault();
          input.current?.click();
        }
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        depth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        depth.current = 0;
        setDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file && !busy) onFile(file);
      }}
      className={cn(
        "group flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-8 text-center transition-colors outline-none",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        dragging ? "border-foreground/40 bg-accent" : "border-foreground/15 bg-paper-2 hover:border-foreground/25 hover:bg-accent/50",
        busy && "cursor-progress",
      )}
    >
      <motion.div animate={dragging ? { y: -2 } : { y: 0 }} className="grid size-11 place-items-center rounded-lg border bg-card shadow-card">
        {busy ? <Spinner className="size-5" /> : <Upload className="size-5" />}
      </motion.div>
      <div>
        <p className="text-sm font-medium">{busy ? "Reading your export…" : dragging ? "Drop to read the file" : "Drop your export here"}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          .csv or .1pux · or <span className="font-medium text-foreground underline-offset-2 group-hover:underline">browse files</span> · you'll review everything first
        </p>
      </div>
      <input
        ref={input}
        type="file"
        accept=".csv,.1pux,text/csv"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) onFile(file);
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Review                                                               */
/* ------------------------------------------------------------------ */

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "new", label: "New" },
  { id: "update", label: "Updates" },
  { id: "unchanged", label: "In vault" },
  { id: "conflict", label: "Pick one" },
];

const needsChoice = (r: PasswordImportRow) => !!r.conflictKey && r.action !== "unchanged";

function ReviewView({
  file,
  preview,
  selected,
  onSelectedChange,
  refreshing,
  onChangeFile,
}: {
  file: File;
  preview: PasswordImportPreview;
  selected: Set<number>;
  onSelectedChange: (next: Set<number>) => void;
  refreshing: boolean;
  onChangeFile: () => void;
}) {
  const [chosenFilter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, new: 0, update: 0, unchanged: 0, conflict: 0 };
    for (const r of preview.rows) {
      c.all++;
      c[r.action]++;
      if (needsChoice(r)) c.conflict++;
    }
    return c;
  }, [preview.rows]);
  const filter = chosenFilter === "conflict" && counts.conflict === 0 ? "all" : chosenFilter;
  const heldBack = preview.rows.filter((r) => r.replacesPassword && !r.conflictKey && !selected.has(r.id)).length;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return preview.rows.filter(
      (r) =>
        (filter === "all" || (filter === "conflict" ? needsChoice(r) : r.action === filter)) &&
        (!q || [r.name, r.username, r.existingName ?? "", ...r.domains].join(" ").toLowerCase().includes(q)),
    );
  }, [preview.rows, filter, query]);

  const bulk = visible.filter((r) => r.action !== "unchanged" && !r.conflictKey);
  const bulkSelected = bulk.filter((r) => selected.has(r.id)).length;

  const toggle = (row: PasswordImportRow, on: boolean) => {
    const next = new Set(selected);
    if (on && row.conflictKey) for (const r of preview.rows) if (r.conflictKey === row.conflictKey) next.delete(r.id);
    if (on) next.add(row.id);
    else next.delete(row.id);
    onSelectedChange(next);
  };

  const toggleBulk = (on: boolean) => {
    const next = new Set(selected);
    for (const r of bulk) if (on) next.add(r.id);
    else next.delete(r.id);
    onSelectedChange(next);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5 shadow-card">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand-strong">
          <FileSpreadsheet className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{file.name}</p>
          <p className="text-xs text-muted-foreground">
            {SOURCE_NAMES[preview.source]} export · {plural(preview.total, "entry", "entries")} · {plural(preview.rows.length, "login")}
          </p>
        </div>
        {refreshing ? (
          <Spinner className="size-4 text-muted-foreground" />
        ) : (
          <Button variant="ghost" size="sm" onClick={onChangeFile}>
            Change file
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Filter logins" className="flex rounded-lg bg-muted p-0.5">
          {FILTERS.filter((f) => f.id !== "conflict" || counts.conflict > 0).map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                filter === f.id ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                f.id === "conflict" && filter !== f.id && "text-warning",
              )}
            >
              {f.label}
              <span className="tabular-nums opacity-60">{counts[f.id].toLocaleString()}</span>
            </button>
          ))}
        </div>
        <InputGroup className="ml-auto h-8 w-full max-w-60 min-w-44 sm:w-auto">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search site or username…" aria-label="Search the export" />
          {query && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setQuery("")}>
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
      </div>

      {counts.conflict > 0 && filter !== "conflict" && (
        <Callout onClick={() => setFilter("conflict")}>Your export has more than one password for some logins — old ones are often kept. Pick the current one.</Callout>
      )}
      {heldBack > 0 && filter !== "update" && (
        <Callout onClick={() => setFilter("update")}>
          {plural(heldBack, "saved login")} {heldBack === 1 ? "has a different password in this export. It stays" : "have a different password in this export. They stay"}{" "}
          unchanged unless you select {heldBack === 1 ? "it" : "them"} — an export can be older than your vault.
        </Callout>
      )}

      <div className={cn("@container overflow-hidden rounded-xl border bg-card shadow-card transition-opacity", refreshing && "opacity-60")}>
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b bg-paper-2 px-3 py-2 @xl:grid-cols-[auto_minmax(0,1.3fr)_minmax(0,1fr)_7.5rem]">
          <Checkbox
            aria-label="Select all shown logins"
            disabled={bulk.length === 0}
            checked={bulk.length > 0 && bulkSelected === bulk.length ? true : bulkSelected > 0 ? "indeterminate" : false}
            onCheckedChange={(v) => toggleBulk(v === true)}
          />
          <span className="eyebrow">Login</span>
          <span className="eyebrow hidden @xl:block">Username</span>
          <span className="eyebrow text-right">Result</span>
        </div>
        <div className="max-h-[min(42vh,380px)] divide-y overflow-y-auto">
          {visible.map((r) => (
            <ImportRow key={r.id} row={r} checked={selected.has(r.id)} onCheckedChange={(on) => toggle(r, on)} />
          ))}
          {visible.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">Nothing matches.</p>}
        </div>
      </div>

      <SkippedList preview={preview} />
      <PlaintextWarning fileName={file.name} />
    </div>
  );
}

function Callout({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg border border-warning/25 bg-warning/[0.06] px-3 py-2 text-left text-xs text-foreground/85 transition-colors hover:bg-warning/[0.1]"
    >
      <TriangleAlert className="size-3.5 shrink-0 text-warning" />
      <span className="flex-1">{children}</span>
      <span className="font-medium text-warning">Review</span>
    </button>
  );
}

function ImportRow({ row: r, checked, onCheckedChange }: { row: PasswordImportRow; checked: boolean; onCheckedChange: (on: boolean) => void }) {
  const inVault = r.action === "unchanged";
  return (
    <label
      className={cn(
        "grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 transition-colors [contain-intrinsic-size:auto_52px] [content-visibility:auto] @xl:grid-cols-[auto_minmax(0,1.3fr)_minmax(0,1fr)_7.5rem]",
        checked ? "bg-brand-soft/40" : "hover:bg-accent/40",
        inVault && "cursor-default",
      )}
    >
      <Checkbox checked={!inVault && checked} disabled={inVault} onCheckedChange={(v) => onCheckedChange(v === true)} aria-label={`Import ${r.name}`} />
      <div className="flex min-w-0 items-center gap-2.5">
        <Favicon domain={r.domains[0]} name={r.name} size="sm" className={cn(inVault && "opacity-60")} />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className={cn("truncate text-sm font-medium", inVault && "text-muted-foreground")}>{r.name}</span>
            {r.hasTotp && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <ShieldCheck className="size-3.5 shrink-0 text-brand-strong" aria-label="Includes a 2FA code" />
                </TooltipTrigger>
                <TooltipContent>Includes a 2FA code — it's saved and linked</TooltipContent>
              </Tooltip>
            )}
            {r.warning && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <TriangleAlert className="size-3.5 shrink-0 text-warning" aria-label={r.warning} />
                </TooltipTrigger>
                <TooltipContent>{r.warning}</TooltipContent>
              </Tooltip>
            )}
          </div>
          <p className="truncate text-[11px] text-muted-foreground" title={r.domains.join(", ")}>
            <span className="@xl:hidden">{r.username ? `${r.username} · ` : ""}</span>
            {r.domains.join(", ")}
            {r.rows > 1 && ` · ${r.rows} merged`}
            {r.passwordHint && (
              <>
                {" · "}
                <span className="font-mono tracking-wider text-foreground/70" aria-label="Password hint">
                  {r.passwordHint}
                </span>
              </>
            )}
          </p>
        </div>
      </div>
      <span className={cn("hidden truncate text-xs @xl:block", !r.username && "text-muted-foreground italic")}>{r.username || "No username"}</span>
      <div className="flex min-w-0 flex-col items-end gap-0.5">
        <ResultPill row={r} />
        {r.action === "update" && (
          <span className="max-w-full truncate text-[10px] text-muted-foreground" title={`Updates “${r.existingName}”: ${r.changes.join(", ")}`}>
            {r.changes.join(", ")}
          </span>
        )}
      </div>
    </label>
  );
}

const PILL_TONES = {
  new: "bg-brand-soft text-brand-strong ring-brand/25",
  update: "bg-sky-500/10 text-sky-700 ring-sky-600/20 dark:text-sky-300 dark:ring-sky-400/25",
  warn: "bg-warning/10 text-warning ring-warning/25",
  muted: "bg-muted text-muted-foreground ring-border",
};

function Pill({ tone, children }: { tone: keyof typeof PILL_TONES; children: ReactNode }) {
  return <span className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset", PILL_TONES[tone])}>{children}</span>;
}

function ResultPill({ row }: { row: PasswordImportRow }) {
  if (row.action === "unchanged") return <Pill tone="muted">In vault</Pill>;
  if (row.conflictKey)
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Pill tone="warn">Pick one</Pill>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-60">Your export has another password for this login. Choose the one that's current.</TooltipContent>
      </Tooltip>
    );
  return row.action === "new" ? <Pill tone="new">New</Pill> : <Pill tone="update">Update</Pill>;
}

function SkippedList({ preview }: { preview: PasswordImportPreview }) {
  const [open, setOpen] = useState(false);
  const reasons = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of preview.skipped) m.set(s.reason, (m.get(s.reason) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [preview.skipped]);
  if (preview.skipped.length === 0) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border bg-card">
      <CollapsibleTrigger asChild>
        <button type="button" className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-3.5 py-2.5 text-left">
          <span className="text-sm font-medium">{plural(preview.skipped.length, "entry", "entries")} left out</span>
          <span className="flex min-w-0 flex-1 flex-wrap gap-1">
            {reasons.map(([reason, n]) => (
              <span key={reason} className="rounded-[5px] border bg-paper-2 px-1.5 py-px text-[11px] text-muted-foreground">
                {reason} <span className="tabular-nums">{n}</span>
              </span>
            ))}
          </span>
          <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="max-h-40 divide-y overflow-y-auto border-t">
          {preview.skipped.slice(0, 300).map((s, i) => (
            <div key={i} className="flex items-center gap-3 px-3.5 py-1.5 text-xs">
              <span className="min-w-0 flex-1 truncate">{s.name || s.url || "Untitled"}</span>
              {s.username && <span className="hidden max-w-40 truncate text-muted-foreground sm:block">{s.username}</span>}
              <span className="shrink-0 text-muted-foreground">{s.reason}</span>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function PlaintextWarning({ fileName }: { fileName: string }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/[0.06] px-3 py-2 text-xs text-foreground/85">
      <Trash2 className="mt-px size-3.5 shrink-0 text-warning" />
      <span>
        <span className="font-medium text-foreground">{fileName}</span> holds every password in plain text. Delete it after the import and empty the trash.
      </span>
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* Done                                                                 */
/* ------------------------------------------------------------------ */

function ResultView({ result, fileName }: { result: PasswordImportResult; fileName: string }) {
  const total = result.created + result.updated;
  const title = result.created
    ? `Imported ${plural(result.created, "login")}`
    : result.updated
      ? `Updated ${plural(result.updated, "login")}`
      : "Everything was already in your vault";
  const details = [result.created && result.updated ? `${result.updated.toLocaleString()} updated` : "", result.totp ? `${plural(result.totp, "2FA code")} linked` : ""].filter(Boolean);
  return (
    <div className="space-y-5 pt-2">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center text-center">
        <motion.div
          initial={{ scale: 0.85, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 260, damping: 22 }}
          className="grid size-12 place-items-center rounded-xl border border-success/25 bg-success/[0.08] text-success shadow-card"
        >
          <DrawCheck className="size-6" />
        </motion.div>
        <h3 className="mt-3 text-base font-medium tracking-[-0.01em]">{title}</h3>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {details.length ? `${details.join(" · ")}. ` : ""}
          {total ? "Your agents can sign in with them now — Godmode types the passwords, the AI never sees them." : "Nothing needed to change."}
        </p>
      </motion.div>
      <PlaintextWarning fileName={fileName} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Marks                                                                */
/* ------------------------------------------------------------------ */

function ChromeMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-7 shrink-0" aria-hidden>
      <path d="M12 12 2.47 6.5A11 11 0 0 1 21.53 6.5Z" fill="#EA4335" />
      <path d="M12 12 21.53 6.5A11 11 0 0 1 12 23Z" fill="#FBBC04" />
      <path d="M12 12 12 23A11 11 0 0 1 2.47 6.5Z" fill="#34A853" />
      <circle cx="12" cy="12" r="5.25" fill="#fff" />
      <circle cx="12" cy="12" r="4.1" fill="#1A73E8" />
    </svg>
  );
}

function OnePasswordMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-7 shrink-0" aria-hidden>
      <circle cx="12" cy="12" r="11" fill="#1A8CFF" />
      <circle cx="12" cy="12" r="7.6" fill="none" stroke="#fff" strokeOpacity="0.35" strokeWidth="1.2" />
      <path d="M10.6 6.6h2.8v4.1l-1.1 1.3 1.1 1.3v4.1h-2.8v-4.6l.9-.8-.9-.8Z" fill="#fff" />
    </svg>
  );
}
