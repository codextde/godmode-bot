import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowUpRight, Square } from "lucide-react";
import type { Agent, AgentQuestion } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { AgentAvatar } from "@/components/common";
import { QuestionCard, viewOfQuestion } from "@/components/chat/question-card";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";

/** Where a question came from: its task, its automation, or its chat. */
function originOf(q: AgentQuestion): { label: string; to: string; open: string } {
  if (q.taskId) return { label: q.taskNumber != null ? `Task #${q.taskNumber}` : "Task", to: `/tasks?task=${q.taskId}`, open: "Open task" };
  if (q.routineName) return { label: `Automation · ${q.routineName}`, to: `/chat/${q.conversationId}`, open: "Open chat" };
  return { label: q.conversationTitle || "Chat", to: `/chat/${q.conversationId}`, open: "Open chat" };
}

/** A question or approval in the inbox: who asks, from where, and the card to answer it in place. */
export function InboxQuestion({ question, agent }: { question: AgentQuestion; agent?: Agent }) {
  const qc = useQueryClient();
  const origin = originOf(question);
  const name = agent?.name ?? "An agent";
  const stop = useMutation({
    mutationFn: () => api.runs.cancel(question.runId),
    onSuccess: () => {
      toast.success("Stopped — the question is withdrawn");
      qc.invalidateQueries({ queryKey: qk.questions });
      qc.invalidateQueries({ queryKey: qk.bootstrap });
    },
    onError: (err) => toast.error("Couldn't stop the run", { description: errorMessage(err) }),
  });

  return (
    <article className="rounded-xl border bg-card p-3 shadow-card">
      <header className="mb-2.5 flex min-w-0 items-center gap-2">
        <AgentAvatar agent={agent ?? { id: question.agentId, color: "violet" }} size="sm" still className="size-6" />
        <p className="min-w-0 flex-1 truncate text-[13px]">
          <span className="font-medium">{name}</span>{" "}
          <span className="text-muted-foreground">{question.kind === "approval" ? "needs your OK" : "asks"}</span>
          <span className="text-muted-foreground"> · {origin.label}</span>
        </p>
        <Button asChild size="xs" variant="ghost" className="shrink-0 text-muted-foreground">
          <Link to={origin.to}>
            {origin.open} <ArrowUpRight />
          </Link>
        </Button>
        {question.status === "open" && (
          <Button
            size="xs"
            variant="ghost"
            className="shrink-0 text-muted-foreground hover:text-destructive"
            disabled={stop.isPending}
            onClick={() => stop.mutate()}
            title="Stop the run — the question is withdrawn"
          >
            {stop.isPending ? <Spinner /> : <Square className="size-2.5 fill-current" />} Stop
          </Button>
        )}
      </header>
      <QuestionCard
        question={viewOfQuestion(question)}
        agentName={name}
        answerable={question.status === "open"}
        inline
        conversationId={question.conversationId}
        className="border-0 px-0 pt-0 pb-0 shadow-none"
      />
    </article>
  );
}
