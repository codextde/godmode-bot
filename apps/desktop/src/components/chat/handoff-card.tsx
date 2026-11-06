import { useEffect } from "react";
import { Link, useMatch, useNavigate } from "react-router";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import type { MessageBlock } from "@godmode/shared";
import { ArrowUpRight, Loader2, MessageSquareShare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useReduceAnimations } from "@/lib/motion";
import { takeHandoff } from "@/stores/handoff";

type ToolUseBlock = Extract<MessageBlock, { type: "tool_use" }>;

/** The chat a `chat_handoff` call opened. */
export function handoffChatOf(block: ToolUseBlock): string | null {
  return block.isError ? null : (/\((cnv_[A-Za-z0-9_-]+)\)/.exec(block.result ?? "")?.[1] ?? null);
}

/** Where the agent went on in a fresh chat. Opens it right away when the human asked for it in this chat. */
export function HandoffCard({ block, streaming }: { block: ToolUseBlock; streaming: boolean }) {
  const reduce = useReduceAnimations();
  const { t } = useTranslation(["chat", "common"]);
  const navigate = useNavigate();
  const here = useMatch("/chat/:conversationId")?.params.conversationId;
  const input = (block.input ?? {}) as { title?: string };
  const id = handoffChatOf(block);
  const pending = streaming && block.result === undefined && !block.isError;
  const failed = !!block.isError;

  useEffect(() => {
    if (id && streaming && here && takeHandoff(here)) navigate(`/chat/${id}`);
  }, [id, streaming, here, navigate]);

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn("flex items-center gap-3 rounded-xl border bg-card p-2.5 pr-3 shadow-card", failed && "border-destructive/30")}
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-lg border bg-gradient-to-br from-brand-soft to-transparent text-brand-strong">
        {pending ? <Loader2 className="size-[18px] animate-spin" /> : <MessageSquareShare className="size-[18px]" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium tracking-[-0.01em]">{input.title || t("blocks.handoff.newChat")}</p>
        <p className={cn("truncate text-xs", failed ? "text-destructive" : "text-muted-foreground")}>
          {failed ? block.result || t("blocks.handoff.failed") : pending ? t("blocks.handoff.starting") : t("blocks.handoff.continued")}
        </p>
      </div>
      {id && (
        <Button asChild size="sm" variant="outline" className="shrink-0">
          <Link to={`/chat/${id}`}>
            {t("common:actions.open")} <ArrowUpRight />
          </Link>
        </Button>
      )}
    </motion.div>
  );
}
