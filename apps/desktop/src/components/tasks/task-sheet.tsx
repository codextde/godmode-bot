import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNowStrict } from "date-fns";
import { ArrowUpRight, EllipsisVertical, GitBranch, MessagesSquare, OctagonAlert, Play, RotateCcw, SendHorizontal, Square, Trash2 } from "lucide-react";
import type { Agent, Task, TaskPatch, TaskStatus, Workspace } from "@godmode/shared";
import { MAX_TASK_TITLE_LENGTH } from "@godmode/shared";
import { WorkingTicks } from "@/components/aicss/Motion";
import { Markdown } from "@/components/chat/markdown";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { CopyButton } from "@/components/vault/copy-button";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { AgentSelect, StatusSelect, agentsInReach } from "./task-fields";
import { PullRequestChip, useTaskActivity } from "./task-card";
import { TYPE_META, TypeIcon, isWorking, repoLabel } from "./task-meta";
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
  return (
    <Sheet open={!!task} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-[40rem]" showCloseButton={false}>
        {task && <TaskDetail key={task.id} task={task} agents={agents} workspaces={workspaces} onClose={onClose} onMove={onMove} onDelete={onDelete} />}
      </SheetContent>
    </Sheet>
  );
}

function TaskDetail({
  task,
  agents,
  workspaces,
  onClose,
  onMove,
  onDelete,
}: {
  task: Task;
  agents: Agent[];
  workspaces: Map<string, Workspace>;
  onClose: () => void;
  onMove: (task: Task, status: TaskStatus) => void;
  onDelete: (task: Task) => void;
}) {
  const qc = useQueryClient();
  const workspace = task.workspaceId ? (workspaces.get(task.workspaceId) ?? null) : null;
  const agent = agents.find((a) => a.id === task.agentId);
  const reachable = agentsInReach(agents, task.workspaceId, task.agentId);
  const started = !!task.conversationId;

  const save = useMutation({
    mutationFn: (patch: TaskPatch) => api.tasks.update(task.id, patch),
    onSuccess: (t) => qc.setQueriesData<Task[]>({ queryKey: qk.tasks }, (list) => list?.map((x) => (x.id === t.id ? t : x))),
    onError: (e) => toastApiError(e, "Could not update the task", qc),
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <span className="flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs text-muted-foreground">
          <TypeIcon type={task.type} />
          {TYPE_META[task.type].label}
        </span>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">#{task.number}</span>
        <span className="text-muted-foreground/50">·</span>
        <span className="flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
          {workspace ? (
            <>
              <span>{workspace.icon}</span> {workspace.name}
            </>
          ) : (
            "Global"
          )}
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
          <div>
            <SheetTitle asChild>
              <EditableTitle value={task.title} onSave={(title) => save.mutate({ title })} />
            </SheetTitle>
            <SheetDescription className="sr-only">Task details</SheetDescription>
            <EditableDescription value={task.description} onSave={(description) => save.mutate({ description })} />
          </div>

          <dl className="grid grid-cols-[7.5rem_1fr] items-center gap-x-4 gap-y-2.5 text-sm">
            <Prop label="Status">
              <StatusSelect value={task.status} onChange={(s) => onMove(task, s)} className="h-8" />
            </Prop>
            <Prop label="Agent">
              <AgentSelect agents={reachable} value={task.agentId} onChange={(agentId) => save.mutate({ agentId })} className="h-8" />
            </Prop>
            <Prop label="Type">
              <Select value={task.type} onValueChange={(type) => save.mutate({ type: type as Task["type"] })} disabled={started}>
                <SelectTrigger className="h-8 w-full">
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
            {task.type === "coding" && (
              <>
                <Prop label="Repository">
                  {started ? (
                    <span className="flex min-w-0 items-center gap-1.5 font-mono text-[13px]">
                      <span className="truncate">{repoLabel(task.repoUrl || workspace?.repoUrl || "")}</span>
                    </span>
                  ) : (
                    <BlurInput
                      value={task.repoUrl}
                      placeholder={workspace?.repoUrl || "https://github.com/acme/app.git"}
                      onSave={(repoUrl) => save.mutate({ repoUrl })}
                    />
                  )}
                </Prop>
                <Prop label={started ? "Branch" : "Base branch"}>
                  {task.branch ? (
                    <span className="flex min-w-0 items-center gap-1.5 font-mono text-[13px]">
                      <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{task.branch}</span>
                      <span className="shrink-0 text-muted-foreground">→ {task.baseBranch}</span>
                      <CopyButton value={task.branch} label="Copy branch name" size="icon-xs" />
                    </span>
                  ) : (
                    <BlurInput
                      value={task.baseBranch}
                      placeholder={workspace?.repoBranch || "default branch"}
                      onSave={(baseBranch) => save.mutate({ baseBranch })}
                    />
                  )}
                </Prop>
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
            {agent ? `Ready for ${agent.name}.` : "Assign an agent, then move it to Todo — it starts right away."}
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
        } else if (e.key === "Escape") {
          setDraft(value);
          e.stopPropagation();
        }
      }}
      className="-mx-2 w-[calc(100%+1rem)] resize-none overflow-hidden rounded-lg bg-transparent px-2 py-1 text-xl leading-snug font-medium tracking-[-0.02em] outline-none hover:bg-accent/50 focus:bg-accent/60"
    />
  );
}

function EditableDescription({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="-mx-2 mt-1 block w-[calc(100%+1rem)] rounded-lg px-2 py-1.5 text-left text-sm transition hover:bg-accent/50"
      >
        {value.trim() ? <Markdown>{value}</Markdown> : <span className="text-muted-foreground">Add a description…</span>}
      </button>
    );
  }
  return (
    <Textarea
      autoFocus
      rows={6}
      value={draft}
      placeholder="Details, acceptance criteria, links… (Markdown)"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (draft.trim() !== value.trim()) onSave(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          setDraft(value);
          setEditing(false);
        }
      }}
      className="mt-1 max-h-96 min-h-32 resize-y text-sm leading-relaxed"
    />
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
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      className="h-8 font-mono text-[13px]"
    />
  );
}

/** Review feedback or an answer for the agent; it picks the task up again in the same conversation. */
function FollowUp({ task, agent }: { task: Task; agent?: Agent }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const send = useMutation({
    mutationFn: () => api.tasks.message(task.id, text.trim()),
    onSuccess: () => setText(""),
    onError: (e) => toastApiError(e, "Could not send", qc),
  });
  const submit = () => text.trim() && !send.isPending && send.mutate();
  return (
    <div className="shrink-0 border-t bg-paper-2 p-3">
      <div className="flex items-end gap-2 rounded-xl border bg-card p-1.5 shadow-card focus-within:ring-[3px] focus-within:ring-ring/40">
        <Textarea
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={task.type === "coding" ? `Ask ${agent?.name ?? "the agent"} for changes — the pull request updates` : `Reply to ${agent?.name ?? "the agent"}…`}
          className="max-h-40 min-h-9 resize-none border-0 px-2 py-2 text-sm shadow-none focus-visible:ring-0"
        />
        <Button size="icon" className="size-8 shrink-0" aria-label="Send" disabled={!text.trim() || send.isPending} onClick={submit}>
          {send.isPending ? <Spinner /> : <SendHorizontal className="size-4" />}
        </Button>
      </div>
    </div>
  );
}
