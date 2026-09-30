import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNowStrict } from "date-fns";
import { toast } from "sonner";
import { ArrowUpRight, EllipsisVertical, GitBranch, MessagesSquare, OctagonAlert, Paperclip, Play, RotateCcw, SendHorizontal, Square, Trash2 } from "lucide-react";
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
import { AttachmentChip, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, formatBytes, readAttachment, type PendingAttachment } from "@/components/chat/attachments";
import { api } from "@/lib/api";
import { modKey } from "@/lib/desktop";
import { draftKeys, useDraft } from "@/lib/drafts";
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
  const defaultRepo = workspaceRepos(workspace)[0];

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
            <EditableDescription taskId={task.id} value={task.description} onSave={(description) => save.mutate({ description })} />
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
            {(task.type === "coding" || task.branch) && (
              <>
                <Prop label="Repository">
                  {started || task.repoPath ? (
                    <span className="flex min-w-0 items-center gap-1.5 font-mono text-[13px]" title={task.repoPath || task.repoUrl || undefined}>
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
                    <span className="flex min-w-0 items-center gap-1.5 font-mono text-[13px]">
                      <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{task.branch}</span>
                      <span className="shrink-0 text-muted-foreground">→ {task.baseBranch}</span>
                      <CopyButton value={task.branch} label="Copy branch name" size="icon-xs" />
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
                    <span className="flex min-w-0 items-center gap-1.5 font-mono text-[13px]" title={task.worktree}>
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

/** Click to edit; leaving the editor saves. Files pasted, dropped or picked are uploaded and linked in the Markdown. */
function EditableDescription({ taskId, value, onSave }: { taskId: string; value: string; onSave: (v: string) => void }) {
  const draftKey = `task:${taskId}:description`;
  const [editing, setEditing] = useState(() => draftKeys(draftKey).length > 0);
  const [draft, setDraft, kept] = useDraft(editing ? draftKey : undefined, value);
  const editor = useRef<DescriptionEditorHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const [uploading, setUploading] = useState(false);
  /** Save once the uploads are done (asked to while they ran). */
  const finishLater = useRef(false);
  const setText = useCallback((update: TextUpdate) => setDraft((d) => (typeof update === "function" ? update(d) : update)), [setDraft]);

  const finish = () => {
    // Still uploading (or picking a file): the edit finishes when that's done.
    if (editor.current?.busy()) {
      finishLater.current = uploading;
      return;
    }
    finishLater.current = false;
    const next = withoutPlaceholders(draft);
    if (next !== value.trim()) onSave(next);
    kept.discard();
    setEditing(false);
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    if (!uploading && finishLater.current) finishRef.current();
  }, [uploading]);
  const cancel = () => {
    kept.discard();
    setEditing(false);
  };

  if (!editing) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => {
          // Links and file cards inside do their own thing.
          if ((e.target as HTMLElement).closest("a, button")) return;
          setEditing(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.target === e.currentTarget) setEditing(true);
        }}
        className="-mx-2 mt-1 block w-[calc(100%+1rem)] cursor-text rounded-lg px-2 py-1.5 text-left text-sm transition outline-none hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        {value.trim() ? <Markdown>{value}</Markdown> : <span className="text-muted-foreground">Add a description… paste or drop images, PDFs and files</span>}
      </div>
    );
  }
  return (
    <div
      ref={box}
      onBlur={(e) => {
        if (!box.current?.contains(e.relatedTarget as Node | null)) finish();
      }}
      className="-mx-2 mt-1 rounded-lg border bg-card px-3 pt-2.5 pb-2 shadow-card focus-within:ring-[3px] focus-within:ring-ring/40"
    >
      <DescriptionEditor
        ref={editor}
        autoFocus
        aria-label="Description"
        value={draft}
        onChange={setText}
        onBusyChange={setUploading}
        minHeight={128}
        placeholder="Details, acceptance criteria, links… Markdown works. Paste or drop screenshots, PDFs and other files."
        textClassName="text-sm leading-relaxed"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            cancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            finish();
          }
        }}
      />
      {/* Clicks here keep the focus in the text (WebKit doesn't focus buttons), so they don't end the edit. */}
      <div className="mt-2 flex items-center gap-1" onMouseDown={(e) => e.preventDefault()}>
        <Button type="button" variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label="Attach files" onClick={() => editor.current?.pickFiles()}>
          <Paperclip className="size-3.5" />
        </Button>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {modKey}↵ save · Esc cancel
        </span>
        <Button type="button" size="sm" className="ml-2 h-7" onClick={finish} disabled={uploading}>
          {uploading ? "Uploading…" : "Save"}
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
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      className="h-8 font-mono text-[13px]"
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
              }
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
