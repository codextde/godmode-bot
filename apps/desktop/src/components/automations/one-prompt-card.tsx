import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import type { ConversationWithMessages, RoutineTriggerType } from "@godmode/shared";
import { api, errorMessage, isLicenseRequired } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useAllAgents, useBootstrap, useScopeWorkspace } from "@/lib/hooks";
import { modKey } from "@/lib/desktop";
import { useDraft } from "@/lib/drafts";
import { cn } from "@/lib/utils";
import { Backdrop } from "@/components/brand";
import { Kbd } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { TRIGGER_TYPES } from "./trigger-meta";

const EXAMPLES: { kind: RoutineTriggerType; text: string }[] = [
  { kind: "schedule", text: "Every Monday at 9:00, collect last week's numbers and write a report" },
  { kind: "schedule", text: "Every weekday, start sometime between 8:00 and 9:30 and work through my inbox" },
  { kind: "app", text: "When I get an email from a customer, draft a reply" },
  { kind: "app", text: "When a meeting is about to start, brief me on the attendees" },
  { kind: "app", text: "When someone posts in #support on Slack, draft an answer" },
  { kind: "condition", text: "When competitor pricing changes, compare it with ours and update the battlecard" },
];

/**
 * "Describe what to automate": hands the sentence to the Godmode orchestrator, which picks the trigger,
 * the agent and the steps in a chat. `compact` keeps it to a slim bar above a long list; it opens up on focus.
 */
export function OnePromptCard({ compact = false }: { compact?: boolean }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: boot } = useBootstrap();
  const { data: agents = [] } = useAllAgents();
  const workspace = useScopeWorkspace();
  const [text, setText, textDraft] = useDraft("automation:describe", "");
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const godmodeId = boot?.defaultAgentId ?? agents.find((a) => a.isDefault)?.id;
  const expanded = !compact || focused || text.trim().length > 0;

  const start = useMutation({
    mutationFn: () => api.chat.start({ agentId: godmodeId, content: `Set up an automation: ${text.trim()}`, workspaceId: workspace?.id }),
    onSuccess: (res) => {
      textDraft.discard();
      qc.setQueryData<ConversationWithMessages>(qk.conversation(res.conversation.id), {
        ...res.conversation,
        messages: [res.message],
        activeRunId: res.run.status === "queued" || res.run.status === "running" ? res.run.id : null,
        queue: [],
      });
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
      navigate(`/chat/${res.conversation.id}`);
    },
    onError: (err) => !isLicenseRequired(err) && toast.error("Couldn't reach Godmode", { description: errorMessage(err) }),
  });
  const canSubmit = text.trim().length > 3 && !start.isPending;
  const submit = () => canSubmit && start.mutate();

  return (
    <section
      aria-labelledby="one-prompt-title"
      className={cn("relative overflow-hidden rounded-2xl border bg-paper-2", compact ? "p-3 @md:p-4" : "p-4 @md:p-5 @2xl:p-6")}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      {!compact && <Backdrop className="opacity-60" rails={false} />}
      <div className="relative">
        {compact ? (
          <h2 id="one-prompt-title" className="mb-2.5 flex items-center gap-2 px-1 text-sm font-medium tracking-[-0.01em]">
            <Sparkles className="size-3.5 text-muted-foreground" />
            Describe what to automate
            <span className="hidden font-normal text-muted-foreground @xl:inline">— Godmode sets it up</span>
          </h2>
        ) : (
          <div className="mb-4 max-w-2xl">
            <div className="eyebrow flex items-center gap-2">
              <Sparkles className="size-3.5" /> Describe what to automate
            </div>
            <h2 id="one-prompt-title" className="heading-display mt-2 text-[24px] text-balance @2xl:text-[28px]">
              When it happens, Godmode gets to work.
            </h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              One sentence is enough — Godmode picks the trigger, the agent and the steps, and asks if anything is unclear.
            </p>
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className={cn(
            "rounded-xl border bg-card p-2 shadow-card transition",
            focused && "border-foreground/20 shadow-float",
            start.isPending && "glow-border",
          )}
        >
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            rows={expanded ? 3 : 1}
            placeholder="When a new email with an invoice arrives, save the PDF to Drive and log it in my sheet"
            aria-label="Describe what to automate"
            className="block w-full resize-none bg-transparent px-3 py-2 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground/70"
          />
          <div className="flex items-center gap-2 px-1.5 pb-0.5">
            <span className="hidden items-center gap-1 text-xs text-muted-foreground @xl:flex">
              <Kbd>{modKey}</Kbd>
              <Kbd>↵</Kbd>
            </span>
            <Button type="submit" size={compact ? "sm" : "default"} disabled={!canSubmit} className="ml-auto">
              {start.isPending ? <Spinner /> : <Sparkles />}
              Set it up
            </Button>
          </div>
        </form>

        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
              className="overflow-hidden"
            >
              <div className="flex flex-wrap gap-2 pt-3" aria-label="Examples">
                {EXAMPLES.map((ex) => {
                  const Icon = TRIGGER_TYPES[ex.kind].icon;
                  return (
                    <button
                      key={ex.text}
                      type="button"
                      // Keep focus in the textarea so a compact card doesn't fold up mid-click.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setText(ex.text);
                        textareaRef.current?.focus();
                      }}
                      title={TRIGGER_TYPES[ex.kind].title}
                      className="group flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1 text-left text-xs text-muted-foreground shadow-card transition hover:border-foreground/20 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      <Icon className="size-3.5 shrink-0 transition group-hover:text-foreground" />
                      {ex.text}
                    </button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
