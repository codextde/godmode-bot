import { useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
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
import { PANEL } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { intlLocale } from "@/i18n";
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
  return Number.isNaN(at.getTime()) ? null : at.toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit" });
}

export function PullRequestPanel({ conversationId, url, onHide }: { conversationId: string; url: string; onHide: () => void }) {
  const { t } = useTranslation("chat");
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
    }
    setRefreshing(false);
  };
  const width = "min(44vw, 620px)";
  const data = query.data;

  return (
    <motion.aside
      aria-label={t("pullRequest.title")}
      initial={{ width: 0, opacity: 0 }}
      animate={{ width, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={PANEL}
      className="h-full shrink-0 overflow-hidden border-l bg-paper-2"
    >
      <div className="flex h-full flex-col" style={{ width }}>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <GitPullRequest className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium">{ref ? `${ref.owner}/${ref.repo} #${ref.number}` : t("pullRequest.title")}</p>
            {data && (
              <p className="truncate text-[11.5px] text-muted-foreground">
                {data.stale ? t("pullRequest.lastLoaded", { ago: ago(data.fetchedAt) }) : t("pullRequest.updated", { ago: ago(data.updatedAt) })}
              </p>
            )}
          </div>
          <IconAction label={t("pullRequest.refresh")} onClick={() => void refresh()} disabled={refreshing || query.isFetching}>
            <RefreshCw className={cn((refreshing || query.isFetching) && "animate-spin [animation-duration:1.6s]")} />
          </IconAction>
          <IconAction label={t("pullRequest.openOnGithub")} onClick={() => void openExternal(data?.url ?? url)}>
            <ArrowUpRight />
          </IconAction>
          <IconAction label={t("pullRequest.close")} onClick={onHide}>
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
  const { t } = useTranslation("chat");
  const code = error instanceof ApiRequestError ? error.code : undefined;
  const retryAt = error instanceof ApiRequestError ? timeOf((error.details as { retryAt?: string | null } | undefined)?.retryAt) : null;
  const text =
    code === GithubErrorCode.RateLimited
      ? retryAt
        ? t("pullRequest.errors.rateLimitedUntil", { time: retryAt })
        : t("pullRequest.errors.rateLimited")
      : code === GithubErrorCode.NotFound
        ? t("pullRequest.errors.notFound")
        : code === GithubErrorCode.Unauthorized
          ? t("pullRequest.errors.unauthorized")
          : t("pullRequest.errors.other", { message: error.message });
  return (
    <div className="flex flex-col items-start gap-3 p-4 text-sm">
      <p className="flex gap-2 text-muted-foreground">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        {text}
      </p>
      <div className="flex gap-2">
        {code !== GithubErrorCode.RateLimited && (
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RefreshCw /> {t("pullRequest.tryAgain")}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => void openExternal(url)}>
          {t("pullRequest.openOnGithub")} <ArrowUpRight />
        </Button>
      </div>
    </div>
  );
}

const STATES: Record<PullRequestViewState, { icon: typeof GitPullRequest; className: string }> = {
  open: { icon: GitPullRequest, className: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400" },
  draft: { icon: GitPullRequestDraft, className: "bg-muted text-muted-foreground" },
  merged: { icon: GitMerge, className: "bg-violet-500/12 text-violet-700 dark:text-violet-400" },
  closed: { icon: GitPullRequestClosed, className: "bg-red-500/12 text-red-700 dark:text-red-400" },
};

function PullRequestBody({ pr, url }: { pr: PullRequestView; url: string }) {
  const { t } = useTranslation("chat");
  const state = STATES[pr.state];
  const StateIcon = state.icon;
  const when =
    pr.state === "merged"
      ? t("pullRequest.when.merged", { ago: ago(pr.mergedAt) })
      : pr.state === "closed"
        ? t("pullRequest.when.closed", { ago: ago(pr.closedAt) })
        : t("pullRequest.when.opened", { ago: ago(pr.createdAt) });
  return (
    <div className="space-y-4 p-4">
      {pr.stale && (
        <p className="rounded-lg border bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          {timeOf(pr.retryAt)
            ? t("pullRequest.staleUntil", { ago: ago(pr.fetchedAt), time: timeOf(pr.retryAt) })
            : t("pullRequest.stale", { ago: ago(pr.fetchedAt) })}
        </p>
      )}
      {!pr.signedIn && (
        <p className="rounded-lg border bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          {t("pullRequest.signedOut")}
        </p>
      )}

      <div className="space-y-2">
        <h2 className="text-[15px] leading-snug font-semibold tracking-[-0.01em] break-words">{pr.title}</h2>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium", state.className)}>
            <StateIcon className="size-3.5" />
            {t(`pullRequest.states.${pr.state}`)}
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
            <FileText className="size-3.5" /> {t("pullRequest.files", { count: pr.changedFiles })}
          </span>
          <span>
            {t("pullRequest.commits", { count: pr.commits })}
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
          {pr.mergeable === "conflicting" ? t("pullRequest.conflicts") : t("pullRequest.blocked")}
        </p>
      )}

      {(pr.state === "open" || pr.state === "draft") && pr.canMerge && <MergeBar pr={pr} url={url} />}

      {pr.reviews && pr.reviews.length > 0 && <Reviews reviews={pr.reviews} />}
      {pr.checks && pr.checks.length > 0 && <Checks checks={pr.checks} />}

      {pr.body.trim() && (
        <Section title={t("pullRequest.sections.description")}>
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
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  if (!long) return <>{children}</>;
  return (
    <div className="relative">
      <div className={cn(!open && "max-h-64 overflow-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)]")}>{children}</div>
      <button type="button" className="mt-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(!open)}>
        {open ? t("pullRequest.showLess") : t("pullRequest.showAll")}
      </button>
    </div>
  );
}

function Reviews({ reviews }: { reviews: PullRequestReview[] }) {
  const { t } = useTranslation("chat");
  return (
    <Section title={t("pullRequest.sections.reviews")}>
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
            <span className="text-muted-foreground">{t(`pullRequest.review.${r.state}`)}</span>
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
  const { t } = useTranslation("chat");
  const [all, setAll] = useState(false);
  const count = (state: PullRequestCheck["state"]) => checks.filter((c) => c.state === state).length;
  const summary = [
    count("failure") && t("pullRequest.checks.failed", { count: count("failure") }),
    count("pending") && t("pullRequest.checks.running", { count: count("pending") }),
    count("success") && t("pullRequest.checks.passed", { count: count("success") }),
    count("neutral") && t("pullRequest.checks.skipped", { count: count("neutral") }),
  ]
    .filter(Boolean)
    .join(" · ");
  const shown = all ? checks : checks.slice(0, CHECKS_SHOWN);
  return (
    <Section title={t("pullRequest.sections.checks")} aside={summary}>
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
          {all ? t("pullRequest.showFewer") : t("pullRequest.showAllCount", { count: checks.length })}
        </button>
      )}
    </Section>
  );
}

function Files({ pr }: { pr: PullRequestView }) {
  const { t } = useTranslation("chat");
  const [all, setAll] = useState(false);
  const files = pr.files ?? [];
  const shown = all ? files : files.slice(0, FILES_SHOWN);
  const hidden = pr.changedFiles - files.length;
  return (
    <Section title={t("pullRequest.sections.files")}>
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
              {all ? t("pullRequest.showFewer") : t("pullRequest.showAllCount", { count: files.length })}
            </button>
          )}
          {hidden > 0 && (
            <a href={`${pr.url}/files`} target="_blank" rel="noreferrer noopener" className="hover:text-foreground">
              {t("pullRequest.moreOnGithub", { count: hidden })}
            </a>
          )}
        </div>
      )}
    </Section>
  );
}

const METHOD_KEY = "gm.github.mergeMethod";

function preferredMethod(methods: PullRequestMergeMethod[]): PullRequestMergeMethod | null {
  const saved = localStorage.getItem(METHOD_KEY) as PullRequestMergeMethod | null;
  return saved && methods.includes(saved) ? saved : (methods[0] ?? null);
}

function MergeBar({ pr, url }: { pr: PullRequestView; url: string }) {
  const { t } = useTranslation("chat");
  const qc = useQueryClient();
  const [open, setOpen] = useState<"now" | "auto" | null>(null);
  const [method, setMethod] = useState<PullRequestMergeMethod | null>(() => preferredMethod(pr.mergeMethods));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const blocker =
    pr.state === "draft"
      ? t("pullRequest.merge.blockedDraft")
      : pr.mergeable === "conflicting"
        ? t("pullRequest.merge.blockedConflicts")
        : pr.mergeMethods.length === 0
          ? t("pullRequest.merge.blockedNoMethod")
          : null;
  const failing = (pr.checks ?? []).filter((c) => c.state === "failure").length;
  const running = (pr.checks ?? []).filter((c) => c.state === "pending").length;
  const wantsChanges = (pr.reviews ?? []).some((r) => r.state === "changes_requested");
  const warnings = [
    failing > 0 && t("pullRequest.merge.warnFailing", { count: failing }),
    running > 0 && t("pullRequest.merge.warnRunning", { count: running }),
    wantsChanges && t("pullRequest.merge.warnChanges"),
    pr.mergeable === "blocked" && t("pullRequest.merge.warnBlocked"),
  ].filter((w): w is string => !!w);
  const offerAuto = pr.autoMergeAllowed && !pr.autoMerge && !blocker && (running > 0 || pr.mergeable === "blocked");

  const start = (mode: "now" | "auto") => {
    setProblem(null);
    setMethod(preferredMethod(pr.mergeMethods));
    setOpen(mode);
  };

  const run = async (work: () => Promise<PullRequestView>, done: string, inDialog = true) => {
    setBusy(true);
    setProblem(null);
    try {
      const view = await work();
      qc.setQueryData(qk.pullRequest(url), view);
      setOpen(null);
      toast.success(done);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (inDialog) setProblem(reason);
      else toast.error(t("pullRequest.autoMerge.disableFailed", { reason }));
      if (err instanceof ApiRequestError && err.code === GithubErrorCode.MergeRefused) void qc.invalidateQueries({ queryKey: qk.pullRequest(url) });
    }
    setBusy(false);
  };

  const confirm = async () => {
    if (!method || !open) return;
    localStorage.setItem(METHOD_KEY, method);
    if (open === "auto") await run(() => api.github.autoMerge({ url, method }), t("pullRequest.autoMerge.enabled", { number: pr.ref.number }));
    else await run(() => api.github.merge({ url, method, headSha: pr.headSha }), t("pullRequest.merge.done", { number: pr.ref.number, base: pr.baseBranch }));
  };

  const turnOff = () => run(() => api.github.autoMerge({ url, method: null }), t("pullRequest.autoMerge.disabled", { number: pr.ref.number }), false);

  if (pr.autoMerge) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-brand/30 bg-brand-soft/30 px-3 py-2">
        <GitMerge className="size-4 shrink-0 text-brand" />
        <p className="min-w-0 flex-1 text-xs">
          {t("pullRequest.autoMerge.on", { method: t(`pullRequest.merge.methods.${pr.autoMerge.method}.label`), base: pr.baseBranch })}
          {pr.autoMerge.enabledBy && <span className="text-muted-foreground"> · {t("pullRequest.autoMerge.by", { login: pr.autoMerge.enabledBy })}</span>}
        </p>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void turnOff()}>
          {busy ? <RefreshCw className="animate-spin" /> : <X />} {t("pullRequest.autoMerge.turnOff")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2">
      <GitMerge className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">{blocker ?? t("pullRequest.merge.into", { base: pr.baseBranch })}</p>
      {offerAuto && (
        <Button size="sm" variant="outline" disabled={!method} onClick={() => start("auto")}>
          {t("pullRequest.autoMerge.button")}
        </Button>
      )}
      <Button size="sm" disabled={!!blocker || !method} onClick={() => start("now")}>
        <GitMerge /> {t("pullRequest.merge.button")}
      </Button>
      <AlertDialog open={!!open} onOpenChange={(v) => !busy && !v && setOpen(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {open === "auto" ? t("pullRequest.autoMerge.confirmTitle", { number: pr.ref.number, base: pr.baseBranch }) : t("pullRequest.merge.confirmTitle", { number: pr.ref.number, base: pr.baseBranch })}
            </AlertDialogTitle>
            <AlertDialogDescription className="break-words">{open === "auto" ? t("pullRequest.autoMerge.explain") : pr.title}</AlertDialogDescription>
          </AlertDialogHeader>
          {pr.mergeMethods.length > 1 && (
            <div className="grid gap-1.5" role="radiogroup" aria-label={t("pullRequest.merge.how")}>
              {pr.mergeMethods.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={method === m}
                  onClick={() => setMethod(m)}
                  className={cn("rounded-lg border px-3 py-2 text-left transition", method === m ? "border-brand/50 bg-brand-soft/40 ring-2 ring-brand/15" : "hover:border-foreground/15")}
                >
                  <span className="block text-sm font-medium">{t(`pullRequest.merge.methods.${m}.label`)}</span>
                  <span className="block text-xs text-muted-foreground">{t(`pullRequest.merge.methods.${m}.hint`)}</span>
                </button>
              ))}
            </div>
          )}
          {open === "now" && warnings.length > 0 && (
            <p className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-xs">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
              <span>{t("pullRequest.merge.headsUp", { warnings: warnings.join(", ") })}</span>
            </p>
          )}
          {problem && (
            <p className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive" role="alert">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>{open === "auto" ? t("pullRequest.autoMerge.refused", { reason: problem }) : t("pullRequest.merge.refused", { reason: problem })}</span>
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("pullRequest.merge.cancel")}</AlertDialogCancel>
            {open === "now" && offerAuto && (
              <Button variant="outline" onClick={() => setOpen("auto")} disabled={busy}>
                {t("pullRequest.autoMerge.button")}
              </Button>
            )}
            <Button onClick={() => void confirm()} disabled={busy || !method}>
              {busy ? <RefreshCw className="animate-spin" /> : <GitMerge />}{" "}
              {open === "auto" ? t("pullRequest.autoMerge.confirm") : method ? t(`pullRequest.merge.methods.${method}.label`) : t("pullRequest.merge.button")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
