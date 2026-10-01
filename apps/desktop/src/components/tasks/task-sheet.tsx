import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNowStrict } from "date-fns";
import { toast } from "sonner";
import { AlignLeft, ArrowUpRight, ChevronRight, EllipsisVertical, GitBranch, GitPullRequestCreateArrow, MessagesSquare, OctagonAlert, Paperclip, Play, RotateCcw, SendHorizontal, Square, Trash2 } from "lucide-react";
import type { Agent, Task, TaskPatch, TaskStatus, Workspace } from "@godmode/shared";
import { MAX_TASK_TITLE_LENGTH, githubBranchUrl } from "@godmode/shared";
import { WorkingTicks } from "@/components/aicss/Motion";
import { Markdown } from "@/components/chat/markdown";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CopyButton } from "@/components/vault/copy-button";
import { toastApiError } from "@/components/vault/vault-utils";
import { AttachmentChip, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, formatBytes, readAttachment, type PendingAttachment } from "@/components/chat/attachments";
import { api } from "@/lib/api";
import { modKey, openExternal } from "@/lib/desktop";
import { draftKeys, saveDraft, useDraft } from "@/lib/drafts";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { DescriptionEditor, withoutPlaceholders, type DescriptionEditorHandle, type TextUpdate } from "./description-editor";
import { AgentSelect, StatusSelect, agentsInReach } from "./task-fields";
import { PullRequestChip, useTaskActivity } from "./task-card";
import { TYPE_META, TypeIcon, isWorking, repoLabel, taskRepoLabel, workspaceRepos } from "./task-meta";
import { TASK_TYPES } from "@godmode/shared";

export function TaskSheet({
  task,
  agents,
  workspaces,
  onClose,
  onMove,
  onDelete,
}: {
  task: Task | null;
  agents: Agent[];
  workspaces: Map<string, Workspace>;
  onClose: () => void;
  onMove: (task: Task, status: TaskStatus) => void;
  onDelete: (task: Task) => void;
}) {
  /** A file is uploading into the description: closing now would lose it (as the new-task dialog). */
  const uploading = useRef(false);
  const close = () => {
    if (uploading.current) {
      toast("Wait for the upload to finish", { description: "The file is still on its way into the description." });
      return;
    }
    onClose();
  };
  return (
    <Sheet open={!!task} onOpenChange={(open) => !open && close()}>
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 outline-none sm:max-w-[40rem]"
        showCloseButton={false}
        // The sheet itself takes the focus, not the first button (which then shows a focus ring for no reason).
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.focus();
        }}
        // Radix sees Esc before the field does: in a text field it cancels that edit and leaves the sheet open.
        onEscapeKeyDown={(e) => {
          if (isTextField(document.activeElement)) e.preventDefault();
        }}
      >
        {task && <TaskDetail
            key={task.id}
            task={task}
            agents={agents}
            workspaces={workspaces}
            onClose={close}
            onUploading={(busy) => (uploading.current = busy)}
            onMove={onMove}
            onDelete={onDelete}
          />}
      </SheetContent>
    </Sheet>
  );
}

function isTextField(el: Element | null): boolean {
  return (
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit"].includes(el.type)) ||
    (el instanceof HTMLElement && el.isContentEditable)
  );
}

/** Property values read as text and turn into a control on hover, as in Linear. */
const PROP_CONTROL = "-ml-2.5 h-8 w-auto max-w-full border-transparent bg-transparent px-2.5 shadow-none hover:bg-accent/60 data-[state=open]:bg-accent/60 dark:bg-transparent";

function TaskDetail({
  task,
  agents,
  workspaces,
  onClose,
  onUploading,
  onMove,
  onDelete,
}: {
  task: Task;
  agents: Agent[];
  workspaces: Map<string, Workspace>;
  onClose: () => void;
  onUploading: (uploading: boolean) => void;
  onMove: (task: Task, status: TaskStatus) => void;
  onDelete: (task: Task) => void;
}) {
  const qc = useQueryClient();
  const workspace = task.workspaceId ? (workspaces.get(task.workspaceId) ?? null) : null;
  const agent = agents.find((a) => a.id === task.agentId);
  const reachable = agentsInReach(agents, task.workspaceId, task.agentId);
  const started = !!task.conversationId;
  const defaultRepo = workspaceRepos(workspace)[0];
  const github = task.branch ? githubBranchUrl(task.repoUrl, task.branch) : null;

  const put = (next: (t: Task) => Task) =>
    qc.setQueriesData<Task[]>({ queryKey: qk.tasks }, (list) => list?.map((x) => (x.id === task.id ? next(x) : x)));
  const save = useMutation({
    mutationFn: (patch: TaskPatch) => api.tasks.update(task.id, patch),
    // Shown right away, not when the server answers. Not the description: its editor shows what it saved itself, and
    // must still tell the saved text from a failed save's (which it gets back as a draft).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onMutate: ({ description, ...patch }) => put((t) => ({ ...t, ...patch })),
    // Only this save's fields: another save still on its way keeps its optimistic value.
    onSuccess: (t, patch) => put((x) => ({ ...x, ...Object.fromEntries(Object.keys(patch).map((k) => [k, t[k as keyof Task]])) })),
    onError: (e) => {
      void qc.invalidateQueries({ queryKey: qk.tasks });
      toastApiError(e, "Could not update the task", qc);
    },
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <span className="flex min-w-0 items-center gap-1.5 truncate text-[13px] text-muted-foreground">
          {workspace ? (
            <>
              <span>{workspace.icon}</span> {workspace.name}
            </>
          ) : (
            "Global"
          )}
        </span>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" />
        <span className="flex shrink-0 items-center gap-1.5 text-[13px] font-medium">
          <TypeIcon type={task.type} className="text-muted-foreground" />
          <span className="font-mono tabular-nums">#{task.number}</span>
        </span>
        <div className="ml-auto flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8" aria-label="More">
                <EllipsisVertical className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {task.conversationId && (
                <DropdownMenuItem asChild>
                  <Link to={`/chat/${task.conversationId}`}>
                    <MessagesSquare /> Open conversation
                  </Link>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem variant="destructive" onClick={() => onDelete(task)}>
                <Trash2 /> Delete task
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="sm" className="h-8 text-muted-foreground" onClick={onClose}>
            Close <kbd className="ml-1 font-mono text-[10px] opacity-60">Esc</kbd>
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-6 px-6 pt-5 pb-8">
          <div className="space-y-1">
            <SheetTitle asChild>
              <EditableTitle value={task.title} onSave={(title) => save.mutate({ title })} />
            </SheetTitle>
            <SheetDescription className="sr-only">Task details</SheetDescription>
            <EditableDescription
              taskId={task.id}
              value={task.description}
              onSave={(description) => save.mutateAsync({ description })}
              onUploading={onUploading}
            />
          </div>

          <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 border-t pt-4 text-sm">
            <Prop label="Status">
              <StatusSelect value={task.status} onChange={(s) => onMove(task, s)} className={PROP_CONTROL} />
            </Prop>
            <Prop label="Agent">
              <AgentSelect agents={reachable} value={task.agentId} onChange={(agentId) => save.mutate({ agentId })} className={PROP_CONTROL} />
            </Prop>
            <Prop label="Type">
              <Select value={task.type} onValueChange={(type) => save.mutate({ type: type as Task["type"] })} disabled={started}>
                <SelectTrigger aria-label="Type" className={cn(PROP_CONTROL, "disabled:opacity-100 disabled:hover:bg-transparent")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  {TASK_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      <TypeIcon type={t} /> {TYPE_META[t].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Prop>
            {(task.type === "coding" || task.branch) && (
              <>
                <Prop label="Repository">
                  {started || task.repoPath ? (
                    <span className="flex h-8 min-w-0 items-center gap-1.5 font-mono text-[13px]" title={task.repoPath || task.repoUrl || undefined}>
                      <span className="truncate">{taskRepoLabel(task, defaultRepo)}</span>
                    </span>
                  ) : (
                    <BlurInput
                      value={task.repoUrl}
                      placeholder={defaultRepo ? (defaultRepo.url ?? defaultRepo.path) : "https://github.com/acme/app.git"}
                      onSave={(repoUrl) => save.mutate({ repoUrl })}
                    />
                  )}
                </Prop>
                <Prop label={task.branch ? "Branch" : "Base branch"}>
                  {task.branch ? (
                    <span className="flex h-8 min-w-0 items-center gap-1.5 font-mono text-[13px]">
                      <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{task.branch}</span>
                      <span className="shrink-0 text-muted-foreground">→ {task.baseBranch}</span>
                      <CopyButton value={task.branch} label="Copy branch name" size="icon-xs" />
                      {github && <GitHubActions task={task} branchUrl={github} />}
                    </span>
                  ) : (
                    <BlurInput
                      value={task.baseBranch}
                      placeholder={defaultRepo?.branch || "default branch"}
                      onSave={(baseBranch) => save.mutate({ baseBranch })}
                    />
                  )}
                </Prop>
                {task.worktree && (
                  <Prop label="Worktree">
                    <span className="flex h-8 min-w-0 items-center gap-1.5 font-mono text-[13px]" title={task.worktree}>
                      <span className="truncate">{task.worktree}</span>
                      <CopyButton value={task.worktree} label="Copy the worktree's path" size="icon-xs" />
                    </span>
                  </Prop>
                )}
              </>
            )}
          </dl>

          <WorkPanel task={task} agent={agent} onMove={onMove} />

          {task.summary && (
            <section className="space-y-2">
              <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {isWorking(task) ? "Previous result" : task.type === "research" ? "Report" : "Result"}
              </h3>
              <div className="rounded-xl border bg-card px-4 py-3 text-sm shadow-card">
                <Markdown>{task.summary}</Markdown>
              </div>
            </section>
          )}

          <p className="text-xs text-muted-foreground">
            Created {format(new Date(task.createdAt), "d MMM yyyy, HH:mm")}
            {task.startedAt && ` · started ${formatDistanceToNowStrict(new Date(task.startedAt), { addSuffix: true })}`}
            {task.completedAt && ` · closed ${formatDistanceToNowStrict(new Date(task.completedAt), { addSuffix: true })}`}
          </p>
        </div>
      </div>

      {started && task.agentId && <FollowUp task={task} agent={agent} />}
    </div>
  );
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/** The branch on GitHub, and a pull request for it. Godmode pushes the branch first when it hasn't yet. */
function GitHubActions({ task, branchUrl }: { task: Task; branchUrl: string }) {
  const qc = useQueryClient();
  const put = (t: Task) => qc.setQueriesData<Task[]>({ queryKey: qk.tasks }, (list) => list?.map((x) => (x.id === t.id ? t : x)));
  const push = useMutation({
    mutationFn: () => api.tasks.push(task.id),
    onSuccess: (t) => {
      put(t);
      void openExternal(branchUrl);
    },
    onError: (e) => toastApiError(e, "Couldn't push the branch", qc),
  });
  const create = useMutation({
    mutationFn: () => api.tasks.openPullRequest(task.id),
    onSuccess: (t) => {
      put(t);
      const pr = t.pullRequest;
      if (pr?.number && pr.state === "open") toast.success(`Pull request #${pr.number} is open`, { action: { label: "View", onClick: () => void openExternal(pr.url) } });
      else if (pr && !pr.number) void openExternal(pr.url);
    },
    onError: (e) => toastApiError(e, "Couldn't create the pull request", qc),
  });
  const pending = push.isPending || create.isPending;
  const idle = pending || (task.status !== "in_progress" && !task.activity);
  const pr = task.pullRequest;
  const icon = "text-muted-foreground hover:text-foreground";

  return (
    <>
      {pr?.state === "merged" ? null : task.branchPushed ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" className={icon} asChild>
              <a href={branchUrl} target="_blank" rel="noreferrer" aria-label="Open the branch on GitHub">
                <GitHubMark />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open on GitHub</TooltipContent>
        </Tooltip>
      ) : (
        idle && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" className={icon} aria-label="Push the branch and open it on GitHub" disabled={pending} onClick={() => push.mutate()}>
                {push.isPending ? <Spinner className="size-3" /> : <GitHubMark />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Push to GitHub and open</TooltipContent>
          </Tooltip>
        )
      )}
      {idle && (!pr || pr.state === "closed") && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="xs" className="ml-auto shrink-0 font-sans" disabled={pending} onClick={() => create.mutate()}>
              {create.isPending ? <Spinner className="size-3" /> : <GitPullRequestCreateArrow />}
              {create.isPending ? "Creating…" : "Create PR"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Push {task.branchPushed ? "the latest changes" : "the branch"} and open a pull request into {task.baseBranch}
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );
}

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className={className}>
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}

/** What the agent is doing, or what the human can do next. */
function WorkPanel({ task, agent, onMove }: { task: Task; agent?: Agent; onMove: (task: Task, status: TaskStatus) => void }) {
  const activity = useTaskActivity(task);
  const working = isWorking(task);

  if (working) {
    return (
      <Panel tone="working">
        <div className="flex items-start gap-3">
          <WorkingTicks className="mt-1.5 text-amber-500" count={10} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{agent ? `${agent.name} is working on it` : "Working on it"}</p>
            <p className="mt-0.5 truncate text-[13px] text-muted-foreground">{activity}</p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {task.conversationId && (
            <Button size="sm" variant="outline" asChild>
              <Link to={`/chat/${task.conversationId}`}>
                <MessagesSquare /> Watch live
              </Link>
            </Button>
          )}
          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => onMove(task, "backlog")}>
            <Square className="size-3.5" /> Stop
          </Button>
        </div>
      </Panel>
    );
  }

  if (task.status === "blocked") {
    return (
      <Panel tone="blocked">
        <div className="flex gap-2.5">
          <OctagonAlert className="mt-0.5 size-4 shrink-0 text-rose-500" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Blocked</p>
            <p className="mt-0.5 text-[13px] whitespace-pre-wrap text-muted-foreground">{task.blockedReason || "Something needs your attention."}</p>
          </div>
        </div>
        {task.agentId && (
          <Button size="sm" className="mt-3" onClick={() => onMove(task, "todo")}>
            <RotateCcw /> Retry
          </Button>
        )}
      </Panel>
    );
  }

  if (task.pullRequest) {
    const pr = task.pullRequest;
    return (
      <Panel>
        <div className="flex items-center gap-3">
          <PullRequestChip task={task} className="h-6 text-xs" />
          <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
            {pr.number ? repoLabel(pr.url.replace(/\/pull\/\d+$/, "")) : `Branch pushed — open the pull request on ${new URL(pr.url).hostname}`}
          </span>
          <Button size="sm" variant={pr.number ? "outline" : "default"} asChild>
            <a href={pr.url} target="_blank" rel="noreferrer">
              {pr.number ? "Review" : "Open pull request"} <ArrowUpRight />
            </a>
          </Button>
        </div>
        {task.status === "in_review" && pr.state === "open" && (
          <p className="mt-2.5 text-xs text-muted-foreground">Moves to Done by itself when the pull request is merged.</p>
        )}
      </Panel>
    );
  }

  if (task.status === "backlog" || task.status === "todo") {
    return (
      <Panel>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[13px] text-muted-foreground">
            {agent
              ? `Ready for ${agent.name}.`
              : task.status === "todo"
                ? "Assign an agent — it starts right away."
                : "Assign an agent and move it to Todo to start it."}
          </p>
          {agent && (
            <Button size="sm" onClick={() => onMove(task, "todo")}>
              <Play /> Start
            </Button>
          )}
        </div>
      </Panel>
    );
  }
  return null;
}

function Panel({ children, tone }: { children: ReactNode; tone?: "working" | "blocked" }) {
  return (
    <section
      className={cn(
        "rounded-xl border bg-card p-4 shadow-card",
        tone === "working" && "border-amber-500/30 bg-amber-500/[0.04]",
        tone === "blocked" && "border-rose-500/30 bg-rose-500/[0.04]",
      )}
    >
      {children}
    </section>
  );
}

function EditableTitle({ value, onSave, ...rest }: { value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);
  const commit = () => {
    const t = draft.replace(/\s+/g, " ").trim();
    if (t && t !== value) onSave(t);
    else setDraft(value);
  };
  return (
    <textarea
      {...rest}
      ref={ref}
      rows={1}
      aria-label="Title"
      maxLength={MAX_TASK_TITLE_LENGTH}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape" && !e.nativeEvent.isComposing) {
          setDraft(value);
          // After the reset renders: the blur must not save the text that was just thrown away.
          const el = e.currentTarget;
          requestAnimationFrame(() => el.blur());
        }
      }}
      className="-mx-2 w-[calc(100%+1rem)] resize-none overflow-hidden rounded-lg bg-transparent px-2 py-1 text-xl leading-snug font-medium tracking-[-0.02em] outline-none hover:bg-accent/50 focus:bg-accent/60"
    />
  );
}

/** Click to edit; leaving the editor saves. Files pasted, dropped or picked are uploaded and linked in the Markdown. */
function EditableDescription({
  taskId,
  value: stored,
  onSave,
  onUploading,
}: {
  taskId: string;
  value: string;
  onSave: (v: string) => Promise<unknown>;
  onUploading: (uploading: boolean) => void;
}) {
  const draftKey = `task:${taskId}:description`;
  const [editing, setEditing] = useState(() => draftKeys(draftKey).length > 0);
  /** Just saved: shown until the task has it, so leaving the editor never shows the old text for a frame. */
  const [saved, setSaved] = useState<string | null>(null);
  if (saved !== null && stored.trim() === saved) setSaved(null);
  const value = saved ?? stored;
  const [draft, setDraft, kept] = useDraft(editing ? draftKey : undefined, value);
  const editor = useRef<DescriptionEditorHandle>(null);
  /** The text's height when editing starts: the editor opens at least that tall, so nothing below jumps. */
  const [shownHeight, setShownHeight] = useState(0);
  const [uploading, setUploading] = useState(false);
  /** Save once the uploads are done (asked to while they ran). */
  const finishLater = useRef(false);
  const setText = useCallback((update: TextUpdate) => setDraft((d) => (typeof update === "function" ? update(d) : update)), [setDraft]);

  const finish = () => {
    // Still uploading (or picking a file): the edit finishes when that's done.
    if (editor.current?.busy()) {
      // Uploading: done when the files are in. Just the file picker: its choice (or not) brings the focus back.
      finishLater.current = editor.current.uploading();
      return;
    }
    finishLater.current = false;
    const next = withoutPlaceholders(draft);
    if (next !== value.trim()) {
      setSaved(next);
      onSave(next).catch(() => {
        // Not saved: the text comes back as a draft in the editor instead of being lost.
        setSaved(null);
        saveDraft(draftKey, next, stored);
        setEditing(true);
      });
    }
    kept.discard();
    setEditing(false);
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    if (!uploading && finishLater.current) finishRef.current();
  }, [uploading]);
  useEffect(() => {
    onUploading(uploading);
    return () => onUploading(false);
  }, [uploading, onUploading]);
  const cancel = () => {
    kept.discard();
    setEditing(false);
  };
  const edit = (shown: HTMLElement) => {
    setShownHeight(shown.getBoundingClientRect().height);
    setEditing(true);
  };

  const empty = !value.trim();
  if (!editing) {
    return (
      <div
        role="button"
        tabIndex={0}
        aria-label={empty ? "Add a description" : "Edit the description"}
        onClick={(e) => {
          // Links and file cards inside do their own thing.
          if ((e.target as HTMLElement).closest("a, button")) return;
          // Selecting text to copy it isn't "edit".
          if (window.getSelection()?.toString()) return;
          edit(e.currentTarget);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.target === e.currentTarget) {
            e.preventDefault();
            edit(e.currentTarget);
          }
        }}
        className="group/desc -mx-3 block min-h-11 cursor-text rounded-xl border border-transparent px-3 py-2.5 text-left transition-colors outline-none hover:border-border/70 hover:bg-card/60 focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        {empty ? (
          <span className="flex items-center gap-2 text-[15px] text-muted-foreground/70">
            <AlignLeft className="size-4 opacity-70" /> Add a description…
            <span className="ml-auto text-xs opacity-0 transition-opacity group-hover/desc:opacity-100">Text, checklists, screenshots, files</span>
          </span>
        ) : (
          <Markdown breaks className="text-[15px]">
            {value}
          </Markdown>
        )}
      </div>
    );
  }
  return (
    <div
      onBlur={(e) => {
        // Switching to another app (to grab a screenshot, say) isn't leaving the editor: it's still there on return.
        if (!document.hasFocus()) return;
        const to = e.relatedTarget as HTMLElement | null;
        // Not a ref: WebKit blurs this box (it was the focused "Add a description" button a moment ago) when the text
        // takes the focus on opening, before refs are set — that must not count as leaving the editor.
        if (e.currentTarget.contains(to)) return;
        // The link field opens in a popover (a portal): still editing.
        if (to?.closest("[data-radix-popper-content-wrapper]")) return;
        finish();
      }}
      // A click on the padding or the border would focus the sheet (and end the edit): it stays in the text.
      onMouseDown={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest(".ProseMirror, button, input, a, [role=button]")) return;
        e.preventDefault();
        if (!target.closest(".ProseMirror")) editor.current?.focus();
      }}
      // Here, not in the editor: Radix has already marked Esc as handled (see onEscapeKeyDown), and ProseMirror skips
      // keys that are. Not from the link popover either (a portal: its Esc closes just the popover).
      onKeyDown={(e) => {
        if (!e.currentTarget.contains(e.target as Node)) return;
        if (e.key === "Escape" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          cancel();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          finish();
        }
      }}
      className="-mx-3 rounded-xl border bg-card shadow-card transition-shadow focus-within:border-ring/60 focus-within:ring-[3px] focus-within:ring-ring/15"
    >
      <DescriptionEditor
        ref={editor}
        autoFocus
        toolbar
        aria-label="Description"
        value={draft}
        onChange={setText}
        onBusyChange={setUploading}
        // The text alone (the toolbar comes on top): at least the text's former height, and room to write.
        minHeight={Math.max(120, shownHeight - 20)}
        placeholder="Details, acceptance criteria, links… Type # for a heading, - for a list, [] for a checklist."
        textClassName="text-[15px]"
        className="px-3 pt-1.5 pb-3"
      />
      {/* Clicks here keep the focus in the text (WebKit doesn't focus buttons), so they don't end the edit. */}
      <div className="flex items-center gap-2 border-t bg-paper-2/60 px-3 py-2 rounded-b-xl" onMouseDown={(e) => e.preventDefault()}>
        <span className="truncate text-xs text-muted-foreground">{uploading ? "Uploading…" : "Paste or drop screenshots and files anywhere in the text"}</span>
        <Button type="button" variant="ghost" size="sm" className="ml-auto h-7 px-2.5 text-xs" onClick={cancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" className="h-7 gap-1.5 px-3 text-xs" onClick={finish} disabled={uploading}>
          {uploading ? <Spinner className="size-3" /> : null}
          Save
          {!uploading && <kbd className="font-sans text-[10px] opacity-60">{modKey}↵</kbd>}
        </Button>
      </div>
    </div>
  );
}

function BlurInput({ value, placeholder, onSave }: { value: string; placeholder: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Input
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft.trim() !== value && onSave(draft.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          setDraft(value);
          // After the state update: the blur must not save the text that was just thrown away.
          const el = e.currentTarget;
          requestAnimationFrame(() => el.blur());
        }
      }}
      className={cn(PROP_CONTROL, "w-full font-mono text-[13px] md:text-[13px] focus-visible:border-input focus-visible:bg-card")}
    />
  );
}

/** Review feedback or an answer for the agent (with files, like a chat); it picks the task up again in the same conversation. */
function FollowUp({ task, agent }: { task: Task; agent?: Agent }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<PendingAttachment[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const send = useMutation({
    mutationFn: () =>
      api.tasks.message(
        task.id,
        text.trim(),
        files.map((f) => ({ name: f.name, mime: f.mime, data: f.data })),
      ),
    onSuccess: () => {
      setText("");
      setFiles((list) => {
        list.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
        return [];
      });
    },
    onError: (e) => toastApiError(e, "Could not send", qc),
  });
  const add = async (picked: File[]) => {
    const fitting = picked.filter((f) => {
      if (f.size <= MAX_ATTACHMENT_BYTES) return true;
      toast.error(`${f.name} is too large`, { description: `Files can be up to ${formatBytes(MAX_ATTACHMENT_BYTES)}.` });
      return false;
    });
    try {
      const read = await Promise.all(fitting.map(readAttachment));
      setFiles((list) => {
        const next = [...list, ...read];
        if (next.length > MAX_ATTACHMENTS) toast.error(`Up to ${MAX_ATTACHMENTS} files per message`);
        next.slice(MAX_ATTACHMENTS).forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
        return next.slice(0, MAX_ATTACHMENTS);
      });
    } catch (err) {
      toast.error("Could not read the file", { description: err instanceof Error ? err.message : String(err) });
    }
  };
  const drop = (f: PendingAttachment) => {
    if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
    setFiles((list) => list.filter((x) => x.id !== f.id));
  };
  const ready = (!!text.trim() || files.length > 0) && !send.isPending;
  const submit = () => ready && send.mutate();
  return (
    <div className="shrink-0 border-t bg-paper-2 p-3">
      <div className="rounded-xl border bg-card p-1.5 shadow-card focus-within:ring-[3px] focus-within:ring-ring/40">
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 px-1.5 pt-1.5 pb-1">
            {files.map((f) => (
              <AttachmentChip
                key={f.id}
                name={f.name}
                mime={f.mime}
                size={f.size}
                previewUrl={f.previewUrl}
                onRemove={() => drop(f)}
              />
            ))}
          </div>
        )}
        <div className="flex items-end gap-1">
          <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground" aria-label="Attach files" onClick={() => input.current?.click()}>
            <Paperclip className="size-4" />
          </Button>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void add([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          <Textarea
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const pasted = [...e.clipboardData.files];
              if (!pasted.length) return;
              e.preventDefault();
              void add(pasted);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") e.currentTarget.blur();
            }}
            placeholder={task.type === "coding" ? `Ask ${agent?.name ?? "the agent"} for changes — the pull request updates` : `Reply to ${agent?.name ?? "the agent"}…`}
            className="max-h-40 min-h-9 resize-none border-0 px-2 py-2 text-sm shadow-none focus-visible:ring-0"
          />
          <Button size="icon" className="size-8 shrink-0" aria-label="Send" disabled={!ready} onClick={submit}>
            {send.isPending ? <Spinner /> : <SendHorizontal className="size-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
