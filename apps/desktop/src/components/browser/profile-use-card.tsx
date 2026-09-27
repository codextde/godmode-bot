import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { formatDistanceToNow } from "date-fns";
import { ChevronDown, CircleCheck, CircleX, CloudUpload, Download, KeyRound, RefreshCw, Terminal } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { InlineCode } from "@/components/onboarding/doctor-checklist";
import { WorkingTicks } from "@/components/aicss/Motion";
import { toastApiError } from "@/components/vault/vault-utils";
import { ApiRequestError, api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

const PROFILE_USE_KEY = ["browser", "profile-use"];
const ALL_SOURCES = "__all__";

/** browser-use `profile-use`: sync local Chrome cookies to a browser-use Cloud profile. */
export function ProfileUseCard() {
  const qc = useQueryClient();
  const [source, setSource] = useState(ALL_SOURCES);
  const [log, setLog] = useState<{ ok: boolean; output: string } | null>(null);
  const [logOpen, setLogOpen] = useState(false);

  const status = useQuery({ queryKey: PROFILE_USE_KEY, queryFn: api.browser.profileUse, retry: false, staleTime: 30_000 });
  const chrome = useQuery({ queryKey: qk.chromeProfiles, queryFn: api.browser.chromeProfiles, staleTime: 60_000, enabled: status.isSuccess });

  const sync = useMutation({
    mutationFn: () => api.browser.profileUseSync(source === ALL_SOURCES ? {} : { sourcePath: source }),
    onSuccess: (res) => {
      setLog({ ok: res.ok, output: res.output });
      setLogOpen(!res.ok);
      if (res.ok) toast.success("Synced to browser-use Cloud", { description: res.cloudProfileId ? `Cloud profile ${res.cloudProfileId}` : undefined });
      else toast.error("Sync failed", { description: "See the log for details." });
      void qc.invalidateQueries({ queryKey: PROFILE_USE_KEY });
    },
    onError: (e) => {
      setLog({ ok: false, output: errorMessage(e) });
      setLogOpen(true);
      toastApiError(e, "Sync failed", qc);
    },
  });

  const install = useMutation({
    mutationFn: api.browser.profileUseInstall,
    onSuccess: (next) => {
      qc.setQueryData(PROFILE_USE_KEY, next);
      if (next.installed) toast.success("profile-use installed");
      else toast.error("Install didn't finish", { description: next.detail || undefined });
    },
    onError: (e) => toastApiError(e, "Couldn't install profile-use", qc),
  });

  const notAvailable = status.error instanceof ApiRequestError && (status.error.status === 404 || status.error.status === 501);
  const s = status.data;

  return (
    <section className={cn("rounded-xl border bg-card p-5 shadow-card", sync.isPending && "glow-border")}>
      <div className="mb-4 flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg border bg-card text-foreground shadow-card">
          <CloudUpload className="size-[18px]" />
        </div>
        <div>
          <h2 className="text-[15px] leading-snug font-medium tracking-[-0.01em]">browser-use Cloud sync</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Syncs your local Chrome cookies to a browser-use Cloud profile so cloud agents are logged in too.
          </p>
        </div>
      </div>

      {status.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-9 rounded-lg" />
          <Skeleton className="h-9 rounded-lg" />
          <Skeleton className="h-9 rounded-lg" />
        </div>
      ) : notAvailable ? (
        <p className="rounded-lg border border-dashed bg-paper-2/60 p-4 text-center text-sm text-muted-foreground">Not available in this version of the core.</p>
      ) : status.isError || !s ? (
        <div className="rounded-lg border border-destructive/25 bg-destructive/[0.05] p-4 text-sm">
          <p className="font-medium text-destructive">Couldn't check profile-use</p>
          <p className="mt-1 text-muted-foreground">{errorMessage(status.error)}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => status.refetch()}>
            <RefreshCw /> Try again
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <ul className="divide-y rounded-lg border bg-paper-2">
            <StatusRow
              ok={s.installed}
              label="profile-use"
              value={
                s.installed ? (
                  <span className="font-mono text-[11px] text-muted-foreground" title={s.path ?? undefined}>
                    {s.path ?? "Installed"}
                  </span>
                ) : (
                  <span className="flex items-center justify-between gap-2">
                    Not installed
                    <Button size="xs" variant="outline" onClick={() => install.mutate()} disabled={install.isPending}>
                      {install.isPending ? <Spinner className="size-3" /> : <Download />}
                      {install.isPending ? "Installing…" : "Install"}
                    </Button>
                  </span>
                )
              }
            />
            <StatusRow
              ok={s.hasApiKey}
              label="API key"
              value={
                s.hasApiKey ? (
                  "browser_use_api_key set"
                ) : (
                  <Link to="/integrations?tab=api-keys" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                    <KeyRound className="size-3" /> Add browser-use API key
                  </Link>
                )
              }
            />
            <StatusRow
              ok={!!s.lastSyncAt}
              neutral
              label="Last sync"
              value={s.lastSyncAt ? formatDistanceToNow(new Date(s.lastSyncAt), { addSuffix: true }) : "Never"}
            />
          </ul>
          {(!s.installed || !s.hasApiKey) && s.detail && (
            <p className="text-xs text-muted-foreground">
              <InlineCode text={s.detail} />
            </p>
          )}

          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-44 flex-1 space-y-1.5">
              <Label htmlFor="profile-use-source" className="text-xs text-muted-foreground">
                Chrome profile
              </Label>
              <Select value={source} onValueChange={setSource}>
                <SelectTrigger id="profile-use-source" size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_SOURCES}>All detected profiles</SelectItem>
                  {chrome.data?.map((p) => (
                    <SelectItem key={p.path} value={p.path}>
                      {p.browser} — {p.name}
                      {p.email && <span className="text-muted-foreground"> · {p.email}</span>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button size="sm" onClick={() => sync.mutate()} disabled={!s.installed || !s.hasApiKey || sync.isPending}>
              {sync.isPending ? <Spinner /> : <CloudUpload />}
              {sync.isPending ? "Syncing…" : "Sync to cloud"}
            </Button>
          </div>
          {sync.isPending && (
            <p className="flex items-center gap-2 text-xs">
              <WorkingTicks count={6} className="h-3 text-brand-strong" />
              <span className="text-shimmer font-medium">This can take a few minutes — you can keep working meanwhile.</span>
            </p>
          )}

          {log && (
            <div>
              <button
                type="button"
                onClick={() => setLogOpen((o) => !o)}
                className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                aria-expanded={logOpen}
              >
                <Terminal className="size-3.5" />
                {log.ok ? "Sync log" : "Sync failed — show log"}
                <ChevronDown className={cn("size-3.5 transition-transform", logOpen && "rotate-180")} />
              </button>
              <AnimatePresence initial={false}>
                {logOpen && (
                  <motion.pre
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="mt-2 max-h-56 overflow-auto rounded-lg border bg-paper-2 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground"
                  >
                    {log.output || "(no output)"}
                  </motion.pre>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function StatusRow({ ok, neutral, label, value }: { ok: boolean; neutral?: boolean; label: string; value: React.ReactNode }) {
  return (
    <li className="flex items-center gap-3 px-3 py-2 text-sm">
      {ok ? (
        <CircleCheck className="size-4 shrink-0 text-success" aria-label="OK" />
      ) : neutral ? (
        <span className="grid size-4 shrink-0 place-items-center" aria-hidden>
          <span className="size-1.5 rounded-full bg-muted-foreground/50" />
        </span>
      ) : (
        <CircleX className="size-4 shrink-0 text-destructive" aria-label="Missing" />
      )}
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate text-xs">{value}</span>
    </li>
  );
}
