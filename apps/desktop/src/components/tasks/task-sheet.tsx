import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNowStrict } from "date-fns";
import { toast } from "sonner";
import {
  AlarmClock,
  AlarmClockOff,
  AlignLeft,
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  Check,
  ChevronRight,
  CornerDownRight,
  EllipsisVertical,
  GitBranch,
  GitPullRequestCreateArrow,
  Hourglass,
  ListTree,
  MessageSquareReply,
  MessagesSquare,
  OctagonAlert,
  Paperclip,
  Pause,
  Play,
  RotateCcw,
  SendHorizontal,
  Square,
  Target,
  Trash2,
} from "lucide-react";
import type { Agent, Task, TaskEvent, TaskPatch, TaskStatus, Workspace } from "@godmode/shared";
import { MAX_TASK_TITLE_LENGTH, githubBranchUrl, isWaiting, reopenStatus, waitsForTickets } from "@godmode/shared";
import { WorkingTicks } from "@/components/aicss/Motion";
import { Markdown } from "@/components/chat/markdown";
import { ChatFilesScope } from "@/components/chat/local-files";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
import { useGoals, useQuestions, useTasks } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { QuestionCard, viewOfQuestion } from "@/components/chat/question-card";
import { cn } from "@/lib/utils";
import { DescriptionEditor, withoutPlaceholders, type DescriptionEditorHandle, type TextUpdate } from "./description-editor";
import { AgentSelect, DueDateField, LabelsInput, PrioritySelect, StatusSelect, agentsInReach } from "./task-fields";
import { TaskTimeline } from "./task-timeline";
import { TaskDialog } from "./task-dialog";
import { PullRequestChip, useTaskActivity } from "./task-card";
import { BLOCKED_META, StatusIcon, TYPE_META, TypeIcon, formatCost, formatWork, isWorking, pauseLabel, repoLabel, taskRepoLabel, workspaceRepos } from "./task-meta";
import { followupWhen, useFollowupActions } from "@/components/chat/followup";
import { useNow } from "@/components/vault/use-now";
import { usePauseActions } from "@/components/chat/pause";
import { TASK_TYPES } from "@godmode/shared";

export function TaskSheet({
  task,
  agents,
  workspaces,
  onClose,
  onMove,
  onArchive,
  onDelete,
  onReassign,
}: {
  task: Task | null;
  agents: Agent[];
  workspaces: Map<string, Workspace>;
  onClose: () => void;
  onMove: (task: Task, status: TaskStatus) => void;
  onArchive: (task: Task, archived: boolean) => void;
  onDelete: (task: Task) => void;
  onReassign: (task: Task, agentId: string | null) => void;
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
            onArchive={onArchive}
            onDelete={onDelete}
            onReassign={onReassign}
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

/**
 * A ticket split into parts: the bigger ticket it belongs to, and its own parts with where each one stands. The parent
 * waits until its parts are delivered, done, cancelled or archived; then its agent continues with their results.
 */
function PartsSection({ task, board, agents, workspaces }: { task: Task; board: Task[]; agents: Agent[]; workspaces: Map<string, Workspace> }) {
  const [adding, setAdding] = useState(false);
  const parent = task.parentId ? board.find((t) => t.id === task.parentId) : undefined;
  const parts = board.filter((t) => t.parentId === task.id).sort((a, b) => a.number - b.number);
  const hidden = (task.subtasks?.total ?? 0) - parts.length;
  const closed = task.status === "done" || task.status === "cancelled" || !!task.archivedAt;
  if (!task.parentNumber && !parts.length && closed) return null;
  // Where the core would refuse a part: 3 levels deep, 20 parts, or a ticket that won't wait for it (delivered or settled).
  let depth = 1;
  for (let up = task.parentId; up && depth < 4; depth++) up = board.find((t) => t.id === up)?.parentId ?? null;
  const canAdd = !closed && task.status !== "in_review" && depth < 3 && (task.subtasks?.total ?? 0) < 20;
  return (
    <section className="space-y-2" aria-labelledby={`parts-${task.id}`}>
      <div className="flex items-center gap-2">
        <h3 id={`parts-${task.id}`} className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {parts.length ? `Parts · ${(task.subtasks?.total ?? 0) - (task.subtasks?.open ?? 0)} of ${task.subtasks?.total ?? parts.length} finished` : "Parts"}
        </h3>
        {canAdd && (
          <Button size="xs" variant="ghost" className="ml-auto text-muted-foreground" onClick={() => setAdding(true)}>
            <ListTree /> Add a part
          </Button>
        )}
      </div>
      {task.parentNumber && (
        <p className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
          <CornerDownRight className="size-3.5 shrink-0" aria-hidden />
          Part of{" "}
          <Link to={`/tasks?task=${task.parentId}`} className="min-w-0 truncate font-medium text-foreground underline-offset-2 hover:underline">
            #{task.parentNumber} {parent?.title ?? ""}
          </Link>
        </p>
      )}
      {parts.length > 0 && (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-card">
          {parts.map((p) => {
            const who = agents.find((a) => a.id === p.agentId);
            return (
              <li key={p.id}>
                <Link to={`/tasks?task=${p.id}`} className="flex min-w-0 items-center gap-2.5 px-3 py-2 text-[13px] transition hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none">
                  <StatusIcon status={p.status} className="size-3.5 shrink-0" />
                  <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">#{p.number}</span>
                  <span className="min-w-0 flex-1 truncate">{p.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{who?.name ?? "Unassigned"}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {hidden > 0 && <p className="text-xs text-muted-foreground">{hidden === 1 ? "1 more part is archived." : `${hidden} more parts are archived.`}</p>}
      {!parts.length && !task.parentNumber && (
        <p className="text-xs text-muted-foreground">Split the work: each part is a ticket of its own, and this one waits until they're finished.</p>
      )}
      <TaskDialog
        open={adding}
        onOpenChange={setAdding}
        workspaces={[...workspaces.values()]}
        agents={agents}
        defaultWorkspaceId={task.workspaceId}
        parent={task}
      />
    </section>
  );
}

function TaskDetail({
  task,
  agents,
  workspaces,
  onClose,
  onUploading,
  onMove,
  onArchive,
  onDelete,
  onReassign,
}: {
  task: Task;
  agents: Agent[];
  workspaces: Map<string, Workspace>;
  onClose: () => void;
  onUploading: (uploading: boolean) => void;
  onMove: (task: Task, status: TaskStatus) => void;
  onArchive: (task: Task, archived: boolean) => void;
  onDelete: (task: Task) => void;
  onReassign: (task: Task, agentId: string | null) => void;
}) {
  const qc = useQueryClient();
  const { data: board = [] } = useTasks("all");
  const labelsInUse = [...new Set(board.flatMap((t) => t.labels))].sort((a, b) => a.localeCompare(b));
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
    // Nor what it waits for: the server answers with the tickets' numbers and titles.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onMutate: ({ description, waitsFor, ...patch }) => put((t) => ({ ...t, ...patch })),
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
                    <MessagesSquare /> Open chat
                  </Link>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => onArchive(task, !task.archivedAt)}>
                {task.archivedAt ? <ArchiveRestore /> : <Archive />} {task.archivedAt ? "Restore to the board" : "Archive task"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
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

      {task.archivedAt && (
        <div className="flex shrink-0 items-center gap-3 border-b bg-foreground/[0.025] px-6 py-2.5">
          <Archive className="size-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 text-[13px] text-muted-foreground">
            <span className="font-medium text-foreground">Archived</span> {formatDistanceToNowStrict(new Date(task.archivedAt), { addSuffix: true })} — off the
            board, nothing is lost.
          </p>
          <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={() => onArchive(task, false)}>
            <ArchiveRestore /> Restore
          </Button>
        </div>
      )}

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
              <AgentSelect agents={reachable} value={task.agentId} onChange={(agentId) => onReassign(task, agentId)} className={PROP_CONTROL} />
            </Prop>
            <Prop label="Priority">
              <PrioritySelect value={task.priority} onChange={(priority) => save.mutate({ priority })} className={PROP_CONTROL} />
            </Prop>
            <Prop label="Due date">
              <DueDateField value={task.dueDate} status={task.status} onChange={(dueDate) => save.mutate({ dueDate })} />
            </Prop>
            <Prop label="Waits for">
              <WaitsForField task={task} board={board} onChange={(waitsFor) => save.mutate({ waitsFor })} />
            </Prop>
            <Prop label="Goal">
              <GoalSelect task={task} onChange={(goalId) => save.mutate({ goalId })} className={PROP_CONTROL} />
            </Prop>
            <Prop label="Labels">
              <LabelsInput value={task.labels} onChange={(labels) => save.mutate({ labels })} suggestions={labelsInUse} />
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

          <WorkPanel
            task={task}
            agent={agent}
            onMove={onMove}
            onReason={(blockedReason) => save.mutate({ blockedReason })}
            onStartWithoutWaiting={() => save.mutate({ waitsFor: task.waitsFor.filter((w) => w.finished).map((w) => w.id) })}
          />

          <PartsSection task={task} board={board} agents={agents} workspaces={workspaces} />

          {task.summary && (
            <section className="space-y-2">
              <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {isWorking(task) ? "Previous result" : task.type === "research" ? "Report" : "Result"}
              </h3>
              <div className="rounded-xl border bg-card px-4 py-3 text-sm shadow-card">
                <ChatFilesScope conversationId={task.conversationId}>
                  <Markdown>{task.summary}</Markdown>
                </ChatFilesScope>
              </div>
            </section>
          )}

          <TaskTimeline task={task} agents={agents} />

          <p className="text-xs text-muted-foreground">
            Filed by {task.createdBy === "user" ? "you" : (agents.find((a) => `agent:${a.id}` === task.createdBy)?.name ?? "an agent")} on{" "}
            {format(new Date(task.createdAt), "d MMM yyyy, HH:mm")}
            {task.runCount > 0 &&
              ` · ${agent?.name ?? "The agent"} worked ${formatWork(task.workMs)} in ${task.runCount} run${task.runCount === 1 ? "" : "s"} · ${formatCost(task.costUsd)}${
                isWorking(task) ? " so far" : ""
              }`}
            {task.completedAt && ` · closed ${formatDistanceToNowStrict(new Date(task.completedAt), { addSuffix: true })}`}
          </p>
        </div>
      </div>

      {started && task.agentId && !task.archivedAt && <FollowUp task={task} agent={agent} />}
    </div>
  );
}

/** Tickets this one waits for: it starts once each is delivered. Chips to remove, a picker to add (no loops: the core says). */
function WaitsForField({ task, board, onChange }: { task: Task; board: Task[]; onChange: (ids: string[]) => void }) {
  const ADD = "add";
  const ids = task.waitsFor.map((w) => w.id);
  const choices = board.filter((t) => t.id !== task.id && !ids.includes(t.id) && t.status !== "done" && t.status !== "cancelled").sort((a, b) => b.number - a.number);
  return (
    <span className="flex min-h-8 flex-wrap items-center gap-1">
      {task.waitsFor.map((w) => (
        <span key={w.id} className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs", w.finished && "text-muted-foreground line-through decoration-foreground/30")} title={w.title}>
          #{w.number} <span className="max-w-32 truncate">{w.title}</span>
          <button type="button" className="text-muted-foreground hover:text-foreground" aria-label={`Stop waiting for #${w.number}`} onClick={() => onChange(ids.filter((id) => id !== w.id))}>
            ×
          </button>
        </span>
      ))}
      {choices.length > 0 && ids.length < 10 && (
        <Select value={ADD} onValueChange={(v) => v !== ADD && onChange([...ids, v])}>
          <SelectTrigger aria-label="Wait for another ticket" className="h-7 w-auto gap-1 border-dashed px-2 text-xs text-muted-foreground">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" className="max-h-72">
            <SelectItem value={ADD} disabled>
              {ids.length ? "Also wait for…" : "Wait for a ticket…"}
            </SelectItem>
            {choices.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                #{t.number} {t.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {!ids.length && !choices.length && <span className="text-xs text-muted-foreground">Nothing</span>}
    </span>
  );
}

/** The goal a ticket serves — active ones of its workspace and global ones (a part serves its ticket's). */
function GoalSelect({ task, onChange, className }: { task: Task; onChange: (goalId: string | null) => void; className?: string }) {
  const { data: goals = [] } = useGoals(task.workspaceId ?? "global");
  const NONE = "none";
  const choices = goals.filter((g) => g.status === "active" || g.id === task.goalId);
  return (
    <Select value={task.goalId ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)} disabled={!!task.parentId}>
      <SelectTrigger aria-label="Goal" className={cn(className, "disabled:opacity-100 disabled:hover:bg-transparent")} title={task.parentId ? "A part serves its ticket's goal" : undefined}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        <SelectItem value={NONE}>
          <span className="text-muted-foreground">No goal</span>
        </SelectItem>
        {choices.map((g) => (
          <SelectItem key={g.id} value={g.id}>
            <Target className="size-3.5 text-brand-strong" /> {g.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
function WorkPanel({
  task,
  agent,
  onMove,
  onReason,
  onStartWithoutWaiting,
}: {
  task: Task;
  agent?: Agent;
  onMove: (task: Task, status: TaskStatus) => void;
  onReason: (reason: string) => void;
  /** Drop what it waits for (it starts then). */
  onStartWithoutWaiting: () => void;
}) {
  const qc = useQueryClient();
  const activity = useTaskActivity(task);
  const working = isWorking(task);
  const { resume } = usePauseActions(task.conversationId ?? "");
  const followups = useFollowupActions();
  const { data: open = [] } = useQuestions("open");
  const who = agent?.name ?? "The agent";
  const publish = useMutation({
    mutationFn: () => api.tasks.openPullRequest(task.id),
    onSuccess: (t) => qc.setQueriesData<Task[]>({ queryKey: qk.tasks }, (list) => list?.map((x) => (x.id === t.id ? t : x))),
    onError: (e) => toastApiError(e, "Couldn't publish", qc),
  });
  const approve = (t: Task) => {
    onMove(t, "done");
    toast.success(`#${t.number} approved`, { action: { label: "Undo", onClick: () => onMove(t, "in_review") } });
  };
  const reopen = (t: Task) => {
    const back = reopenStatus(t);
    onMove(t, back);
    toast(`#${t.number} reopened`, { action: { label: "Undo", onClick: () => onMove(t, t.status) } });
  };

  if (task.pause?.reason === "question" && task.status === "in_progress") {
    const question = open.find((q) => q.id === task.pause!.question?.id);
    return (
      <Panel>
        {question ? (
          <QuestionCard question={viewOfQuestion(question)} agentName={agent?.name} answerable inline conversationId={task.conversationId ?? undefined} className="shadow-none" />
        ) : (
          <p className="text-sm font-medium">{task.pause.question?.kind === "approval" ? `${agent?.name ?? "The agent"} needs your OK` : `${agent?.name ?? "The agent"} is waiting for your answer`}</p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {task.conversationId && (
            <Button size="sm" variant="outline" asChild>
              <Link to={`/chat/${task.conversationId}`}>
                <MessagesSquare /> Open chat
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

  if (pauseLabel(task) && task.pause) {
    const { pause } = task;
    const who = agent?.name ?? "The agent";
    return (
      <Panel>
        <div className="flex items-start gap-3">
          {pause.reason === "limit" ? <Hourglass className="mt-0.5 size-4 shrink-0 text-warning" /> : <Pause className="mt-0.5 size-4 shrink-0 fill-current text-foreground/70" />}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{pause.reason === "limit" ? `Claude's ${pause.limit ?? "usage limit"} is reached` : "Paused"}</p>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              {pause.reason === "user"
                ? `${who} picks the work up where it stopped.`
                : pause.auto && pause.resumeAt
                  ? `${who} continues by itself ${followupWhen(pause.resumeAt)}, where it stopped.`
                  : pause.resumeAt
                    ? `The limit resets ${followupWhen(pause.resumeAt)} — continue it then.`
                    : "Continue it when the limit has reset."}
            </p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant={pause.reason === "limit" ? "outline" : "default"} disabled={resume.isPending} onClick={() => resume.mutate()}>
            {resume.isPending ? <Spinner /> : <Play className="fill-current" />} {pause.reason === "limit" ? "Continue now" : "Continue"}
          </Button>
          {task.conversationId && (
            <Button size="sm" variant="outline" asChild>
              <Link to={`/chat/${task.conversationId}`}>
                <MessagesSquare /> Open chat
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

  if (working) {
    return (
      <Panel tone="working">
        <div className="flex items-start gap-3">
          <WorkingTicks className="mt-1.5 text-amber-500" count={10} />
          <div className="min-w-0 flex-1">
            <p className="flex items-baseline justify-between gap-2 text-sm font-medium" aria-live="polite">
              <span>{agent ? `${agent.name} is working on it` : "Working on it"}</span>
              {task.runStartedAt && task.runStatus === "running" && <Elapsed since={task.runStartedAt} className="text-xs font-normal text-muted-foreground" />}
            </p>
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

  if (isWaiting(task) && task.followup) {
    const f = task.followup;
    return (
      <Panel>
        <div className="flex items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-brand/25 bg-brand-soft text-brand-strong">
            <AlarmClock className="size-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium" aria-live="polite">
              Waiting — continues {followupWhen(f.dueAt)}
            </p>
            {f.note && (
              <p className="mt-0.5 line-clamp-2 text-[13px] text-muted-foreground" title={f.note}>
                {who}'s plan: {f.note}
              </p>
            )}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" disabled={followups.runNow.isPending} onClick={() => task.conversationId && followups.runNow.mutate(task.conversationId)}>
            {followups.runNow.isPending ? <Spinner /> : <Play className="fill-current" />} Continue now
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="outline" disabled={followups.cancel.isPending} onClick={() => task.conversationId && followups.cancel.mutate(task.conversationId)}>
                <AlarmClockOff /> Cancel follow-up
              </Button>
            </TooltipTrigger>
            <TooltipContent>{who} won't continue on its own — the task goes to In review</TooltipContent>
          </Tooltip>
          {task.conversationId && (
            <Button size="sm" variant="ghost" asChild>
              <Link to={`/chat/${task.conversationId}`}>
                <MessagesSquare /> Open chat
              </Link>
            </Button>
          )}
        </div>
      </Panel>
    );
  }

  if (task.status === "blocked") {
    const kind = task.blockedKind;
    const meta = kind ? BLOCKED_META[kind] : null;
    const reason = task.blockedReason || (kind === "manual" ? "" : "Something needs your attention.");
    const advice =
      kind === "failed" && /timed out/i.test(reason)
        ? "It hit the run's time limit. Try again, or split the task into smaller ones."
        : kind === "failed" && /cost budget/i.test(reason)
          ? `It reached its cost budget. Raise ${who}'s budget, then try again.`
          : null;
    const restart = (label: string, icon = <RotateCcw />) =>
      task.agentId ? (
        <Button size="sm" onClick={() => onMove(task, "todo")}>
          {icon} {label}
        </Button>
      ) : null;
    const chat = task.conversationId ? (
      <Button size="sm" variant="outline" asChild>
        <Link to={`/chat/${task.conversationId}`}>
          <MessagesSquare /> Open chat
        </Link>
      </Button>
    ) : null;
    return (
      <Panel tone="blocked">
        <div className="flex gap-2.5">
          <OctagonAlert className="mt-0.5 size-4 shrink-0 text-rose-500" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium" aria-live="polite">
              {meta ? meta.title(who) : "Blocked"}
            </p>
            {kind === "interrupted" ? (
              <p className="mt-0.5 text-[13px] text-muted-foreground">Godmode restarted while {who} was working. It continues in the same chat, with what it did so far.</p>
            ) : kind === "manual" ? (
              <BlockedReason task={task} onSave={onReason} />
            ) : (
              reason && <p className="mt-0.5 text-[13px] whitespace-pre-wrap text-muted-foreground">{reason}</p>
            )}
            {advice && <p className="mt-1 text-[13px]">{advice}</p>}
            {!task.agentId && <p className="mt-1 text-[13px] text-muted-foreground">Assign an agent to go on.</p>}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {kind === "needs_input" ? (
            <>
              {task.agentId && (
                <Button size="sm" onClick={() => focusReply(task.id)}>
                  <MessageSquareReply /> Answer
                </Button>
              )}
              {chat}
            </>
          ) : kind === "failed" ? (
            <>
              {restart("Try again")}
              {chat}
            </>
          ) : kind === "stopped" ? (
            <>
              {restart("Start again", <Play />)}
              {chat}
            </>
          ) : kind === "interrupted" ? (
            <>
              {restart("Continue", <Play className="fill-current" />)}
              {chat}
            </>
          ) : kind === "publish" ? (
            <>
              {task.branch && (
                <Button size="sm" disabled={publish.isPending} onClick={() => publish.mutate()}>
                  {publish.isPending ? <Spinner /> : <GitPullRequestCreateArrow />} {publish.isPending ? "Publishing…" : "Publish again"}
                </Button>
              )}
              {task.agentId && (
                <Button size="sm" variant="outline" onClick={() => onMove(task, "todo")}>
                  <RotateCcw /> Start again
                </Button>
              )}
              {chat}
            </>
          ) : kind === "setup" ? (
            restart("Try again")
          ) : kind === "manual" ? (
            restart(task.startedAt ? "Start again" : "Start", <Play />)
          ) : (
            <>
              {restart("Try again")}
              {chat}
            </>
          )}
        </div>
      </Panel>
    );
  }

  if (task.status === "in_review") {
    const pr = task.pullRequest;
    return (
      <Panel tone="review">
        <p className="text-sm font-medium" aria-live="polite">
          Delivered — ready for your review
        </p>
        {pr && (
          <div className="mt-2 flex items-center gap-2">
            <PullRequestChip task={task} className="h-6 text-xs" />
            <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
              {pr.number ? repoLabel(pr.url.replace(/\/pull\/\d+$/, "")) : `Branch pushed — open the pull request on ${new URL(pr.url).hostname}`}
            </span>
            <Button size="sm" variant="ghost" asChild>
              <a href={pr.url} target="_blank" rel="noreferrer">
                {pr.number ? "Review" : "Open pull request"} <ArrowUpRight />
              </a>
            </Button>
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => approve(task)}>
            <Check /> Approve
          </Button>
          {task.agentId && task.conversationId && (
            <Button size="sm" variant="outline" onClick={() => focusReply(task.id)}>
              <MessageSquareReply /> Request changes
            </Button>
          )}
        </div>
        {pr?.number && pr.state === "open" && (
          <p className="mt-2.5 text-xs text-muted-foreground">
            Approve marks it done here — merging stays on {new URL(pr.url).hostname}. A merged pull request also moves it to Done.
          </p>
        )}
      </Panel>
    );
  }

  if (task.status === "done" || task.status === "cancelled") {
    return (
      <Panel>
        <div className="flex items-center gap-3">
          <StatusIcon status={task.status} className="size-4" />
          <p className="min-w-0 flex-1 text-sm font-medium">
            {task.status === "done" ? "Done" : "Cancelled"}
            {task.completedAt && (
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">closed {formatDistanceToNowStrict(new Date(task.completedAt), { addSuffix: true })}</span>
            )}
          </p>
          {task.pullRequest && <PullRequestChip task={task} className="h-6 text-xs" />}
          <Button size="sm" variant="outline" onClick={() => reopen(task)}>
            <RotateCcw /> Reopen
          </Button>
        </div>
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
      </Panel>
    );
  }

  // Waits in Todo for tickets that aren't delivered yet: it starts by itself, or now without them.
  if (agent && waitsForTickets(task)) {
    const open = task.waitsFor.filter((w) => !w.finished);
    return (
      <Panel>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[13px] text-muted-foreground">
            Waits for {open.map((w) => `#${w.number}`).join(", ")} — {agent.name} starts by itself once {open.length === 1 ? "it is" : "they are"} delivered, with {open.length === 1 ? "its" : "their"} result.
          </p>
          <Button size="sm" variant="outline" onClick={() => onStartWithoutWaiting()}>
            <Play /> Start without waiting
          </Button>
        </div>
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

/** Put the cursor in the ticket's reply box (Answer, Request changes). */
export function focusReply(taskId: string) {
  const box = document.getElementById(`task-reply-${taskId}`) as HTMLTextAreaElement | null;
  box?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  box?.focus();
}

/** A reason the human set when they moved the ticket to Blocked: shown, and editable in place. */
function BlockedReason({ task, onSave }: { task: Task; onSave: (reason: string) => void }) {
  const [value, setValue] = useState(task.blockedReason ?? "");
  useEffect(() => setValue(task.blockedReason ?? ""), [task.blockedReason]);
  return (
    <Input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => value.trim() !== (task.blockedReason ?? "") && onSave(value.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          setValue(task.blockedReason ?? "");
          e.currentTarget.blur();
        }
      }}
      placeholder="Add a reason…"
      aria-label="Why it is blocked"
      maxLength={2000}
      className="mt-1 h-8 border-transparent bg-transparent px-1.5 text-[13px] shadow-none hover:bg-accent/60"
    />
  );
}

/** "4m 12s", ticking. */
function Elapsed({ since, className }: { since: string; className?: string }) {
  const now = useNow(1000);
  const s = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  const text = s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return <span className={cn("tabular-nums", className)}>{text}</span>;
}

function Panel({ children, tone }: { children: ReactNode; tone?: "working" | "blocked" | "review" }) {
  return (
    <section
      className={cn(
        "rounded-xl border bg-card p-4 shadow-card",
        tone === "working" && "border-amber-500/30 bg-amber-500/[0.04]",
        tone === "blocked" && "border-rose-500/30 bg-rose-500/[0.04]",
        tone === "review" && "border-emerald-500/30 bg-emerald-500/[0.04]",
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
  // Kept when the sheet closes or the page changes: a half-written review isn't lost.
  const [text, setText, { discard }] = useDraft(`task:${task.id}:reply`, "");
  const [files, setFiles] = useDraft<PendingAttachment[]>(`task:${task.id}:reply-files`, [], { persist: false });
  const input = useRef<HTMLInputElement>(null);
  const send = useMutation({
    mutationFn: (msg: { text: string; files: PendingAttachment[] }) =>
      api.tasks.message(
        task.id,
        msg.text,
        msg.files.map((f) => ({ name: f.name, mime: f.mime, data: f.data })),
      ),
    // The box empties at once and the message shows in Activity; on failure it comes back.
    onMutate: (msg) => {
      discard();
      setFiles([]);
      const pending: TaskEvent = {
        id: `pending-${Date.now()}`,
        taskId: task.id,
        kind: "feedback",
        actor: "user",
        actorName: "",
        body: msg.text,
        data: { on: task.status, files: msg.files.map((f) => f.name) },
        runId: null,
        createdAt: new Date().toISOString(),
      };
      qc.setQueryData<TaskEvent[]>(qk.taskEvents(task.id), (list) => (Array.isArray(list) ? [...list, pending] : list));
      return { pending };
    },
    onSuccess: (_t, msg, ctx) => {
      msg.files.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
      // The real row may read differently (an answer, a masked secret): drop the placeholder and load what was recorded.
      if (ctx) qc.setQueryData<TaskEvent[]>(qk.taskEvents(task.id), (list) => list?.filter((x) => x.id !== ctx.pending.id));
      qc.invalidateQueries({ queryKey: qk.taskEvents(task.id) });
    },
    onError: (e, msg, ctx) => {
      if (ctx) qc.setQueryData<TaskEvent[]>(qk.taskEvents(task.id), (list) => list?.filter((x) => x.id !== ctx.pending.id));
      setText(msg.text);
      setFiles(msg.files);
      toastApiError(e, "Could not send", qc);
    },
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
  const submit = () => ready && send.mutate({ text: text.trim(), files });
  const name = agent?.name ?? "the agent";
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
            id={`task-reply-${task.id}`}
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
            placeholder={
              task.pause?.reason === "question" || (task.status === "blocked" && task.blockedKind === "needs_input")
                ? `Answer ${name}…`
                : task.status === "in_review"
                  ? task.pullRequest?.state === "open"
                    ? `What should ${name} change? The pull request updates.`
                    : `What should ${name} change?`
                  : task.status === "blocked"
                    ? `Tell ${name} how to go on…`
                    : isWaiting(task)
                      ? `Message ${name} — it continues right away`
                      : isWorking(task)
                        ? `Message ${name} — it reads it when this run is done`
                        : task.status === "done" || task.status === "cancelled"
                          ? `Something still missing? Tell ${name} — the task reopens.`
                          : `Message ${name}…`
            }
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
