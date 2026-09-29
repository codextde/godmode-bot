import { useDeferredValue, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNow, isToday } from "date-fns";
import { AnimatePresence, motion } from "motion/react";
import { Activity, Check, ChevronRight, CircleCheck, ClipboardCopy, Download, RefreshCw, ScanSearch, Search, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import type { LogEntry, LogIssue, LogLevel, LogOverview, Settings } from "@godmode/shared";
import { EmptyState } from "@/components/common";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CopyButton } from "@/components/vault/copy-button";
import { writeClipboard } from "@/components/vault/clipboard";
import { toastApiError } from "@/components/vault/vault-utils";
import { api, errorMessage } from "@/lib/api";
import { saveBlob } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { SectionHeading, Segmented, SettingRow, SettingsGroup, useSettingsPatch } from "./settings-kit";

const REFRESH_MS = 10_000;
const ENTRY_LIMIT = 300;

type Filter = "all" | "warn" | "error";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "warn", label: "Warnings" },
  { value: "error", label: "Errors" },
];

const LEVEL_DOT: Record<LogLevel, string> = {
  error: "bg-destructive",
  warn: "bg-warning",
  info: "bg-foreground/25",
  debug: "bg-foreground/10 ring-1 ring-foreground/15",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function stamp(ts: string): string {
  const d = new Date(ts);
  return isToday(d) ? format(d, "HH:mm:ss") : format(d, "MMM d HH:mm");
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/** Issues group messages that differ only in ids and numbers: search for the longest part they share. */
function issueSearch(msg: string): string {
  const parts = msg.split(/\b[a-z]+_[A-Za-z0-9]{8,}\b|\b[0-9a-f]{8}-[0-9a-f-]{27}\b|\b[0-9a-f]{12,}\b|\d+(?:\.\d+)?/i).map((p) => p.trim());
  const longest = parts.reduce((a, b) => (b.length > a.length ? b : a), "");
  return (longest.length >= 4 ? longest : msg).slice(0, 80);
}

/** The detail that tells entries with the same message apart ("slow request" → which route, how slow). */
function hint(e: LogEntry): string | null {
  const d = e.data;
  if (!d) return null;
  const text = (v: unknown) => (typeof v === "string" && v ? v : null);
  const what = d.method && d.route ? `${d.method} ${d.route}` : (text(d.tool) ?? text(d.sql) ?? text(d.agent) ?? text(d.path));
  const ms = typeof d.ms === "number" ? formatMs(d.ms) : null;
  return [what, ms].filter(Boolean).join(" · ") || null;
}

/** Clipboard writes must start inside the click in WebKit (the desktop app): hand it the pending report. */
async function copyReport(): Promise<string> {
  const report = api.logs.report();
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": report.then((t) => new Blob([t], { type: "text/plain" })) })]);
      return await report;
    } catch {
      /* fall back below (or rethrow the request's own error) */
    }
  }
  const text = await report;
  await writeClipboard(text);
  return text;
}

export function LogsSection({ settings }: { settings: Settings }) {
  const qc = useQueryClient();
  const { patch } = useSettingsPatch();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const entriesRef = useRef<HTMLDivElement>(null);

  const overview = useQuery({ queryKey: qk.logOverview, queryFn: api.logs.overview, refetchInterval: REFRESH_MS, refetchOnWindowFocus: true });

  const copy = useMutation({
    mutationFn: copyReport,
    onSuccess: (text) => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success("Log copied", { description: `Paste it into a chat with Claude · ${formatBytes(new Blob([text]).size)}` });
    },
    onError: (e) => toast.error("Could not copy the log", { description: errorMessage(e) }),
  });

  const download = useMutation({
    mutationFn: async () => {
      const text = await api.logs.report(true);
      return saveBlob(new Blob([text], { type: "text/markdown" }), `godmode-log-${format(new Date(), "yyyy-MM-dd-HHmm")}.md`);
    },
    onError: (e) => toastApiError(e, "Could not download the log", qc),
  });

  const clear = useMutation({
    mutationFn: api.logs.clear,
    onSuccess: () => {
      setFilter("all");
      setSearch("");
      toast.success("Log deleted");
      void qc.invalidateQueries({ queryKey: qk.logs });
    },
    onError: (e) => toastApiError(e, "Could not delete the log", qc),
  });

  const showIssue = (issue: LogIssue) => {
    setFilter(issue.level);
    setSearch(issueSearch(issue.msg));
    entriesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const o = overview.data;
  const empty = !!o && o.entries === 0;

  return (
    <div className="space-y-5">
      <SectionHeading
        title="Logs"
        description="A private record of errors, slow spots and how runs went. Copy it into a chat with Claude to track down bugs and make Godmode faster."
      />

      <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border bg-card shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
          <div className="flex min-w-0 items-start gap-3">
            <div className="grid size-8 shrink-0 place-items-center rounded-lg border bg-paper-2 [&_svg]:size-4">
              <Activity />
            </div>
            <div className="min-w-0">
              <h3 className="text-[15px] leading-snug font-medium tracking-[-0.01em]">Diagnostic log</h3>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {!o ? (
                  <Skeleton className="mt-1 h-3 w-48" />
                ) : empty ? (
                  "Nothing recorded yet"
                ) : (
                  <>
                    {o.entries.toLocaleString()} entries · {formatBytes(o.sizeBytes)}
                    {o.firstTs && ` · since ${format(new Date(o.firstTs), "MMM d, HH:mm")}`}
                  </>
                )}
              </div>
            </div>
          </div>
          <span className="flex items-center gap-1.5 rounded-full border bg-paper-2 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            <span className="size-1.5 animate-live-dot rounded-full bg-brand" />
            {settings.diagnostics.verbose ? "Recording in detail" : "Recording"}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3 px-5 pt-5 @xl:grid-cols-4">
          <Stat label="Errors" value={o?.counts.error} tone={o && o.counts.error > 0 ? "error" : undefined} />
          <Stat label="Warnings" value={o?.counts.warn} tone={o && o.counts.warn > 0 ? "warn" : undefined} />
          <Stat label="Entries" value={o?.entries} />
          <Stat label="Last entry" value={o ? (o.lastTs ? formatDistanceToNow(new Date(o.lastTs), { addSuffix: true }) : "—") : undefined} small />
        </div>

        <div className="flex flex-wrap items-center gap-2 px-5 pt-5 pb-4">
          <Button onClick={() => copy.mutate()} disabled={copy.isPending || empty}>
            {copy.isPending ? <Spinner /> : copied ? <Check /> : <ClipboardCopy />}
            {copied ? "Copied" : "Copy for Claude"}
          </Button>
          <Button variant="outline" onClick={() => download.mutate()} disabled={download.isPending || empty}>
            {download.isPending ? <Spinner /> : <Download />} Download
          </Button>
          <Button
            variant="ghost"
            className="ml-auto text-muted-foreground hover:bg-destructive/[0.07] hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
            disabled={clear.isPending || empty}
          >
            {clear.isPending ? <Spinner /> : <Trash2 />} Delete
          </Button>
        </div>
        <p className="flex items-center gap-2 border-t px-5 py-3 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5 shrink-0 text-success" />
          Passwords, 2FA codes, API keys and tokens are masked before anything is written. Nothing leaves this device unless you copy it.
        </p>
      </motion.section>

      <IssuesCard overview={o} loading={overview.isLoading} onSelect={showIssue} />

      <div ref={entriesRef} className="scroll-mt-6">
        <EntriesCard filter={filter} setFilter={setFilter} search={search} setSearch={setSearch} />
      </div>

      <SettingsGroup title="Detailed logging" icon={<ScanSearch />} description="For chasing a specific problem. Turn it off again afterwards — the log fills much faster.">
        <SettingRow
          label="Record every request and tool call"
          description="Adds the timing of every API request and agent tool call, plus debug details from all parts of Godmode."
          htmlFor="verbose-logging"
        >
          <Switch id="verbose-logging" checked={settings.diagnostics.verbose} onCheckedChange={(verbose) => patch({ diagnostics: { verbose } })} />
        </SettingRow>
      </SettingsGroup>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the diagnostic log?</AlertDialogTitle>
            <AlertDialogDescription>
              {o ? `All ${o.entries.toLocaleString()} entries are removed` : "All entries are removed"}, including the desktop app's own log. Godmode keeps recording from
              now on — handy after you've shared the log and the problems are fixed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => clear.mutate()}>
              Delete log
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Stat({ label, value, tone, small }: { label: string; value: number | string | undefined; tone?: "error" | "warn"; small?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-paper-2/60 px-3.5 py-3",
        tone === "error" && "border-destructive/25 bg-destructive/[0.05]",
        tone === "warn" && "border-warning/25 bg-warning/[0.06]",
      )}
    >
      <div className="eyebrow">{label}</div>
      {value === undefined ? (
        <Skeleton className="mt-2 h-6 w-12" />
      ) : (
        <div
          className={cn(
            "mt-1 truncate font-medium tracking-[-0.03em] tabular-nums",
            small ? "pt-1 text-sm" : "text-2xl",
            tone === "error" && "text-destructive",
            tone === "warn" && "text-warning",
          )}
        >
          {typeof value === "number" ? value.toLocaleString() : value}
        </div>
      )}
    </div>
  );
}

function IssuesCard({ overview, loading, onSelect }: { overview: LogOverview | undefined; loading: boolean; onSelect: (issue: LogIssue) => void }) {
  const issues = overview?.issues ?? [];
  return (
    <SettingsGroup
      title="Needs attention"
      icon={<TriangleAlert />}
      description="Warnings and errors that keep coming back, grouped by what they say."
      bodyClassName="px-0"
    >
      {loading ? (
        <div className="space-y-2 p-5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-11" />
          ))}
        </div>
      ) : !issues.length ? (
        <div className="flex items-center gap-3 px-5 py-4 text-sm text-muted-foreground">
          <CircleCheck className="size-4 shrink-0 text-success" />
          Nothing needs attention — no warnings or errors recorded.
        </div>
      ) : (
        <ul className="divide-y">
          {issues.map((issue) => (
            <li key={`${issue.level}|${issue.scope}|${issue.msg}`}>
              <button
                type="button"
                onClick={() => onSelect(issue)}
                className="group flex w-full items-start gap-3 px-5 py-3 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40"
              >
                <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", LEVEL_DOT[issue.level])} />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-sm break-words">{issue.msg}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <ScopeTag scope={issue.scope} />
                    <span>last {formatDistanceToNow(new Date(issue.lastTs), { addSuffix: true })}</span>
                  </span>
                </span>
                <span
                  className={cn(
                    "mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[11px] tabular-nums",
                    issue.level === "error" ? "bg-destructive/[0.08] text-destructive" : "bg-warning/[0.1] text-warning",
                  )}
                >
                  ×{issue.count.toLocaleString()}
                </span>
                <ChevronRight className="mt-1 size-3.5 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </SettingsGroup>
  );
}

function ScopeTag({ scope }: { scope: string }) {
  return <span className="shrink-0 rounded-[4px] bg-secondary px-1.5 py-px font-mono text-[10.5px] text-secondary-foreground">{scope}</span>;
}

function EntriesCard({
  filter,
  setFilter,
  search,
  setSearch,
}: {
  filter: Filter;
  setFilter: (f: Filter) => void;
  search: string;
  setSearch: (s: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const deferred = useDeferredValue(search.trim());
  const query = useQuery({
    queryKey: qk.logEntries(filter, deferred),
    queryFn: () => api.logs.entries({ level: filter === "all" ? undefined : filter, search: deferred || undefined, limit: ENTRY_LIMIT }),
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
  });
  const entries = useMemo(() => withIds(query.data ?? []), [query.data]);

  return (
    <SettingsGroup
      title="Entries"
      icon={<Activity />}
      description="Newest first. Click an entry for its details."
      bodyClassName="px-0"
      actions={
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="Refresh" onClick={() => query.refetch()} disabled={query.isFetching}>
              <RefreshCw className={cn(query.isFetching && "animate-spin")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
      }
    >
      <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
        <Segmented value={filter} onChange={setFilter} options={FILTERS} aria-label="Filter by level" />
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search messages, scopes, details…" aria-label="Search the log" className="pl-9" />
        </div>
      </div>

      {query.isLoading ? (
        <div className="space-y-2 p-5">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-8" />
          ))}
        </div>
      ) : query.isError ? (
        <div className="p-5 text-sm">
          <p className="font-medium text-destructive">Could not load the log</p>
          <p className="mt-1 text-muted-foreground">{errorMessage(query.error)}</p>
        </div>
      ) : !entries.length ? (
        <div className="p-5">
          <EmptyState
            icon={<Activity />}
            title={deferred || filter !== "all" ? "No matching entries" : "The log is empty"}
            description={deferred || filter !== "all" ? "Try another filter or search." : "Errors, slow spots and finished runs will show up here as Godmode works."}
            className="py-10"
          />
        </div>
      ) : (
        <div className={cn("max-h-[560px] overflow-auto transition-opacity", query.isPlaceholderData && "opacity-60")}>
          <ul className="divide-y">
            {entries.map(({ id, entry }) => (
              <EntryRow key={id} entry={entry} open={open === id} onToggle={() => setOpen((o) => (o === id ? null : id))} />
            ))}
          </ul>
          {entries.length >= ENTRY_LIMIT && (
            <p className="border-t px-5 py-3 text-center text-xs text-muted-foreground">
              Showing the newest {ENTRY_LIMIT}. Search or filter to find older entries — Copy and Download include everything.
            </p>
          )}
        </div>
      )}
    </SettingsGroup>
  );
}

/** Stable keys across refreshes (new entries arrive on top), so an open entry stays open. */
function withIds(entries: LogEntry[]): { id: string; entry: LogEntry }[] {
  const seen = new Map<string, number>();
  const out = new Array<{ id: string; entry: LogEntry }>(entries.length);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const base = `${e.ts}|${e.scope}|${e.msg}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out[i] = { id: `${base}|${n}`, entry: e };
  }
  return out;
}

function EntryRow({ entry, open, onToggle }: { entry: LogEntry; open: boolean; onToggle: () => void }) {
  const details = entry.data || entry.err;
  const detail = hint(entry);
  return (
    <li className={cn(open && "bg-muted/30")}>
      <button
        type="button"
        onClick={details ? onToggle : undefined}
        aria-expanded={details ? open : undefined}
        className={cn(
          "grid w-full grid-cols-[5.75rem_0.5rem_minmax(0,1fr)_auto] items-center gap-x-3 px-5 py-2 text-left outline-none",
          details ? "cursor-pointer hover:bg-muted/40 focus-visible:bg-muted/40" : "cursor-default",
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="font-mono text-[11px] whitespace-nowrap text-muted-foreground tabular-nums">{stamp(entry.ts)}</span>
          </TooltipTrigger>
          <TooltipContent>{format(new Date(entry.ts), "PPpp")}</TooltipContent>
        </Tooltip>
        <span className={cn("size-2 rounded-full", LEVEL_DOT[entry.level])} aria-label={entry.level} />
        <span className="flex min-w-0 items-center gap-2">
          <ScopeTag scope={entry.scope} />
          <span className={cn("min-w-0 truncate text-[13px]", entry.level === "error" && "text-destructive", entry.level === "debug" && "text-muted-foreground")}>
            {entry.msg}
          </span>
          {detail && <span className="max-w-[45%] shrink-0 truncate font-mono text-[11px] text-muted-foreground">{detail}</span>}
        </span>
        {details ? <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")} /> : <span />}
      </button>
      <AnimatePresence initial={false}>
        {open && details && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <EntryDetails entry={entry} />
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

function EntryDetails({ entry }: { entry: LogEntry }) {
  const blocks: { label: string; body: ReactNode }[] = [];
  if (entry.err) blocks.push({ label: entry.err.name ?? "Error", body: entry.err.stack ?? entry.err.message });
  if (entry.data) blocks.push({ label: "Details", body: JSON.stringify(entry.data, null, 2) });
  return (
    <div className="space-y-2 px-5 pt-1 pb-4 pl-[calc(1.25rem+5.75rem+0.75rem)]">
      {blocks.map((b) => (
        <div key={b.label} className="relative">
          <div className="eyebrow mb-1">{b.label}</div>
          <pre className="max-h-64 overflow-auto rounded-lg border bg-card p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">{b.body}</pre>
        </div>
      ))}
      <div className="flex justify-end">
        <CopyButton value={JSON.stringify(entry, null, 2)} label="Copy entry" toastLabel="Entry copied" size="icon-xs" />
      </div>
    </div>
  );
}
