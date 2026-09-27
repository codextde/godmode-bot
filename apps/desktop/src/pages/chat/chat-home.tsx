import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNowStrict } from "date-fns";
import { motion } from "motion/react";
import type { Agent, Conversation, ConversationWithMessages, StartChatInput } from "@godmode/shared";
import { ArrowRight, Bell, Pin, Receipt, Telescope, Mail } from "lucide-react";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { Backdrop } from "@/components/brand";
import { AgentAvatar, Kbd } from "@/components/common";
import { LiveDot, WorkingTicks } from "@/components/aicss/Motion";
import { Orb } from "@/components/aicss/Orb";
import { AgentPicker } from "@/components/chat/agent-picker";
import { Composer, type ComposerHandle } from "@/components/chat/composer";
import { ChatDropZone } from "@/components/chat/thread";
import { liveActivityLabel, useNow } from "@/components/chat/messages";
import { VoiceMode } from "@/components/chat/voice-mode";
import { formatElapsed } from "@/components/runs/run-status";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useAllAgents, useBootstrap, useConversations } from "@/lib/hooks";
import { modKey } from "@/lib/desktop";
import { useVoiceSession } from "@/lib/voice";
import { useLive, type LiveRun } from "@/stores/live";
import { cn } from "@/lib/utils";

const SUGGESTIONS = [
  { icon: Mail, text: "Summarize my unread emails" },
  { icon: Receipt, text: "Create an agent that downloads my invoices every month" },
  { icon: Bell, text: "Log into GitHub and check my notifications" },
  { icon: Telescope, text: "Research competitors and write a report" },
];

/** Chat previews are raw markdown — strip the syntax so cards read as plain sentences. */
function plainPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\s*\|?\s*:?-{3,}:?)+/g, " ")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/(\s*\|\s*)+/g, " · ")
    .replace(/\s+/g, " ")
    .replace(/^[\s·]+|[\s·]+$/g, "")
    .trim();
}

function greeting(date: Date): string {
  const h = date.getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  if (h < 22) return "Good evening";
  return "Good night";
}

const fade = (delay: number) => ({
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.5, delay, ease: [0.2, 0.8, 0.2, 1] as const },
});

export default function ChatHome() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const { data: boot } = useBootstrap();
  const { data: agents = [], isLoading: agentsLoading } = useAllAgents();
  const markVoiceRun = useVoiceSession((s) => s.markVoiceRun);
  const composerRef = useRef<ComposerHandle>(null);
  const [agentId, setAgentId] = useState<string | null>(null);

  const available = useMemo(() => agents.filter((a) => a.enabled), [agents]);
  const selected =
    available.find((a) => a.id === agentId) ??
    available.find((a) => a.id === boot?.defaultAgentId) ??
    available.find((a) => a.isDefault) ??
    available[0];

  // Deep links: /?prompt=…&agent=…
  useEffect(() => {
    const prompt = params.get("prompt");
    const agent = params.get("agent");
    if (!prompt && !agent) return;
    if (agent) setAgentId(agent);
    if (prompt) requestAnimationFrame(() => composerRef.current?.setText(prompt));
    setParams({}, { replace: true });
  }, [params, setParams]);

  const start = useMutation({
    mutationFn: (input: StartChatInput) => api.chat.start(input),
    onSuccess: (res, input) => {
      qc.setQueryData<ConversationWithMessages>(qk.conversation(res.conversation.id), {
        ...res.conversation,
        messages: [res.message],
        activeRunId: res.run.status === "queued" || res.run.status === "running" ? res.run.id : null,
      });
      if (input.voice) markVoiceRun(res.run.id);
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
      navigate(`/chat/${res.conversation.id}`);
    },
    onError: (err) => toast.error("Couldn't start the chat", { description: errorMessage(err) }),
  });

  const userName = boot?.settings.general.userName?.trim();
  const now = new Date();

  const ready = available.length;

  return (
    <ChatDropZone onFiles={(files) => composerRef.current?.addFiles(files)} className="relative min-h-full">
      <Backdrop />

      <div className="relative mx-auto flex w-full max-w-3xl flex-col items-center px-5 pt-[12vh] pb-10 text-center sm:px-8">
        <motion.div {...fade(0)}>
          <span className="inline-flex items-center gap-2 rounded-full border bg-card py-1 pr-3 pl-2.5 text-xs text-muted-foreground shadow-card">
            <LiveDot />
            {format(now, "EEEE, MMMM d")}
            {ready > 0 && (
              <>
                <span className="opacity-40">·</span>
                {ready === 1 ? "1 agent ready" : `${ready} agents ready`}
              </>
            )}
          </span>
        </motion.div>
        <motion.h1 {...fade(0.05)} className="heading-display mt-6 text-[40px] sm:text-[52px]">
          {greeting(now)}
          {userName ? `, ${userName}` : ""}.
          <span className="block text-foreground/35">What should we get done?</span>
        </motion.h1>

        <motion.div {...fade(0.12)} className="mt-9 w-full text-left">
          <Composer
            ref={composerRef}
            size="lg"
            autoFocus
            draftKey="home"
            busy={start.isPending}
            placeholder={selected ? `Ask ${selected.name} anything, or hand over a task…` : "Ask anything, or hand over a task…"}
            leading={
              agentsLoading ? (
                <Skeleton className="h-8 w-32 rounded-lg" />
              ) : (
                <AgentPicker agents={available} value={selected?.id ?? null} onChange={setAgentId} />
              )
            }
            onSubmit={(input) =>
              start.mutateAsync({
                agentId: selected?.id,
                content: input.content,
                attachments: input.attachments.length ? input.attachments : undefined,
                voice: input.voice || undefined,
              })
            }
          />
        </motion.div>

        <motion.div {...fade(0.18)} className="mt-4 flex flex-wrap justify-center gap-2">
          {SUGGESTIONS.map(({ icon: Icon, text }) => (
            <button
              key={text}
              type="button"
              onClick={() => composerRef.current?.setText(text)}
              className="group flex items-center gap-2 rounded-md border bg-card px-3 py-1.5 text-[13px] text-muted-foreground shadow-card transition hover:border-foreground/20 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <Icon className="size-3.5 transition group-hover:text-foreground" />
              {text}
            </button>
          ))}
        </motion.div>

        <motion.p {...fade(0.24)} className="mt-5 hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
          <Kbd>↵</Kbd> send <span className="opacity-40">·</span> <Kbd>⇧</Kbd>
          <Kbd>↵</Kbd> new line <span className="opacity-40">·</span> <Kbd>{modKey}K</Kbd> search <span className="opacity-40">·</span> drop files anywhere
        </motion.p>
      </div>

      <div className="relative mx-auto w-full max-w-5xl space-y-10 px-5 pb-16 sm:px-8">
        <RunningNow agents={agents} />
        <RecentChats agents={agents} />
      </div>

      <VoiceMode
        agent={selected}
        busy={start.isPending}
        onSend={async (text) => {
          await start.mutateAsync({ agentId: selected?.id, content: text, voice: true });
        }}
      />
    </ChatDropZone>
  );
}

function RunningNow({ agents }: { agents: Agent[] }) {
  const runs = useLive((s) => s.runs);
  const list = Object.values(runs);
  if (list.length === 0) return null;
  return (
    <section aria-label="Working now">
      <h2 className="eyebrow mb-3 flex items-center gap-2">
        <LiveDot />
        Working now
        <span className="rounded-[4px] border bg-card px-1 font-mono text-[10px] tabular-nums">{list.length}</span>
      </h2>
      <div className="-mx-2 flex gap-3 overflow-x-auto px-2 pt-1 pb-3">
        {list.map((r, i) => (
          <RunningCard key={r.runId} run={r} agent={agents.find((a) => a.id === r.agentId)} index={i} />
        ))}
      </div>
    </section>
  );
}

function RunningCard({ run, agent, index }: { run: LiveRun; agent?: Agent; index: number }) {
  const now = useNow(1000);
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.05 }} className="shrink-0">
      <Link
        to={`/chat/${run.conversationId}`}
        className="glow-border flex w-72 items-center gap-3 rounded-xl border bg-card p-3 shadow-card transition hover:border-foreground/20 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <AgentAvatar agent={agent ?? { id: run.agentId, avatar: "🤖", color: "violet" }} size="md" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <span className="truncate">{agent?.name ?? "Agent"}</span>
            <Orb variant="S3" size={14} label={liveActivityLabel(run)} />
          </span>
          <span className="text-shimmer block truncate text-xs font-medium">{liveActivityLabel(run)}</span>
        </span>
        <span className="flex flex-col items-end gap-1">
          <WorkingTicks count={6} className="h-3 text-brand-strong" />
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{formatElapsed(now - run.startedAt)}</span>
        </span>
      </Link>
    </motion.div>
  );
}

function RecentChats({ agents }: { agents: Agent[] }) {
  const { data: conversations = [], isLoading } = useConversations();
  const liveRuns = useLive((s) => s.runs);
  const running = useMemo(() => new Set(Object.values(liveRuns).map((r) => r.conversationId)), [liveRuns]);
  const recent = useMemo(
    () =>
      [...conversations]
        .filter((c) => !c.archived)
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt))
        .slice(0, 6),
    [conversations],
  );

  if (isLoading) {
    return (
      <section>
        <Skeleton className="mb-3 h-4 w-32" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      </section>
    );
  }
  if (recent.length === 0) return null;

  return (
    <section aria-label="Recent chats">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="eyebrow">Pick up where you left off</h2>
        <Link to="/agents" className="flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground">
          Your agents <ArrowRight className="size-3" />
        </Link>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {recent.map((c, i) => (
          <RecentCard key={c.id} conversation={c} agent={agents.find((a) => a.id === c.agentId)} running={running.has(c.id) || !!c.running} index={i} />
        ))}
      </div>
    </section>
  );
}

function RecentCard({ conversation: c, agent, running, index }: { conversation: Conversation; agent?: Agent; running: boolean; index: number }) {
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 + index * 0.04, duration: 0.35 }}>
      <Link
        to={`/chat/${c.id}`}
        className={cn(
          "group flex h-full flex-col gap-3 rounded-xl border bg-card p-4 shadow-card transition",
          "hover:border-foreground/15 hover:shadow-float focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
          running && "glow-border",
        )}
      >
        <div className="flex items-center gap-2">
          <AgentAvatar agent={agent ?? { avatar: "💬", color: "violet" }} size="sm" />
          <span className="truncate text-xs text-muted-foreground">{agent?.name ?? "Agent"}</span>
          {c.pinned && <Pin className="size-3 shrink-0 text-muted-foreground" />}
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {running ? (
              <span className="text-shimmer font-medium">Working…</span>
            ) : (
              formatDistanceToNowStrict(new Date(c.lastMessageAt ?? c.createdAt), { addSuffix: true })
            )}
          </span>
        </div>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-medium tracking-[-0.01em]">{c.title || "New chat"}</div>
          {c.preview && <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-muted-foreground">{plainPreview(c.preview)}</p>}
        </div>
      </Link>
    </motion.div>
  );
}
