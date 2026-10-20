import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, FolderOpen, HardDriveDownload, Moon } from "lucide-react";
import type { Agent, FileReviewItem } from "@godmode/shared";
import { api } from "@/lib/api";
import { useAgents, useAllAgents } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { useAgentRunning } from "@/stores/live";
import { cn } from "@/lib/utils";
import { AgentAvatar, EmptyState, PageBody, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import { useDreamingNow } from "@/components/agents/detail/dreams-panel";
import { BrowsePane } from "@/components/files/browse-pane";
import { BinPane, useBin } from "@/components/files/bin-pane";
import { DetailPane } from "@/components/files/detail-pane";
import { DeleteDialog, MoveDialog, NameDialog, type NameDialogMode } from "@/components/files/dialogs";
import { NOTE_FILE, parentOf } from "@/components/files/file-editor";
import { NotesPane } from "@/components/files/notes-pane";
import { FilesOverview } from "@/components/files/overview";
import { ReviewPane, useFileReview } from "@/components/files/review-pane";
import { useRefreshFiles, useReveal } from "@/components/files/use-files";

type Tab = "browse" | "notes" | "review" | "bin";
const TABS: Tab[] = ["browse", "notes", "review", "bin"];

const DESCRIPTION = "Look through what your agents keep — their workspace, notes and memory — and clean it up. Deleted files wait 30 days in a bin.";

export default function FilesPage() {
  const { agentId } = useParams();
  const scoped = useAgents();
  const everyone = useAllAgents();
  const agent = everyone.data?.find((a) => a.id === agentId) ?? scoped.data?.find((a) => a.id === agentId);

  if (!agentId) {
    return (
      <>
        <PageHeader title="Files" description={DESCRIPTION} icon={<FolderOpen />} actions={<CleanupLink />} />
        <PageBody>{scoped.isLoading ? <OverviewSkeleton /> : <FilesOverview agents={scoped.data ?? []} />}</PageBody>
      </>
    );
  }
  if (everyone.isLoading) {
    return (
      <>
        <PageHeader title="Files" icon={<FolderOpen />} />
        <PageBody>
          <Skeleton className="h-[28rem] rounded-xl" />
        </PageBody>
      </>
    );
  }
  if (!agent) {
    return (
      <>
        <PageHeader title="Files" icon={<FolderOpen />} />
        <PageBody>
          <EmptyState icon={<FolderOpen />} title="This agent doesn't exist anymore" action={<Button asChild variant="outline"><Link to="/files">All agents</Link></Button>} />
        </PageBody>
      </>
    );
  }
  return <AgentFiles key={agent.id} agent={agent} agents={everyone.data ?? []} />;
}

function CleanupLink() {
  return (
    <Button asChild variant="outline" size="sm">
      <Link to="/settings/cleanup">
        <HardDriveDownload /> Cleanup settings
      </Link>
    </Button>
  );
}

function OverviewSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-36 rounded-xl" />
      ))}
    </div>
  );
}

function AgentPicker({ agent, agents, onPick }: { agent: Agent; agents: Agent[]; onPick: (id: string) => void }) {
  const sorted = useMemo(() => [...agents].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name)), [agents]);
  return (
    <Select value={agent.id} onValueChange={onPick}>
      <SelectTrigger className="h-9 w-64 bg-card" aria-label="Agent">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-80">
        {sorted.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            <span className="flex items-center gap-2">
              <AgentAvatar agent={a} size="sm" still />
              <span className="truncate">{a.name}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function AgentFiles({ agent, agents }: { agent: Agent; agents: Agent[] }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t === params.get("tab")) ?? "browse") as Tab;
  const dir = params.get("dir") ?? "workspace";
  const filePath = params.get("file");
  const [fileSize, setFileSize] = useState(0);
  const file = filePath ? { path: filePath, size: fileSize } : null;
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [deleting, setDeleting] = useState<string[] | null>(null);
  const [moving, setMoving] = useState<string[] | null>(null);
  const [naming, setNaming] = useState<NameDialogMode | null>(null);
  const dreaming = useDreamingNow(agent.id);
  const working = useAgentRunning(agent.id);
  const refresh = useRefreshFiles(agent.id);
  const reveal = useReveal(agent.repoPath);
  const review = useFileReview(agent.id);
  const bin = useBin(agent.id);
  const namingDir = naming ? (naming.kind === "rename" ? parentOf(naming.path) : naming.dir) : dir;
  const listing = useQuery({ queryKey: qk.agentFiles(agent.id, namingDir), queryFn: () => api.agents.files(agent.id, namingDir), enabled: !!naming });
  const siblings = listing.data ? listing.data.map((e) => e.path.slice(e.path.lastIndexOf("/") + 1)) : null;
  const reviewCount = review.data?.items.length ?? 0;
  const binCount = bin.data?.length ?? 0;

  const update = useCallback(
    (next: Partial<Record<"tab" | "dir" | "file", string | null>>, replace = true) =>
      setParams(
        (p) => {
          const q = new URLSearchParams(p);
          for (const [k, v] of Object.entries(next)) {
            if (v === null || v === undefined || (k === "tab" && v === "browse") || (k === "dir" && v === "workspace")) q.delete(k);
            else q.set(k, v);
          }
          return q;
        },
        { replace },
      ),
    [setParams],
  );

  /** Leave unsaved edits only after asking. */
  const guard = (go: () => void) => (dirty ? setPending(() => go) : go());
  /** Open a file (and the folder it lies in, in the same URL change: two changes in one tick would undo each other). */
  const openFile = (path: string, size = 0, inDir?: string) =>
    guard(() => {
      setFileSize(size);
      update(inDir === undefined ? { file: path } : { file: path, dir: inDir });
    });
  const affectsOpenFile = (paths: string[]) => !!filePath && paths.some((p) => filePath === p || filePath.startsWith(`${p}/`));
  /** Rename, move or delete of the open file: its unsaved edits would be lost, so ask first. */
  const guardOpen = (paths: string[], go: () => void) => (affectsOpenFile(paths) ? guard(go) : go());
  const setTab = (t: Tab) => update({ tab: t }, false);
  const setDir = (d: string) => update({ dir: d }, false);

  const afterDelete = (paths: string[]) => {
    const patch: Partial<Record<"dir" | "file", string | null>> = {};
    if (affectsOpenFile(paths)) {
      setDirty(false);
      patch.file = null;
    }
    const gone = paths.find((p) => dir === p || dir.startsWith(`${p}/`));
    if (gone !== undefined) patch.dir = parentOf(gone) || "workspace";
    if (Object.keys(patch).length) update(patch);
  };
  const afterMove = (moves: { from: string; to: string }[]) => {
    const patch: Partial<Record<"dir" | "file", string | null>> = {};
    for (const m of moves) {
      if (filePath === m.from) patch.file = m.to;
      else if (filePath?.startsWith(`${m.from}/`)) patch.file = `${m.to}${filePath.slice(m.from.length)}`;
      if (dir === m.from || dir.startsWith(`${m.from}/`)) patch.dir = `${m.to}${dir.slice(m.from.length)}`;
    }
    if (Object.keys(patch).length) {
      if (patch.file !== undefined) setDirty(false);
      update(patch);
    }
  };

  const fileActions = {
    onRename: (path: string) => guardOpen([path], () => setNaming({ kind: "rename", path })),
    onMove: (paths: string[]) => guardOpen(paths, () => setMoving(paths)),
    onDelete: (paths: string[]) => guardOpen(paths, () => setDeleting(paths)),
    onReveal: reveal,
    onOpenFile: (path: string) => openFile(path),
    onSaved: () => refresh(),
  };
  const openReviewItem = (item: FileReviewItem) => {
    if (item.kind === "broken-link" && item.related) return openFile(item.related);
    if (item.type === "dir") {
      guard(() => update({ tab: null, dir: item.path, file: null }));
      return;
    }
    openFile(item.path, item.bytes);
  };

  return (
    <>
      <PageHeader
        title="Files"
        description={DESCRIPTION}
        icon={<FolderOpen />}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => guard(() => navigate("/files"))}>
              <ArrowLeft /> All agents
            </Button>
            <AgentPicker agent={agent} agents={agents} onPick={(id) => guard(() => navigate(`/files/${id}`))} />
          </>
        }
      />
      <PageBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Tabs value={tab} onValueChange={(v) => guard(() => setTab(v as Tab))}>
            <TabsList>
              <TabsTrigger value="browse" className="px-3">
                Browse
              </TabsTrigger>
              <TabsTrigger value="notes" className="px-3">
                Notes
              </TabsTrigger>
              <TabsTrigger value="review" className="gap-1.5 px-3">
                Review
                {reviewCount > 0 && <span className="rounded-[4px] bg-warning/12 px-1.5 font-mono text-[10px] font-medium text-warning tabular-nums">{reviewCount}</span>}
              </TabsTrigger>
              <TabsTrigger value="bin" className="gap-1.5 px-3">
                Bin
                {binCount > 0 && <span className="rounded-[4px] bg-foreground/[0.06] px-1.5 font-mono text-[10px] text-muted-foreground tabular-nums">{binCount}</span>}
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {dreaming ? (
            <p className="flex items-center gap-1.5 rounded-md bg-dream-soft px-2.5 py-1 text-xs text-muted-foreground" role="status">
              <Moon className="size-3.5 text-dream" /> {agent.name} is dreaming — moves and deletes wait until the dream has ended.
            </p>
          ) : working ? (
            <p className="flex items-center gap-1.5 rounded-md bg-warning/[0.08] px-2.5 py-1 text-xs text-muted-foreground" role="status">
              <span className="size-1.5 animate-pulse rounded-full bg-warning" /> {agent.name} is working right now and may still use files here.
            </p>
          ) : null}
        </div>

        <div className={cn("grid h-[calc(100svh-15rem)] min-h-[30rem] gap-4", tab === "bin" ? "grid-cols-1" : "grid-cols-1 @4xl:grid-cols-[minmax(340px,5fr)_minmax(0,7fr)]")}>
          <section className={cn("min-h-0 overflow-hidden rounded-xl border bg-card shadow-card", file && tab !== "bin" && "@max-4xl:hidden")}>
            {tab === "browse" && (
              <BrowsePane
                agent={agent}
                dir={dir}
                onDir={(d) => setDir(d)}
                selected={filePath}
                onSelect={(e, inDir) => openFile(e.path, e.size, inDir)}
                frozen={dreaming}
                actions={{ ...fileActions, onNew: (kind, d) => setNaming({ kind, dir: d }) }}
              />
            )}
            {tab === "notes" && <NotesPane agent={agent} selected={filePath} onSelect={(n) => openFile(n.path, n.bytes)} />}
            {tab === "review" && <ReviewPane agent={agent} selected={filePath} frozen={dreaming} actions={{ onOpen: openReviewItem, onDelete: fileActions.onDelete, onMove: fileActions.onMove }} />}
            {tab === "bin" && <BinPane agent={agent} frozen={dreaming} />}
          </section>
          {tab !== "bin" && (
            <section className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-card", !file && "@max-4xl:hidden")}>
              {file && (
                <button type="button" onClick={() => guard(() => update({ file: null }))} className="flex items-center gap-1.5 border-b px-3 py-2 text-xs text-muted-foreground hover:text-foreground @4xl:hidden">
                  <ArrowLeft className="size-3.5" /> Back to the list
                </button>
              )}
              <div className="min-h-0 flex-1">
                <DetailPane
                  agent={agent}
                  file={file}
                  dreaming={dreaming}
                  frozen={dreaming}
                  defaultView={tab === "notes" || (file && NOTE_FILE.test(file.path) && tab === "review") ? "preview" : "edit"}
                  onDirtyChange={setDirty}
                  actions={fileActions}
                />
              </div>
            </section>
          )}
        </div>
      </PageBody>

      <DeleteDialog agentId={agent.id} agentName={agent.name} paths={deleting} onClose={() => setDeleting(null)} onDeleted={afterDelete} />
      <MoveDialog agentId={agent.id} paths={moving} onClose={() => setMoving(null)} onMoved={afterMove} />
      <NameDialog
        agentId={agent.id}
        mode={naming}
        siblings={siblings}
        onClose={() => setNaming(null)}
        onRenamed={(from, to) => afterMove([{ from, to }])}
        onCreated={(path, kind) => {
          refresh();
          if (kind === "note") openFile(path);
        }}
      />
      <AlertDialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>Your edits to {filePath} haven't been saved.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setDirty(false);
                pending?.();
                setPending(null);
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
