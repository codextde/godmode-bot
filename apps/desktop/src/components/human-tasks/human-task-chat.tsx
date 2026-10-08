import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Check, CircleCheck, CircleSlash, ListTodo } from "lucide-react";
import type { HumanTask, Message, MessageBlock } from "@godmode/shared";
import { humanTaskRef } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useHumanTaskActions } from "./human-task-sheet";

type HumanTaskBlock = Extract<MessageBlock, { type: "human_task" }>;

export function humanTaskBlock(message: Message): HumanTaskBlock | null {
  return (message.blocks.find((b) => b.type === "human_task") as HumanTaskBlock | undefined) ?? null;
}

/** Where the human closed a task the agent gave them, and the chat went on. */
export function HumanTaskMarker({ block }: { block: HumanTaskBlock }) {
  const done = block.outcome === "done";
  const Icon = done ? CircleCheck : CircleSlash;
  return (
    <div role="note" className="flex flex-col items-center gap-1.5 text-center">
      <div className="flex w-full items-center gap-3 text-[11px] text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Icon className={done ? "size-3.5 text-emerald-600 dark:text-emerald-400" : "size-3.5 text-rose-600 dark:text-rose-400"} aria-hidden />
          <span className="font-medium text-foreground">{done ? "You did" : "You couldn't do"}</span>
          <span className="truncate">
            {humanTaskRef(block)} · {block.title}
          </span>
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
      {block.note && <p className="max-w-[85%] text-[13px] text-balance whitespace-pre-wrap text-muted-foreground">{block.note}</p>}
    </div>
  );
}

/** Above the composer while the agent waits for the human to do something. */
export function HumanTaskBar({ conversationId, agentName }: { conversationId: string; agentName: string }) {
  const { data = [] } = useQuery({
    queryKey: [...qk.humanTasks, "chat", conversationId],
    queryFn: () => api.humanTasks.list({ status: "active", conversationId }),
  });
  if (!data.length) return null;
  return (
    <div className="mb-2 space-y-1.5">
      {data.slice(0, 3).map((t) => (
        <Row key={t.id} task={t} agentName={agentName} />
      ))}
      {data.length > 3 && (
        <Link to="/my-tasks" className="block px-1 text-xs text-muted-foreground hover:text-foreground">
          +{data.length - 3} more under My tasks
        </Link>
      )}
    </div>
  );
}

function Row({ task, agentName }: { task: HumanTask; agentName: string }) {
  const { close } = useHumanTaskActions();
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card py-2 pr-2 pl-2.5 shadow-card">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-warning/30 bg-warning/10 text-warning">
        <ListTodo className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 leading-snug">
        <p className="truncate text-[13px]">
          <span className="font-medium">Waiting for you</span>
          <span className="text-muted-foreground"> · {humanTaskRef(task)}</span>
        </p>
        <p className="truncate text-xs text-muted-foreground" title={task.title}>
          {task.title}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button size="xs" variant="ghost" asChild>
          <Link to={`/my-tasks?task=${task.id}`}>Open</Link>
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="xs" variant="outline" disabled={close.isPending} onClick={() => close.mutate({ id: task.id, outcome: "done", note: "", files: [] })}>
              {close.isPending ? <Spinner /> : <Check />} Done
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Mark it done — {agentName} continues</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
