import { createContext, useContext, useId, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceStrict } from "date-fns";
import type { AgentQuestion, AnswerQuestionInput, AnswerVia, MessageBlock, QuestionAnswer, QuestionKind, QuestionOption, QuestionStatus } from "@godmode/shared";
import { Check, CircleCheck, CircleSlash, MessageCircleQuestion, SendHorizontal, ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useNow } from "@/components/vault/use-now";
import { ApiRequestError, api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";

type QuestionBlock = Extract<MessageBlock, { type: "question" }>;

/** What a card shows: the block in the agent's message, or the question as the inbox lists it. */
export interface QuestionView {
  id: string;
  kind: QuestionKind;
  title: string;
  body: string;
  affects: string;
  options: QuestionOption[];
  status: QuestionStatus;
  answer?: QuestionAnswer | null;
  closedReason?: string | null;
  askedAt: string;
}

export function viewOfQuestion(q: AgentQuestion): QuestionView {
  return { ...q, askedAt: q.createdAt };
}

export function viewOfBlock(b: QuestionBlock): QuestionView {
  return b;
}

/**
 * Lets the thread's cards know which question the chat's run waits for (from the conversation itself, so a card is
 * answerable the moment the run stands still) and whose question it is.
 */
interface QuestionScopeValue {
  conversationId: string;
  agentName: string;
  /** The question the chat's run stands still for; null = none. */
  openId: string | null;
}

const QuestionScope = createContext<QuestionScopeValue | null>(null);

export function QuestionScopeProvider({ value, children }: { value: QuestionScopeValue; children: ReactNode }) {
  return <QuestionScope.Provider value={value}>{children}</QuestionScope.Provider>;
}

export function useAnswerQuestion(conversationId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: AnswerQuestionInput }) => api.questions.answer(id, input),
    onSuccess: ({ question }) => {
      qc.invalidateQueries({ queryKey: qk.questions });
      qc.invalidateQueries({ queryKey: qk.bootstrap });
      qc.invalidateQueries({ queryKey: qk.conversation(conversationId ?? question.conversationId) });
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
    },
    onError: (err) => {
      qc.invalidateQueries({ queryKey: qk.questions });
      if (conversationId) qc.invalidateQueries({ queryKey: qk.conversation(conversationId) });
      const closed = err instanceof ApiRequestError && err.code === "question_closed";
      toast.error(closed ? "Already settled" : "Couldn't send your answer", { description: errorMessage(err) });
    },
  });
}

const PLATFORM: Partial<Record<AnswerVia, string>> = { slack: "Slack", telegram: "Telegram", teams: "Teams" };

function answeredLine(a: QuestionAnswer, status: QuestionStatus, choice: string | null): ReactNode {
  const where = a.via === "phone" ? " from your phone" : PLATFORM[a.via] ? ` in ${PLATFORM[a.via]}` : "";
  const time = <time dateTime={a.at}>{format(new Date(a.at), "HH:mm")}</time>;
  if (status === "approved") return <>You approved{where} · {time}</>;
  if (status === "declined") return <>You declined{where} · {time}</>;
  if (choice) {
    return (
      <>
        You chose <span className="font-medium text-foreground">{choice}</span>
        {where} · {time}
      </>
    );
  }
  return <>You answered{where} · {time}</>;
}

/**
 * A question or an approval an agent asked. Open: answer with one click (an option, Approve / Decline) or in your own
 * words. Afterwards it is the record of what was asked, what was answered and when.
 *
 * In the thread the composer is the text box ("type your answer below"); in the inbox and on a task (`inline`) the card
 * has its own.
 */
export function QuestionCard({
  question,
  agentName: agentNameProp,
  answerable: answerableProp,
  streaming = false,
  inline = false,
  conversationId: conversationIdProp,
  className,
}: {
  question: QuestionView;
  agentName?: string;
  /** The run waits for this question right now. Default: what the thread's scope says. */
  answerable?: boolean;
  /** The agent is still finishing the step it asked in. */
  streaming?: boolean;
  /** Own text box (inbox, task) instead of "type your answer below" (thread). */
  inline?: boolean;
  conversationId?: string;
  className?: string;
}) {
  const scope = useContext(QuestionScope);
  const agentName = agentNameProp ?? scope?.agentName ?? "The agent";
  const conversationId = conversationIdProp ?? scope?.conversationId;
  const answer = useAnswerQuestion(conversationId);
  const now = useNow(30_000);
  const [note, setNote] = useState("");
  const [noting, setNoting] = useState(false);
  const [text, setText] = useState("");
  const [pressed, setPressed] = useState<string | null>(null);
  const titleId = useId();

  const q = question;
  const approval = q.kind === "approval";
  const open = q.status === "open";
  const answerable = open && !streaming && (answerableProp ?? scope?.openId === q.id);
  // Open, but the run no longer waits for it (and isn't about to): it was stopped before the answer came.
  const lost = open && !streaming && answerableProp === undefined && scope !== null && scope.openId !== q.id;
  const busy = answer.isPending;

  const send = (key: string, input: AnswerQuestionInput) => {
    setPressed(key);
    answer.mutate(
      { id: q.id, input },
      {
        onSuccess: () => {
          setText("");
          setNote("");
        },
        onSettled: () => setPressed(null),
      },
    );
  };

  const asked =
    now - new Date(q.askedAt).getTime() < 60_000 ? "just now" : formatDistanceStrict(new Date(q.askedAt), now, { addSuffix: true, roundingMethod: "floor" });

  if (q.status === "withdrawn" || lost) {
    return (
      <div className={cn("rounded-xl border border-dashed bg-muted/30 px-3.5 py-3 text-muted-foreground", className)} role="group" aria-labelledby={titleId}>
        <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
          <CircleSlash className="size-3.5" aria-hidden />
          {approval ? "Approval withdrawn" : "Question withdrawn"}
        </div>
        <p id={titleId} className="mt-1 text-[13px] text-foreground/70 line-through decoration-muted-foreground/40">
          {q.title}
        </p>
        <p className="mt-1 text-xs">{q.closedReason ? q.closedReason : "The run was stopped before this was answered."}</p>
      </div>
    );
  }

  const settled = !open && q.answer;
  const chosen = settled && q.answer!.optionId ? q.options.find((o) => o.id === q.answer!.optionId) : undefined;

  return (
    <div
      role="group"
      id={inline ? undefined : `question-${q.id}`}
      aria-labelledby={titleId}
      className={cn(
        "scroll-mt-4 rounded-xl border bg-card px-3.5 py-3 shadow-card",
        open && "border-l-[3px] border-l-warning",
        q.status === "approved" && "border-success/30",
        className,
      )}
    >
      <div className={cn("flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase", open ? "text-warning" : "text-muted-foreground")}>
        {approval ? <ShieldCheck className="size-3.5" aria-hidden /> : <MessageCircleQuestion className="size-3.5" aria-hidden />}
        <span>{approval ? (open ? "Needs your OK" : "Approval") : "Question"}</span>
        <span className="font-normal tracking-normal normal-case text-muted-foreground">· asked {asked}</span>
      </div>

      {approval ? (
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
          <dt className="text-muted-foreground">What</dt>
          <dd id={titleId} className="min-w-0 font-medium break-words">
            {q.title}
          </dd>
          {q.body && (
            <>
              <dt className="text-muted-foreground">Why</dt>
              <dd className="min-w-0">
                <Markdown className="text-[13px]">{q.body}</Markdown>
              </dd>
            </>
          )}
          {q.affects && (
            <>
              <dt className="text-muted-foreground">Affects</dt>
              <dd className="min-w-0 break-words">{q.affects}</dd>
            </>
          )}
        </dl>
      ) : (
        <>
          <p id={titleId} className="mt-1 text-[14px] leading-snug font-medium break-words">
            {q.title}
          </p>
          {q.body && <Markdown className="mt-1 text-[13px] text-muted-foreground">{q.body}</Markdown>}
        </>
      )}

      {!approval && q.options.length > 0 && (
        <div className="mt-2.5 grid gap-1.5">
          {q.options.map((o, i) => {
            const picked = chosen?.id === o.id;
            return (
              <Button
                key={o.id}
                type="button"
                variant={open && o.recommended ? "default" : "outline"}
                disabled={!answerable || busy}
                aria-pressed={picked || undefined}
                onClick={() => send(o.id, { optionId: o.id })}
                className={cn(
                  "h-auto min-h-9 w-full justify-start gap-2.5 px-3 py-2 text-left whitespace-normal",
                  !open && !picked && "opacity-55",
                  picked && "border-primary/40 bg-primary/[0.06] opacity-100 disabled:opacity-100",
                )}
              >
                <span className="grid size-5 shrink-0 place-items-center rounded-md border border-current/25 text-[11px] tabular-nums" aria-hidden>
                  {pressed === o.id ? <Spinner className="size-3" /> : picked ? <Check className="size-3" /> : i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium">{o.label}</span>
                  {o.description && <span className="block text-xs font-normal opacity-75">{o.description}</span>}
                </span>
                {o.recommended && (
                  <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium", open ? "bg-primary-foreground/15" : "bg-muted text-muted-foreground")}>
                    Recommended
                  </span>
                )}
              </Button>
            );
          })}
        </div>
      )}

      {approval && open && (
        <div className="mt-2.5 space-y-2">
          {noting && (
            <Textarea
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={`Note for ${agentName} (optional)`}
              aria-label={`Note for ${agentName}`}
              className="min-h-16 text-[13px]"
              maxLength={2000}
            />
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" disabled={!answerable || busy} onClick={() => send("approve", { decision: "approve", ...(note.trim() ? { note: note.trim() } : {}) })}>
              {pressed === "approve" ? <Spinner /> : <Check />} Approve
            </Button>
            <Button size="sm" variant="outline" disabled={!answerable || busy} onClick={() => send("decline", { decision: "decline", ...(note.trim() ? { note: note.trim() } : {}) })}>
              {pressed === "decline" ? <Spinner /> : <X />} Decline
            </Button>
            {!noting && (
              <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={!answerable || busy} onClick={() => setNoting(true)}>
                Add a note
              </Button>
            )}
          </div>
        </div>
      )}

      {open && inline && (
        <form
          className="mt-2.5 flex items-end gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) send("text", { text: text.trim() });
          }}
        >
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (text.trim() && answerable && !busy) send("text", { text: text.trim() });
              }
            }}
            placeholder={approval ? `Or tell ${agentName} what to do instead…` : q.options.length ? "Or answer in your own words…" : `Answer ${agentName}…`}
            aria-label={`Answer ${agentName}`}
            disabled={!answerable || busy}
            className="min-h-9 flex-1 resize-none py-2 text-[13px]"
            rows={1}
            maxLength={20_000}
          />
          <Button type="submit" size="icon" aria-label="Send answer" disabled={!answerable || busy || !text.trim()}>
            {pressed === "text" ? <Spinner /> : <SendHorizontal />}
          </Button>
        </form>
      )}

      {open && !inline && (
        <p className="mt-2 text-xs text-muted-foreground">
          {streaming
            ? `${agentName} is finishing the step it was in…`
            : approval
              ? "Or reply below — your message counts as the answer."
              : `Or type your answer below — sending it answers ${agentName}.`}
        </p>
      )}

      {settled && (
        <div className="mt-2.5 border-t pt-2 text-xs text-muted-foreground">
          <p className={cn("flex items-center gap-1.5", q.status === "approved" && "text-success")}>
            {q.status === "declined" ? <X className="size-3.5" aria-hidden /> : <CircleCheck className="size-3.5" aria-hidden />}
            <span>{answeredLine(q.answer!, q.status, chosen?.label ?? null)}</span>
          </p>
          {!chosen && q.answer!.text && <p className="mt-1.5 rounded-lg bg-muted/60 px-2.5 py-1.5 text-[13px] whitespace-pre-wrap text-foreground">{q.answer!.text}</p>}
        </div>
      )}
    </div>
  );
}
