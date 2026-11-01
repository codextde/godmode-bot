import { useLayoutEffect, useRef, type ReactNode } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import type { MessageBlock } from "@godmode/shared";
import { PanelRightClose } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useEasyMode } from "@/lib/mode";
import { PANEL } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { useToolContext } from "@/components/chat/message-blocks";
import { SubagentAvatar, SubagentBody, Timer, TypeChip, useSubagentView, type ParentAgent } from "@/components/chat/subagents";

type ToolUseBlock = Extract<MessageBlock, { type: "tool_use" }>;

export function findSubagent(sources: MessageBlock[][], id: string): { block: ToolUseBlock; children: MessageBlock[]; index: number } | null {
  for (let index = 0; index < sources.length; index++) {
    const blocks = sources[index]!;
    const block = blocks.find((b): b is ToolUseBlock => b.type === "tool_use" && b.id === id);
    if (block) return { block, children: blocks.filter((b) => "parentToolUseId" in b && b.parentToolUseId === id), index };
  }
  return null;
}

export function SubagentPanel({
  block,
  childBlocks,
  streaming,
  agent,
  onHide,
}: {
  block: ToolUseBlock;
  childBlocks: MessageBlock[];
  streaming: boolean;
  agent?: ParentAgent;
  onHide: () => void;
}) {
  const { t } = useTranslation("chat");
  const easy = useEasyMode();
  const ctx = useToolContext(childBlocks);
  const view = useSubagentView(block, childBlocks, streaming, ctx);
  const { task, background, running, phase } = view;
  const width = "min(45vw, 640px)";
  const kind = easy
    ? background
      ? t("blocks.subagent.helperBackground")
      : t("blocks.subagent.helper")
    : background
      ? t("blocks.subagent.backgroundSubagent")
      : t("blocks.subagent.subagent");

  const body = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = body.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [childBlocks, view.result]);

  return (
    <motion.aside
      aria-label={view.meta.title}
      initial={{ width: 0, opacity: 0 }}
      animate={{ width, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={PANEL}
      className="h-full shrink-0 overflow-hidden border-l bg-paper-2"
    >
      <div className="flex h-full flex-col" style={{ width }}>
        <header className="flex h-12 shrink-0 items-center gap-2.5 border-b px-3">
          <SubagentAvatar agent={agent} phase={phase} size={26} seed={block.id} />
          <div className="min-w-0 flex-1">
            <p className="flex min-w-0 items-center gap-2">
              <span className={cn("truncate text-[13px] font-medium", running && "text-shimmer")}>{view.meta.title}</span>
              <TypeChip type={view.type} />
            </p>
            <p className="truncate text-[11.5px] text-muted-foreground">
              {kind}
              {view.stats.length > 0 && <span className="tabular-nums"> · {view.stats.join(" · ")}</span>}
            </p>
          </div>
          <Timer since={task?.startedAt} durationMs={task?.durationMs} running={running} />
          <IconAction label={t("blocks.subagent.closeSide")} onClick={onHide}>
            <PanelRightClose />
          </IconAction>
        </header>
        {running && view.status && (
          <div className="shrink-0 truncate border-b px-3.5 py-1.5 text-xs text-foreground/80">{view.status}</div>
        )}
        <div
          ref={body}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }}
          className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3"
        >
          <SubagentBody childBlocks={childBlocks} running={running} background={background} result={view.result} agent={agent} />
        </div>
      </div>
    </motion.aside>
  );
}

function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" onClick={onClick} aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
