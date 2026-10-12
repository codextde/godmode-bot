import { Link } from "react-router";
import { format } from "date-fns";
import { ArrowUpRight, Phone } from "lucide-react";
import type { Message, MessageBlock } from "@godmode/shared";
import { cn } from "@/lib/utils";
import { CALL_STATUS, callName } from "./call-parts";

type CallBlock = Extract<MessageBlock, { type: "call" }>;

export function callBlock(message: Message): CallBlock | null {
  return (message.blocks.find((b) => b.type === "call") as CallBlock | undefined) ?? null;
}

/** Where the chat went on after a call ended: who it was with, how it went, and a way to the whole call. */
export function CallMarker({ block }: { block: CallBlock }) {
  const status = CALL_STATUS[block.status];
  const name = callName({ contactName: block.contactName, number: block.number, direction: "outbound" });
  return (
    <div role="note" className="flex justify-center">
      <Link
        to={`/calls?call=${block.callId}`}
        className="group flex w-full max-w-md items-start gap-3 rounded-xl border bg-card px-3 py-2.5 text-left shadow-card transition outline-none hover:border-foreground/15 focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span className="mt-px grid size-8 shrink-0 place-items-center rounded-lg border bg-paper-2 text-brand-strong">
          <Phone className="size-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 leading-snug">
          <span className="flex flex-wrap items-baseline gap-x-1.5 text-[13px]">
            <span className="font-medium">Call with {name} ended</span>
            <span className={cn("text-xs", block.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
              {block.status === "done" ? "" : `${status.label} · `}
              <time dateTime={block.at} className="tabular-nums">
                {format(new Date(block.at), "HH:mm")}
              </time>
            </span>
          </span>
          {block.outcome && <span className="mt-0.5 line-clamp-1 text-xs text-foreground/80">{block.outcome}</span>}
          {block.summary && <span className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{block.summary}</span>}
        </span>
        <ArrowUpRight className="mt-0.5 size-4 shrink-0 text-muted-foreground transition group-hover:text-foreground" aria-hidden />
      </Link>
    </div>
  );
}
