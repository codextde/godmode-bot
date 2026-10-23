import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNowStrict } from "date-fns";
import { toast } from "sonner";
import { ArrowUpRight, Check, CircleDashed, CircleSlash, EllipsisVertical, Flag, MessagesSquare, Paperclip, Play, SendHorizontal, SquareKanban, Trash2, Undo2, X } from "lucide-react";
import type { Agent, HumanTask, HumanTaskCloseResult, HumanTaskPatch } from "@godmode/shared";
import { HUMAN_TASK_WORDS, humanTaskAnswer, humanTaskRef, isHumanTaskActive } from "@godmode/shared";
import { AgentAvatar } from "@/components/common";
import { Markdown } from "@/components/chat/markdown";
import { AttachmentTray, readAttachments, totalBytes, type PendingAttachment } from "@/components/chat/attachments";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { modKey, openExternal } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { KindBadge, hostOf, outcomeOf } from "./human-task-card";

/** Tell the human what happened with the agent once they closed a task. */
export function toastClosed(result: HumanTaskCloseResult, agentName: string | null) {
  const task = result.task;
  const words = HUMAN_TASK_WORDS[task.kind];
  const title = `${humanTaskRef(task)} ${(task.status === "done" ? words.wasDone : task.kind === "task" ? "closed" : words.wasDeclined).toLowerCase()}`;
  if (result.continued) toast.success(title, { description: `${agentName ?? "The agent"} picks it up from here.` });
  else if (result.notContinued) toast.warning(title, { description: result.notContinued });
  else toast.success(title);
}

export function useHumanTaskActions() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.humanTasks });
    void qc.invalidateQueries({ queryKey: qk.bootstrap });
  };
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: HumanTaskPatch }) => api.humanTasks.update(id, patch),
    onMutate: async ({ id, patch }) => {
      // A list answer already on its way would put the old column back.
      await qc.cancelQueries({ queryKey: qk.humanTasks, exact: true });
      qc.setQueryData<HumanTask[]>(qk.humanTasks, (list) => list?.map((t) => (t.id === id ? { ...t, ...(patch.status ? { status: patch.status } : {}), ...(patch.priority ? { priority: patch.priority } : {}) } : t)));
    },
    onSettled: refresh,
    onError: (e) => toastApiError(e, "Couldn't update the task", qc),
  });
  const close = useMutation({
    mutationFn: ({ id, outcome, note, files, optionId }: { id: string; outcome: "done" | "declined"; note: string; files: PendingAttachment[]; optionId?: string }) =>
      api.humanTasks.close(id, {
        outcome,
        note: note || undefined,
        optionId,
        attachments: files.length ? files.map((f) => ({ name: f.name, mime: f.mime, data: f.data })) : undefined,
      }),
    onSuccess: (result) => {
      toastClosed(result, result.task.agentName ?? null);
      // A ticket that stood for a question: the card in its chat is answered too.
      if (result.task.questionId) {
        void qc.invalidateQueries({ queryKey: qk.questions });
        if (result.task.conversationId) void qc.invalidateQueries({ queryKey: qk.conversation(result.task.conversationId) });
      }
    },
    onSettled: refresh,
    onError: (e) => toastApiError(e, "Couldn't close the task", qc),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.humanTasks.delete(id),
    onSuccess: () => toast.success("Task deleted"),
    onSettled: refresh,
    onError: (e) => toastApiError(e, "Couldn't delete the task", qc),
  });
  return { update, close, remove };
}

export function HumanTaskSheet({
  task,
  agent,
  focusNote,
  onClose,
}: {
  task: HumanTask | null;
  agent?: Agent;
  /** Open with the cursor in the note (dropped on Done). */
  focusNote?: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet open={!!task} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 outline-none sm:max-w-[36rem]"
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          if (focusNote) return;
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        {task && <Detail key={task.id} task={task} agent={agent} focusNote={focusNote} onClose={onClose} />}
      </SheetContent>
    </Sheet>
  );
}

function Detail({ task, agent, focusNote, onClose }: { task: HumanTask; agent?: Agent; focusNote?: boolean; onClose: () => void }) {
  const { update, close, remove } = useHumanTaskActions();
  const active = isHumanTaskActive(task);
  const outcome = outcomeOf(task);
  const own = !task.agentId && !task.runId;
  const name = agent?.name ?? task.agentName ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <span className="font-mono text-[13px] font-medium tabular-nums">{humanTaskRef(task)}</span>
        <StatusPill task={task} />
        {active && <KindBadge task={task} className="rounded-full px-2 py-0.5 text-[11.5px]" />}
        {active && task.priority === "high" && (
          <span className="flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11.5px] font-medium text-rose-600 dark:text-rose-400">
            <Flag className="size-3 fill-current" /> Urgent
          </span>
        )}
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
              {task.taskId && (
                <DropdownMenuItem asChild>
                  <Link to={`/tasks?task=${task.taskId}`}>
                    <SquareKanban /> Open task #{task.taskNumber}
                  </Link>
                </DropdownMenuItem>
              )}
              {active && (
                <DropdownMenuItem onClick={() => update.mutate({ id: task.id, patch: { status: task.status === "backlog" ? "open" : "backlog" } })}>
                  {task.status === "backlog" ? <Undo2 /> : <CircleDashed />} {task.status === "backlog" ? "Move to To do" : "Move to backlog"}
                </DropdownMenuItem>
              )}
              {active && (
                <DropdownMenuItem onClick={() => update.mutate({ id: task.id, patch: { priority: task.priority === "high" ? "normal" : "high" } })}>
                  <Flag /> {task.priority === "high" ? "Not urgent" : "Mark urgent"}
                </DropdownMenuItem>
              )}
              {(own || !active) && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => {
                      remove.mutate(task.id);
                      onClose();
                    }}
                  >
                    <Trash2 /> Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="sm" className="h-8 text-muted-foreground" onClick={onClose}>
            Close <kbd className="ml-1 font-mono text-[10px] opacity-60">Esc</kbd>
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-5 px-6 pt-5 pb-8">
          <div className="space-y-3">
            <SheetTitle className="text-xl leading-snug font-medium tracking-[-0.02em]">{task.title}</SheetTitle>
            <SheetDescription asChild>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
                {own ? (
                  <span>Your own task</span>
                ) : (
                  <span className="flex items-center gap-1.5 text-foreground/80">
                    {agent && <AgentAvatar agent={agent} size="sm" still className="size-5 rounded-[5px] text-[11px]" />}
                    {name ?? "An agent that was removed"}
                  </span>
                )}
                <span className="text-muted-foreground/50">·</span>
                <time dateTime={task.createdAt} title={format(new Date(task.createdAt), "PPpp")}>
                  {formatDistanceToNowStrict(new Date(task.createdAt), { addSuffix: true })}
                </time>
                {task.taskNumber != null ? (
                  <>
                    <span className="text-muted-foreground/50">·</span>
                    <Link to={`/tasks?task=${task.taskId}`} className="hover:text-foreground hover:underline">
                      for task #{task.taskNumber}
                    </Link>
                  </>
                ) : task.conversationId && task.conversationTitle ? (
                  <>
                    <span className="text-muted-foreground/50">·</span>
                    <Link to={`/chat/${task.conversationId}`} className="max-w-64 truncate hover:text-foreground hover:underline">
                      {task.conversationTitle}
                    </Link>
                  </>
                ) : null}
              </div>
            </SheetDescription>
          </div>

          {task.url && (
            <button
              type="button"
              onClick={() => void openExternal(task.url!)}
              className="group flex w-full items-center gap-3 rounded-xl border bg-card px-3.5 py-3 text-left shadow-card transition hover:border-foreground/20"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand-strong">
                <ArrowUpRight className="size-4 transition group-hover:translate-x-px group-hover:-translate-y-px" />
              </span>
              <span className="min-w-0">
                <span className="block text-[13.5px] font-medium">Open {hostOf(task.url)}</span>
                <span className="block truncate font-mono text-[11.5px] text-muted-foreground">{task.url}</span>
              </span>
            </button>
          )}

          {task.body ? (
            <section className="space-y-2">
              <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{own ? "Notes" : BODY_HEADING[task.kind]}</h3>
              <Markdown className="text-[14px]">{task.body}</Markdown>
            </section>
          ) : null}

          {task.fromAnswer && task.conversationId && (
            <p className="text-[13px] text-muted-foreground">
              {name ?? "The agent"} left this open in the answer it finished with.{" "}
              <Link to={`/chat/${task.conversationId}`} className="text-foreground underline-offset-2 hover:underline">
                Read the whole answer
              </Link>
            </p>
          )}

          {outcome && (
            <section className="space-y-2 rounded-xl border bg-foreground/[0.025] p-4">
              <p className={cn("flex items-center gap-1.5 text-[13px] font-medium", outcome.tone)}>
                <outcome.icon className="size-4" />
                {task.status === "withdrawn" ? `${name ?? "The agent"} took it back` : outcome.label}
                {task.closedAt && <span className="font-normal text-muted-foreground">· {formatDistanceToNowStrict(new Date(task.closedAt), { addSuffix: true })}</span>}
              </p>
              {(humanTaskAnswer(task) || task.closedReason) && <p className="text-sm whitespace-pre-wrap text-foreground/80">{humanTaskAnswer(task) || task.closedReason}</p>}
              {!!task.response?.attachments.length && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Paperclip className="size-3" /> {task.response.attachments.map((a) => a.name).join(", ")}
                </p>
              )}
            </section>
          )}
        </div>
      </div>

      {active && <CloseBox task={task} agentName={own ? null : (name ?? "the agent")} focus={focusNote} pending={close.isPending} onStart={() => update.mutate({ id: task.id, patch: { status: "doing" } })} onBack={() => update.mutate({ id: task.id, patch: { status: "open" } })} onClose={(outcome, note, files, optionId) => close.mutate({ id: task.id, outcome, note, files, optionId }, { onSuccess: onClose })} />}
    </div>
  );
}

const BODY_HEADING: Record<HumanTask["kind"], string> = { task: "What to do", decision: "What it's about", approval: "Why" };

function StatusPill({ task }: { task: HumanTask }) {
  const words = HUMAN_TASK_WORDS[task.kind];
  const meta: Record<HumanTask["status"], { label: string; className: string }> = {
    backlog: { label: "Backlog", className: "bg-foreground/[0.04] text-muted-foreground" },
    open: { label: "To do", className: "bg-foreground/[0.06] text-foreground/80" },
    doing: { label: "Doing", className: "bg-brand-soft text-brand-strong" },
    done: { label: words.wasDone, className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
    declined: {
      label: words.wasDeclined,
      className: task.kind === "decision" ? "bg-foreground/[0.06] text-muted-foreground" : "bg-rose-500/10 text-rose-700 dark:text-rose-300",
    },
    withdrawn: { label: "Taken back", className: "bg-foreground/[0.06] text-muted-foreground" },
  };
  const m = meta[task.status];
  return <span className={cn("rounded-full px-2 py-0.5 text-[11.5px] font-medium", m.className)}>{m.label}</span>;
}

/** What the agent does once the task is closed, in a line above the box. */
function closeHint(task: HumanTask, agentName: string | null): string | null {
  if (!agentName) return null;
  if (task.questionId) return `${agentName} stands still until you ${task.kind === "approval" ? "decide" : "answer"}, and goes on right after.`;
  if (task.kind === "decision") return `${agentName} goes on with your answer. Replying in its chat works too.`;
  return `${agentName} continues by itself once you close this. Anything it should know goes in the note.`;
}

function CloseBox({
  task,
  agentName,
  focus,
  pending,
  onStart,
  onBack,
  onClose,
}: {
  task: HumanTask;
  /** null: the human's own task, nobody continues. */
  agentName: string | null;
  focus?: boolean;
  pending: boolean;
  onStart: () => void;
  onBack: () => void;
  onClose: (outcome: "done" | "declined", note: string, files: PendingAttachment[], optionId?: string) => void;
}) {
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [files, setFiles] = useState<PendingAttachment[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focus) setTimeout(() => area.current?.focus(), 120);
  }, [focus]);
  const add = async (chosen: File[]) => {
    const read = await readAttachments(chosen, totalBytes(files), toast.error);
    if (read.length) setFiles((list) => [...list, ...read]);
  };
  const drop = (f: PendingAttachment) => {
    if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
    setFiles((list) => list.filter((x) => x.id !== f.id));
  };
  const words = HUMAN_TASK_WORDS[task.kind];
  const decision = task.kind === "decision";
  const approval = task.kind === "approval";
  // An answer needs words, a pick or a file.
  const ready = !decision || !!note.trim() || !!picked || files.length > 0;
  const finish = (outcome: "done" | "declined") => {
    if (pending || (outcome === "done" && !ready)) return;
    onClose(outcome, note.trim(), files, outcome === "done" && decision ? (picked ?? undefined) : undefined);
  };
  const hint = closeHint(task, agentName);
  const placeholder = !agentName
    ? "Note (optional)"
    : decision
      ? task.options.length
        ? "Or answer in your own words"
        : `Your answer for ${agentName}`
      : `Note for ${agentName} (optional)`;

  return (
    <div className="shrink-0 border-t bg-paper-2 p-3">
      {hint && <p className="mb-2 px-1 text-xs text-muted-foreground">{hint}</p>}
      {decision && task.options.length > 0 && (
        <div className="mb-2 grid gap-1.5" role="radiogroup" aria-label="Suggested answers">
          {task.options.map((o, i) => {
            const on = picked === o.id;
            return (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={pending}
                onClick={() => setPicked(on ? null : o.id)}
                className={cn(
                  "flex min-h-9 w-full items-center gap-2.5 rounded-lg border bg-card px-3 py-2 text-left transition outline-none hover:border-foreground/25 focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  on && "border-primary/50 bg-primary/[0.06]",
                )}
              >
                <span className={cn("grid size-5 shrink-0 place-items-center rounded-md border text-[11px] tabular-nums", on ? "border-primary bg-primary text-primary-foreground" : "border-foreground/20")} aria-hidden>
                  {on ? <Check className="size-3" /> : i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium">{o.label}</span>
                  {o.description && <span className="block text-xs text-muted-foreground">{o.description}</span>}
                </span>
                {o.recommended && <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Recommended</span>}
              </button>
            );
          })}
        </div>
      )}
      <div className="rounded-xl border bg-card p-1.5 shadow-card focus-within:ring-[3px] focus-within:ring-ring/40">
        {files.length > 0 && (
          <AttachmentTray
            files={files}
            onRemove={drop}
            onClear={() => {
              files.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
              setFiles([]);
            }}
          />
        )}
        <div className="flex items-end gap-1">
          {agentName && !approval && (
            <>
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
            </>
          )}
          <Textarea
            ref={area}
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onPaste={(e) => {
              if (!agentName || approval) return;
              const pasted = [...e.clipboardData.files];
              if (!pasted.length) return;
              e.preventDefault();
              void add(pasted);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                finish("done");
              } else if (e.key === "Escape") e.currentTarget.blur();
            }}
            placeholder={placeholder}
            aria-label={placeholder}
            className="max-h-40 min-h-9 resize-none border-0 px-2 py-2 text-sm shadow-none focus-visible:ring-0"
          />
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        {task.status === "open" ? (
          <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={pending} onClick={onStart}>
            <Play className="fill-current" /> {decision || approval ? "Thinking about it" : "I'm on it"}
          </Button>
        ) : (
          <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={pending} onClick={onBack}>
            <Undo2 /> Back to To do
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {decision ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" disabled={pending} onClick={() => finish("declined")}>
                  <X /> {words.declined}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {task.questionId ? `No answer needed anymore. ${agentName ?? "The agent"} goes on without it.` : `Nothing to decide here. ${agentName ?? "The agent"} isn't woken.`}
              </TooltipContent>
            </Tooltip>
          ) : (
            <Button variant="outline" size="sm" disabled={pending} onClick={() => finish("declined")}>
              {approval ? <X /> : <CircleSlash />} {words.declined}
            </Button>
          )}
          <Button size="sm" disabled={pending || !ready} onClick={() => finish("done")}>
            {pending ? <Spinner /> : decision ? <SendHorizontal /> : <Check />} {words.done}
            <Hint>{modKey}↵</Hint>
          </Button>
        </div>
      </div>
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <kbd className="ml-0.5 font-mono text-[10px] opacity-60">{children}</kbd>;
}
