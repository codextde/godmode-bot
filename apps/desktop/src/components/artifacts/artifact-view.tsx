import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { formatDistanceToNowStrict } from "date-fns";
import type { Artifact } from "@godmode/shared";
import {
  ArrowUpRight,
  Check,
  Code2,
  Download,
  Eye,
  History,
  Maximize2,
  MessageSquareText,
  Minimize2,
  MoreHorizontal,
  PanelRightClose,
  Pin,
  PinOff,
  RefreshCw,
  RotateCcw,
  Send,
  Table2,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { CopyButton } from "@/components/chat/copy-button";
import { useTheme } from "@/components/theme-provider";
import { api, errorMessage } from "@/lib/api";
import { isTauri } from "@/lib/core";
import { isMac, saveBlob } from "@/lib/desktop";
import { useArtifact } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useConversationLiveRun } from "@/stores/live";
import { ArtifactFrame, standaloneDocument } from "./artifact-frame";

type Tab = "preview" | "code" | "data";

export function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return `${formatDistanceToNowStrict(new Date(iso))} ago`;
  } catch {
    return "";
  }
}

/** Sends, refreshes, pins and deletes an artifact; the frame's saves go through here too. */
export function useArtifactActions(artifact: Pick<Artifact, "id" | "title" | "agentName"> | undefined) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const id = artifact?.id ?? "";
  const agent = artifact?.agentName ?? "The agent";
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.artifacts });
  const message = useMutation({
    mutationFn: (content: string) => api.artifacts.message(id, content),
    onSuccess: (r) => toast.success(r.queued ? `${agent} gets it right after the current step` : `${agent} is on it`, { description: "It updates here by itself." }),
    onError: (err) => toast.error("Couldn't send it", { description: errorMessage(err) }),
  });
  const refresh = useMutation({
    mutationFn: () => api.artifacts.refresh(id),
    onSuccess: () => toast.success(`${agent} is getting fresh data`),
    onError: (err) => toast.error("Couldn't refresh", { description: errorMessage(err) }),
  });
  const pin = useMutation({
    mutationFn: (pinned: boolean) => api.artifacts.update(id, { pinned }),
    onSuccess: invalidate,
  });
  const restore = useMutation({
    mutationFn: (version: number) => api.artifacts.restore(id, version),
    onSuccess: (a) => {
      void invalidate();
      toast.success(`Restored as version ${a.version}`);
    },
    onError: (err) => toast.error("Couldn't restore it", { description: errorMessage(err) }),
  });
  const remove = useMutation({
    mutationFn: () => api.artifacts.delete(id),
    onSuccess: () => {
      void invalidate();
      toast.success(`Deleted ${artifact?.title ?? "the artifact"}`);
    },
    onError: (err) => toast.error("Couldn't delete it", { description: errorMessage(err) }),
  });
  const saveData = async (data: unknown) => {
    await api.artifacts.saveData(id, { data });
    qc.setQueryData<Artifact>(qk.artifact(id), (old) => (old ? { ...old, data, dataUpdatedAt: new Date().toISOString() } : old));
  };
  return { message, refresh, pin, restore, remove, saveData, navigate };
}

/** The artifact's chat has a run working: the agent is changing it or fetching data. */
export function useArtifactBusy(artifact: Pick<Artifact, "conversationId"> | undefined) {
  return !!useConversationLiveRun(artifact?.conversationId ?? undefined);
}

export function ArtifactView({
  id,
  variant,
  onClose,
  expanded,
  onExpand,
  footer,
}: {
  id: string;
  /** `panel`: next to a chat · `page`: the whole screen. */
  variant: "panel" | "page";
  onClose?: () => void;
  expanded?: boolean;
  onExpand?: (v: boolean) => void;
  footer?: ReactNode;
}) {
  const { data: artifact, isLoading, error } = useArtifact(id);
  const [tab, setTab] = useState<Tab>("preview");
  const [viewing, setViewing] = useState<number | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const actions = useArtifactActions(artifact);
  const busy = useArtifactBusy(artifact);
  const { resolved } = useTheme();

  const versions = useQuery({ queryKey: qk.artifactVersions(id), queryFn: () => api.artifacts.versions(id), enabled: !!artifact });
  const old = useQuery({
    queryKey: qk.artifactVersion(id, viewing ?? 0),
    queryFn: () => api.artifacts.version(id, viewing!),
    enabled: viewing != null,
    staleTime: Infinity,
  });
  // A new version from the agent: show it, and forget an error the old one had.
  useEffect(() => {
    setViewing(null);
    setFailure(null);
  }, [artifact?.version]);

  const html = viewing != null ? old.data?.html : artifact?.html;
  const dataText = useMemo(() => JSON.stringify(artifact?.data ?? null, null, 2), [artifact?.data]);

  if (isLoading) return <ViewSkeleton />;
  if (error || !artifact) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div className="space-y-2">
          <p className="text-sm font-medium">This artifact is gone</p>
          <p className="text-xs text-muted-foreground">It was deleted, or it lives on another computer.</p>
          {onClose && (
            <Button size="sm" variant="outline" onClick={onClose}>
              Close
            </Button>
          )}
        </div>
      </div>
    );
  }

  const agent = artifact.agentName ?? "the agent";
  const download = () =>
    saveBlob(new Blob([standaloneDocument(html ?? artifact.html, artifact.data, resolved)], { type: "text/html" }), `${slug(artifact.title)}.html`);

  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <header className={cn("flex h-14 shrink-0 items-center gap-2 border-b px-3", variant === "panel" && isTauri && isMac && "h-auto pt-7 pb-2")}>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <h2 className="truncate text-sm font-medium tracking-[-0.01em]">{artifact.title}</h2>
            <VersionPicker
              current={artifact.version}
              viewing={viewing}
              versions={versions.data ?? []}
              onPick={(v) => setViewing(v === artifact.version ? null : v)}
            />
          </div>
          <p className="truncate text-[11.5px] text-muted-foreground">
            {busy ? (
              <span className="inline-flex items-center gap-1.5 text-brand-strong">
                <span className="relative flex size-1.5">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand opacity-60" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-brand" />
                </span>
                {agent} is working on it
              </span>
            ) : (
              <>
                Updated {ago(artifact.updatedAt)}
                {artifact.dataUpdatedAt && artifact.dataUpdatedAt !== artifact.updatedAt ? ` · data ${ago(artifact.dataUpdatedAt)}` : ""}
              </>
            )}
          </p>
        </div>

        <Segmented value={tab} onChange={setTab} />

        <IconAction
          label={artifact.refreshPrompt ? "Refresh the data" : "Ask for fresh data"}
          onClick={() => actions.refresh.mutate()}
          disabled={actions.refresh.isPending || busy}
        >
          <RefreshCw className={cn((actions.refresh.isPending || busy) && "animate-spin [animation-duration:1.6s]")} />
        </IconAction>
        {onExpand && (
          <IconAction label={expanded ? "Narrower" : "Wider"} onClick={() => onExpand(!expanded)}>
            {expanded ? <Minimize2 /> : <Maximize2 />}
          </IconAction>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="More">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {variant === "panel" && (
              <DropdownMenuItem asChild>
                <Link to={`/artifacts/${artifact.id}`}>
                  <ArrowUpRight /> Open full screen
                </Link>
              </DropdownMenuItem>
            )}
            {variant === "page" && artifact.conversationId && (
              <DropdownMenuItem asChild>
                <Link to={`/chat/${artifact.conversationId}`}>
                  <MessageSquareText /> Open its chat
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => actions.pin.mutate(!artifact.pinned)}>
              {artifact.pinned ? <PinOff /> : <Pin />} {artifact.pinned ? "Unpin" : "Pin to the top"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void download()}>
              <Download /> Download as HTML
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {onClose && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="-mr-1 size-8 text-muted-foreground" onClick={onClose} aria-label="Close">
                {variant === "panel" ? <PanelRightClose /> : <X />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Close</TooltipContent>
          </Tooltip>
        )}
      </header>

      <AnimatePresence initial={false}>
        {viewing != null && (
          <Bar key="old" tone="muted">
            <History className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              Version {viewing}
              {old.data?.note ? ` · ${old.data.note}` : ""} · {ago(old.data?.createdAt)}
            </span>
            <Button size="xs" variant="ghost" onClick={() => setViewing(null)}>
              Back to latest
            </Button>
            <Button size="xs" onClick={() => actions.restore.mutate(viewing)} disabled={actions.restore.isPending}>
              <RotateCcw /> Restore
            </Button>
          </Bar>
        )}
        {asking && (
          <Bar key="ask" tone="brand">
            <MessageSquareText className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              Send to {agent}: <span className="text-foreground">“{asking}”</span>
            </span>
            <Button size="xs" variant="ghost" onClick={() => setAsking(null)}>
              Not now
            </Button>
            <Button
              size="xs"
              onClick={() => {
                actions.message.mutate(asking);
                setAsking(null);
              }}
            >
              <Send /> Send
            </Button>
          </Bar>
        )}
        {failure && !asking && viewing == null && (
          <Bar key="error" tone="warning">
            <TriangleAlert className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Something broke: {failure}</span>
            <Button size="xs" variant="ghost" onClick={() => setFailure(null)}>
              Dismiss
            </Button>
            <Button
              size="xs"
              disabled={busy}
              onClick={() => {
                actions.message.mutate(`The artifact shows this error, please fix it:\n${failure}`);
                setFailure(null);
              }}
            >
              Ask {agent} to fix it
            </Button>
          </Bar>
        )}
      </AnimatePresence>

      <div className="relative min-h-0 flex-1 bg-background">
        {tab === "preview" &&
          (html == null ? (
            <div className="grid h-full place-items-center">
              <Spinner className="text-muted-foreground" />
            </div>
          ) : (
            <ArtifactFrame
              html={html}
              data={artifact.data}
              title={artifact.title}
              className="h-full w-full"
              onSetData={viewing == null ? actions.saveData : undefined}
              onAsk={setAsking}
              onRefresh={() => actions.refresh.mutate()}
              onError={setFailure}
            />
          ))}
        {tab === "code" && <Source text={html ?? ""} label="HTML" />}
        {tab === "data" && <Source text={dataText} label="Data" hint={artifact.dataUpdatedAt ? `Saved ${ago(artifact.dataUpdatedAt)}` : "No data saved yet"} />}
      </div>

      {footer}

      <DeleteArtifactDialog
        artifact={artifact}
        open={deleting}
        onOpenChange={setDeleting}
        onDeleted={() => {
          onClose?.();
          if (variant === "page") actions.navigate("/artifacts");
        }}
      />
    </div>
  );
}

export function DeleteArtifactDialog({
  artifact,
  open,
  onOpenChange,
  onDeleted,
}: {
  artifact: Pick<Artifact, "id" | "title" | "agentName">;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDeleted?: () => void;
}) {
  const { remove } = useArtifactActions(artifact);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {artifact.title}?</AlertDialogTitle>
          <AlertDialogDescription>Its code, every version and the data saved in it are gone for good. The chat stays.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => remove.mutate(undefined, { onSuccess: onDeleted })}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function slug(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "artifact";
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

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "preview", label: "Preview", icon: <Eye /> },
  { id: "code", label: "Code", icon: <Code2 /> },
  { id: "data", label: "Data", icon: <Table2 /> },
];

function Segmented({ value, onChange }: { value: Tab; onChange: (t: Tab) => void }) {
  return (
    <div role="tablist" aria-label="View" className="hidden items-center gap-0.5 rounded-lg border bg-card p-0.5 @md:flex">
      {TABS.map((t) => (
        <Tooltip key={t.id}>
          <TooltipTrigger asChild>
            <button
              type="button"
              role="tab"
              aria-selected={value === t.id}
              aria-label={t.label}
              onClick={() => onChange(t.id)}
              className={cn(
                "grid size-7 place-items-center rounded-md text-muted-foreground transition outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-3.5",
                value === t.id && "bg-accent text-foreground",
              )}
            >
              {t.icon}
            </button>
          </TooltipTrigger>
          <TooltipContent>{t.label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

function VersionPicker({
  current,
  viewing,
  versions,
  onPick,
}: {
  current: number;
  viewing: number | null;
  versions: { version: number; note: string; createdAt: string }[];
  onPick: (v: number) => void;
}) {
  const shown = viewing ?? current;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "shrink-0 rounded-[5px] border px-1.5 py-px font-mono text-[10.5px] tabular-nums transition hover:bg-accent",
            viewing != null ? "border-warning/40 bg-warning/10 text-warning" : "bg-card text-muted-foreground",
          )}
          aria-label="Versions"
        >
          v{shown}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Versions</DropdownMenuLabel>
        {versions.map((v) => (
          <DropdownMenuItem key={v.version} onSelect={() => onPick(v.version)} className="items-start gap-2.5">
            <span className="mt-px w-7 shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">v{v.version}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px]">{v.note || (v.version === 1 ? "First version" : "Changed")}</span>
              <span className="block text-[11px] text-muted-foreground">{ago(v.createdAt)}</span>
            </span>
            {v.version === shown && <Check className="mt-0.5 size-3.5 text-brand-strong" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Bar({ tone, children }: { tone: "muted" | "brand" | "warning"; children: ReactNode }) {
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="shrink-0 overflow-hidden"
    >
      <div
        className={cn(
          "flex items-center gap-2 border-b px-3 py-1.5 text-xs",
          tone === "muted" && "bg-muted/60 text-muted-foreground",
          tone === "brand" && "bg-brand-soft text-brand-strong",
          tone === "warning" && "bg-warning/10 text-warning",
        )}
      >
        {children}
      </div>
    </motion.div>
  );
}

function Source({ text, label, hint }: { text: string; label: string; hint?: string }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-paper-2 px-3 text-[11.5px] text-muted-foreground">
        <span className="font-medium text-foreground">{label}</span>
        <span>
          {lines.length.toLocaleString()} lines{hint ? ` · ${hint}` : ""}
        </span>
        <CopyButton text={text} label={`Copy ${label.toLowerCase()}`} className="ml-auto" />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <pre className="min-w-max py-2 font-mono text-[12px] leading-[1.6]">
          {lines.map((line, i) => (
            <div key={i} className="flex hover:bg-accent/40">
              <span className="w-12 shrink-0 pr-3 text-right text-muted-foreground/50 tabular-nums select-none">{i + 1}</span>
              <span className="pr-4 whitespace-pre">{line || " "}</span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

function ViewSkeleton() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-3 border-b px-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="ml-auto h-7 w-24" />
      </div>
      <div className="grid flex-1 grid-cols-3 content-start gap-3 p-5">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="col-span-3 h-56" />
      </div>
    </div>
  );
}
