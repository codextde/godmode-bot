import { useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GithubErrorCode, parsePullRequestUrl, type PullRequestMergeMethod, type PullRequestCheck, type PullRequestReview, type PullRequestView, type PullRequestViewState } from "@godmode/shared";
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  CircleDashed,
  CircleDot,
  CircleMinus,
  FileText,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquare,
  PanelRightClose,
  RefreshCw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ago } from "@/components/artifacts/artifact-view";
import { Markdown } from "@/components/chat/markdown";
import { api, ApiRequestError } from "@/lib/api";
import { openExternal } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { SidePanelScopeProvider } from "@/components/side-panel/store";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const STALE_MS = 30_000;
const OPEN_REFRESH_MS = 60_000;
const SETTLED_REFRESH_MS = 10 * 60_000;
const CHECKS_SHOWN = 6;
const FILES_SHOWN = 12;

function usePullRequest(url: string) {
  const qc = useQueryClient();
  const key = qk.pullRequest(url);
  return useQuery({
    queryKey: key,
    queryFn: () => api.github.pull(url, { background: (qc.getQueryState(key)?.dataUpdateCount ?? 0) > 0 }),
    staleTime: STALE_MS,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const wait = data.state === "open" || data.state === "draft" ? OPEN_REFRESH_MS : SETTLED_REFRESH_MS;
      const retryIn = data.retryAt ? Date.parse(data.retryAt) - Date.now() : 0;
      return Math.max(wait, retryIn);
    },
    retry: (count, err) => !(err instanceof ApiRequestError && err.status < 500) && count < 1,
  });
}

function timeOf(iso: string | null | undefined) {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function PullRequestPanel({ conversationId, url, onHide }: { conversationId: string; url: string; onHide: () => void }) {
  const ref = parsePullRequestUrl(url);
  const qc = useQueryClient();
  const query = usePullRequest(url);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      qc.setQueryData(qk.pullRequest(url), await api.github.pull(url, { refresh: true }));
    } catch {
      await query.refetch();
    } finally {
      setRefreshing(false);
    }
  };
  const width = "min(44vw, 620px)";
  const data = query.data;

  return (
    <motion.aside
      aria-label="Pull request"
      initial={{ width: 0, opacity: 0 }}
      animate={{ width, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 36 }}
      className="h-full shrink-0 overflow-hidden border-l bg-paper-2"
    >
      <div className="flex h-full flex-col" style={{ width }}>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <GitPullRequest className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium">{ref ? `${ref.owner}/${ref.repo} #${ref.number}` : "Pull request"}</p>
            {data && (
              <p className="truncate text-[11.5px] text-muted-foreground">
                {data.stale ? `Last loaded ${ago(data.fetchedAt)}` : `Updated ${ago(data.updatedAt)}`}
              </p>
            )}
          </div>
          <IconAction label="Refresh" onClick={() => void refresh()} disabled={refreshing || query.isFetching}>
            <RefreshCw className={cn((refreshing || query.isFetching) && "animate-spin [animation-duration:1.6s]")} />
          </IconAction>
          <IconAction label="Open on GitHub" onClick={() => void openExternal(data?.url ?? url)}>
            <ArrowUpRight />
          </IconAction>
          <IconAction label="Close" onClick={onHide}>
            <PanelRightClose />
          </IconAction>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {data ? (
            <SidePanelScopeProvider value={{ conversationId, current: { kind: "pull", url } }}>
              <PullRequestBody pr={data} url={url} />
            </SidePanelScopeProvider>
          ) : query.isError ? (
            <Failure error={query.error} url={url} onRetry={() => void refresh()} />
          ) : (
            <Loading />
          )}
        </div>
      </div>
    </motion.aside>
  );
}

function IconAction({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" onClick={onClick} disabled={disabled} aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Loading() {
  return (
    <div className="space-y-3 p-4">
      <Skeleton className="h-5 w-4/5" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

function Failure({ error, url, onRetry }: { error: Error; url: string; onRetry: () => void }) {
  const code = error instanceof ApiRequestError ? error.code : undefined;
  const retryAt = error instanceof ApiRequestError ? timeOf((error.details as { retryAt?: string | null } | undefined)?.retryAt) : null;
  const text =
    code === GithubErrorCode.RateLimited
      ? `GitHub only allows a certain number of looks per hour, and they're used up${retryAt ? ` until ${retryAt}` : " for now"}.`
      : code === GithubErrorCode.NotFound
        ? "GitHub can't find this pull request. If it's private, this computer needs to be signed in to GitHub: run “gh auth login” in Terminal."
        : code === GithubErrorCode.Unauthorized
          ? "GitHub didn't accept this computer's GitHub login. Run “gh auth login” in Terminal to sign in again."
          : `Couldn't load it from GitHub: ${error.message}`;
  return (
    <div className="flex flex-col items-start gap-3 p-4 text-sm">
      <p className="flex gap-2 text-muted-foreground">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        {text}
      </p>
      <div className="flex gap-2">
        {code !== GithubErrorCode.RateLimited && (
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RefreshCw /> Try again
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => void openExternal(url)}>
          Open on GitHub <ArrowUpRight />
        </Button>
      </div>
    </div>
  );
}

const STATES: Record<PullRequestViewState, { label: string; icon: typeof GitPullRequest; className: string }> = {
  open: { label: "Open", icon: GitPullRequest, className: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400" },
  draft: { label: "Draft", icon: GitPullRequestDraft, className: "bg-muted text-muted-foreground" },
  merged: { label: "Merged", icon: GitMerge, className: "bg-violet-500/12 text-violet-700 dark:text-violet-400" },
  closed: { label: "Closed", icon: GitPullRequestClosed, className: "bg-red-500/12 text-red-700 dark:text-red-400" },
};

function PullRequestBody({ pr, url }: { pr: PullRequestView; url: string }) {
  const state = STATES[pr.state];
  const StateIcon = state.icon;
  const when = pr.state === "merged" ? `merged ${ago(pr.mergedAt)}` : pr.state === "closed" ? `closed ${ago(pr.closedAt)}` : `opened ${ago(pr.createdAt)}`;
  return (
    <div className="space-y-4 p-4">
      {pr.stale && (
        <p className="rounded-lg border bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          GitHub's hourly limit is used up, so this is what was loaded {ago(pr.fetchedAt)}
          {timeOf(pr.retryAt) ? `. It refreshes after ${timeOf(pr.retryAt)}.` : "."}
        </p>
      )}
      {!pr.signedIn && (
        <p className="rounded-lg border bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          This computer isn't signed in to GitHub, so GitHub allows only a few looks per hour. Run “gh auth login” in Terminal for more.
        </p>
      )}

      <div className="space-y-2">
        <h2 className="text-[15px] leading-snug font-semibold tracking-[-0.01em] break-words">{pr.title}</h2>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium", state.className)}>
            <StateIcon className="size-3.5" />
            {state.label}
          </span>
          <span className="inline-flex items-center gap-1.5">
            {pr.authorAvatarUrl && <img src={pr.authorAvatarUrl} alt="" className="size-4 rounded-full" />}
            <span className="font-medium text-foreground">{pr.author}</span> {when}
          </span>
        </div>
        <p className="truncate font-mono text-[11.5px] text-muted-foreground" title={`${pr.headBranch} → ${pr.baseBranch}`}>
          {pr.headBranch} → {pr.baseBranch}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">+{pr.additions}</span> <span className="text-red-600 dark:text-red-400">−{pr.deletions}</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <FileText className="size-3.5" /> {pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"}
          </span>
          <span>
            {pr.commits} {pr.commits === 1 ? "commit" : "commits"}
          </span>
          {pr.comments > 0 && (
            <span className="inline-flex items-center gap-1">
              <MessageSquare className="size-3.5" /> {pr.comments}
            </span>
          )}
        </div>
        {pr.labels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {pr.labels.map((l) => (
              <span key={l.name} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]">
                <span className="size-2 rounded-full" style={{ backgroundColor: /^[0-9a-f]{6}$/i.test(l.color) ? `#${l.color}` : undefined }} />
                {l.name}
              </span>
            ))}
          </div>
        )}
      </div>

      {(pr.state === "open" || pr.state === "draft") && pr.mergeable !== "clean" && pr.mergeable !== "unknown" && (
        <p className="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs">
          <CircleAlert className="size-3.5 shrink-0 text-amber-600" />
          {pr.mergeable === "conflicting" ? "Has conflicts with the base branch" : "Can't be merged yet: a required review or check is missing"}
        </p>
      )}

      {(pr.state === "open" || pr.state === "draft") && pr.canMerge && <MergeBar pr={pr} url={url} />}

      {pr.reviews && pr.reviews.length > 0 && <Reviews reviews={pr.reviews} />}
      {pr.checks && pr.checks.length > 0 && <Checks checks={pr.checks} />}

      {pr.body.trim() && (
        <Section title="Description">
          <Collapsible long={pr.body.length > 700 || pr.body.split("\n").length > 14}>
            <Markdown className="text-[13px]">{pr.body}</Markdown>
          </Collapsible>
        </Section>
      )}

      {pr.files && pr.files.length > 0 && <Files pr={pr} />}
    </div>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {aside && <span className="text-[11px] text-muted-foreground">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function Collapsible({ long, children }: { long: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!long) return <>{children}</>;
  return (
    <div className="relative">
      <div className={cn(!open && "max-h-64 overflow-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)]")}>{children}</div>
      <button type="button" className="mt-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(!open)}>
        {open ? "Show less" : "Show all"}
      </button>
    </div>
  );
}

const REVIEW_LABEL: Record<PullRequestReview["state"], string> = { approved: "approved", changes_requested: "wants changes", commented: "commented" };

function Reviews({ reviews }: { reviews: PullRequestReview[] }) {
  return (
    <Section title="Reviews">
      <ul className="space-y-1">
        {reviews.map((r) => (
          <li key={r.author} className="flex items-center gap-2 text-[13px]">
            {r.state === "approved" ? (
              <Check className="size-3.5 text-emerald-600" />
            ) : r.state === "changes_requested" ? (
              <X className="size-3.5 text-red-600" />
            ) : (
              <MessageSquare className="size-3.5 text-muted-foreground" />
            )}
            {r.avatarUrl && <img src={r.avatarUrl} alt="" className="size-4 rounded-full" />}
            <span className="font-medium">{r.author}</span>
            <span className="text-muted-foreground">{REVIEW_LABEL[r.state]}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function CheckIcon({ state }: { state: PullRequestCheck["state"] }) {
  switch (state) {
    case "success":
      return <Check className="size-3.5 shrink-0 text-emerald-600" />;
    case "failure":
      return <X className="size-3.5 shrink-0 text-red-600" />;
    case "pending":
      return <CircleDashed className="size-3.5 shrink-0 animate-spin text-amber-600 [animation-duration:3s]" />;
    default:
      return <CircleMinus className="size-3.5 shrink-0 text-muted-foreground" />;
  }
}

function Checks({ checks }: { checks: PullRequestCheck[] }) {
  const [all, setAll] = useState(false);
  const count = (state: PullRequestCheck["state"]) => checks.filter((c) => c.state === state).length;
  const summary = [
    count("failure") && `${count("failure")} failed`,
    count("pending") && `${count("pending")} running`,
    count("success") && `${count("success")} passed`,
    count("neutral") && `${count("neutral")} skipped`,
  ]
    .filter(Boolean)
    .join(" · ");
  const shown = all ? checks : checks.slice(0, CHECKS_SHOWN);
  return (
    <Section title="Checks" aside={summary}>
      <ul className="space-y-0.5">
        {shown.map((c) => (
          <li key={c.name} className="flex items-center gap-2 text-[13px]">
            <CheckIcon state={c.state} />
            {c.url ? (
              <a href={c.url} target="_blank" rel="noreferrer noopener" className="min-w-0 truncate hover:underline">
                {c.name}
              </a>
            ) : (
              <span className="min-w-0 truncate">{c.name}</span>
            )}
          </li>
        ))}
      </ul>
      {checks.length > CHECKS_SHOWN && (
        <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${checks.length}`}
        </button>
      )}
    </Section>
  );
}

function Files({ pr }: { pr: PullRequestView }) {
  const [all, setAll] = useState(false);
  const files = pr.files ?? [];
  const shown = all ? files : files.slice(0, FILES_SHOWN);
  const hidden = pr.changedFiles - files.length;
  return (
    <Section title="Files">
      <ul className="space-y-0.5">
        {shown.map((f) => (
          <li key={f.path} className="flex items-center gap-2 text-[12.5px]">
            {f.status === "added" ? (
              <CircleDot className="size-3 shrink-0 text-emerald-600" />
            ) : f.status === "removed" ? (
              <CircleMinus className="size-3 shrink-0 text-red-600" />
            ) : (
              <FileText className="size-3 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate font-mono" title={f.path}>
              {f.path}
            </span>
            <span className="shrink-0 font-mono text-[11px] tabular-nums">
              <span className="text-emerald-600 dark:text-emerald-400">+{f.additions}</span>{" "}
              <span className="text-red-600 dark:text-red-400">−{f.deletions}</span>
            </span>
          </li>
        ))}
      </ul>
      {(files.length > FILES_SHOWN || hidden > 0) && (
        <div className="flex gap-3 text-xs text-muted-foreground">
          {files.length > FILES_SHOWN && (
            <button type="button" className="hover:text-foreground" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `Show all ${files.length}`}
            </button>
          )}
          {hidden > 0 && (
            <a href={`${pr.url}/files`} target="_blank" rel="noreferrer noopener" className="hover:text-foreground">
              {hidden} more on GitHub
            </a>
          )}
        </div>
      )}
    </Section>
  );
}

const METHOD_LABEL: Record<PullRequestMergeMethod, { button: string; hint: string }> = {
  merge: { button: "Merge", hint: "All commits, plus a merge commit" },
  squash: { button: "Squash and merge", hint: "All changes as one commit" },
  rebase: { button: "Rebase and merge", hint: "The commits, replayed on the base branch" },
};
const METHOD_KEY = "gm.github.mergeMethod";

function preferredMethod(methods: PullRequestMergeMethod[]): PullRequestMergeMethod | null {
  const saved = localStorage.getItem(METHOD_KEY) as PullRequestMergeMethod | null;
  return saved && methods.includes(saved) ? saved : (methods[0] ?? null);
}

function MergeBar({ pr, url }: { pr: PullRequestView; url: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<PullRequestMergeMethod | null>(() => preferredMethod(pr.mergeMethods));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const blocker =
    pr.state === "draft"
      ? "It's still a draft. Mark it ready for review on GitHub first."
      : pr.mergeable === "conflicting"
        ? "Resolve the conflicts with the base branch first."
        : pr.mergeMethods.length === 0
          ? "This repository allows no merge method."
          : null;
  const failing = (pr.checks ?? []).filter((c) => c.state === "failure").length;
  const running = (pr.checks ?? []).filter((c) => c.state === "pending").length;
  const wantsChanges = (pr.reviews ?? []).some((r) => r.state === "changes_requested");
  const warnings = [
    failing > 0 && `${failing} ${failing === 1 ? "check failed" : "checks failed"}`,
    running > 0 && `${running} ${running === 1 ? "check is" : "checks are"} still running`,
    wantsChanges && "a reviewer asked for changes",
    pr.mergeable === "blocked" && "GitHub reports a required review or check missing",
  ].filter((w): w is string => !!w);

  const merge = async () => {
    if (!method) return;
    setBusy(true);
    setProblem(null);
    try {
      localStorage.setItem(METHOD_KEY, method);
      const view = await api.github.merge({ url, method, headSha: pr.headSha });
      qc.setQueryData(qk.pullRequest(url), view);
      setOpen(false);
      toast.success(`Merged #${pr.ref.number} into ${pr.baseBranch}`);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
      if (err instanceof ApiRequestError && err.code === GithubErrorCode.MergeRefused) void qc.invalidateQueries({ queryKey: qk.pullRequest(url) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2">
      <GitMerge className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">{blocker ?? `Into ${pr.baseBranch}`}</p>
      <Button
        size="sm"
        disabled={!!blocker || !method}
        onClick={() => {
          setProblem(null);
          setMethod(preferredMethod(pr.mergeMethods));
          setOpen(true);
        }}
      >
        <GitMerge /> Merge…
      </Button>
      <AlertDialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Merge #{pr.ref.number} into {pr.baseBranch}?
            </AlertDialogTitle>
            <AlertDialogDescription className="break-words">{pr.title}</AlertDialogDescription>
          </AlertDialogHeader>
          {pr.mergeMethods.length > 1 && (
            <div className="grid gap-1.5" role="radiogroup" aria-label="How to merge">
              {pr.mergeMethods.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={method === m}
                  onClick={() => setMethod(m)}
                  className={cn("rounded-lg border px-3 py-2 text-left transition", method === m ? "border-brand/50 bg-brand-soft/40 ring-2 ring-brand/15" : "hover:border-foreground/15")}
                >
                  <span className="block text-sm font-medium">{METHOD_LABEL[m].button}</span>
                  <span className="block text-xs text-muted-foreground">{METHOD_LABEL[m].hint}</span>
                </button>
              ))}
            </div>
          )}
          {warnings.length > 0 && (
            <p className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-xs">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
              <span>Heads up: {warnings.join(", ")}.</span>
            </p>
          )}
          {problem && (
            <p className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive" role="alert">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>GitHub didn't merge it: {problem}</span>
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button onClick={() => void merge()} disabled={busy || !method}>
              {busy ? <RefreshCw className="animate-spin" /> : <GitMerge />} {method ? METHOD_LABEL[method].button : "Merge"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
