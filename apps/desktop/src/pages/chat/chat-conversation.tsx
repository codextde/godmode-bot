import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence } from "motion/react";
import type { Agent, ConversationWithMessages, Message, SendMessageInput } from "@godmode/shared";
import { ArrowUpRight, Brain, MessageSquareDashed, Sparkles, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentAvatar, EmptyState } from "@/components/common";
import { BrowserFocus, BrowserPanel, BrowserToggle, useChatBrowser, type BrowserFocusMode } from "@/components/chat/browser-panel";
import { Composer, type ComposerHandle } from "@/components/chat/composer";
import { ConversationHeader } from "@/components/chat/conversation-header";
import { ChatDropZone, Thread } from "@/components/chat/thread";
import { liveActivityLabel } from "@/components/chat/messages";
import { VoiceMode } from "@/components/chat/voice-mode";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useVoiceSettings } from "@/hooks/use-voice";
import { api, ApiRequestError, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useAllAgents, useConversation } from "@/lib/hooks";
import { onServerEvent } from "@/lib/realtime";
import { speak, useVoicePrefs, useVoiceSession } from "@/lib/voice";
import { useConversationLiveRun, type LiveRun } from "@/stores/live";
import { useUi } from "@/stores/ui";

export default function ChatConversation() {
  const { conversationId = "" } = useParams();
  // Remount per conversation so scroll, drafts and transient state reset cleanly.
  return <ConversationView key={conversationId} conversationId={conversationId} />;
}

function ConversationView({ conversationId }: { conversationId: string }) {
  const qc = useQueryClient();
  const key = qk.conversation(conversationId);
  const { data: conv, isLoading, error } = useConversation(conversationId);
  const { data: agents = [] } = useAllAgents();
  const agent = agents.find((a) => a.id === conv?.agentId);
  const live = useConversationLiveRun(conversationId);
  const voiceSettings = useVoiceSettings();
  const setVoiceMode = useUi((s) => s.setVoiceMode);
  const armVoice = useVoiceSession((s) => s.arm);
  const markVoiceRun = useVoiceSession((s) => s.markVoiceRun);
  const composerRef = useRef<ComposerHandle>(null);
  const [queued, setQueued] = useState<Record<string, string>>({});
  const mountedAt = useRef(Date.now());
  const browser = useChatBrowser(agent);
  const browserPanel = useUi((s) => s.browserPanel);
  const setBrowserPanel = useUi((s) => s.setBrowserPanel);
  const wide = useMediaQuery("(min-width: 1024px)");
  const [browserFocus, setBrowserFocus] = useState<BrowserFocusMode | null>(null);
  const showBrowserPanel = !!browser?.running && !!agent && wide && browserPanel;
  useEffect(() => setBrowserFocus(null), [browser?.id]);

  const messages = useMemo(() => conv?.messages ?? [], [conv?.messages]);
  const activeRunId = live?.runId ?? conv?.activeRunId ?? null;
  const busyRef = useRef(false);
  busyRef.current = !!activeRunId;

  // Keep the last live turn on screen until the stored message replaces it (no flicker on finish).
  const [linger, setLinger] = useState<LiveRun | null>(null);
  const prevLive = useRef<LiveRun | null>(null);
  useEffect(() => {
    if (prevLive.current && !live) {
      setLinger(prevLive.current);
      const t = setTimeout(() => setLinger(null), 10_000);
      prevLive.current = null;
      return () => clearTimeout(t);
    }
    prevLive.current = live;
  }, [live]);
  const lingerDone = !!linger && messages.some((m) => m.id === linger.messageId || (m.role === "assistant" && m.runId === linger.runId));
  const shownLinger = linger && !lingerDone && !live ? linger : null;

  // Hide the stored copy of the in-flight assistant message while it streams.
  const visibleMessages = useMemo(
    () => (live ? messages.filter((m) => m.id !== live.messageId && !(m.role === "assistant" && m.runId === live.runId)) : messages),
    [messages, live],
  );

  const queuedIds = useMemo(() => {
    const set = new Set<string>();
    for (const [messageId, runId] of Object.entries(queued)) {
      const started = live?.runId === runId || messages.some((m) => m.role === "assistant" && m.runId === runId);
      if (!started) set.add(messageId);
    }
    return set;
  }, [queued, live, messages]);

  const inflight = live
    ? { live, startedAt: live.startedAt, runId: live.runId }
    : shownLinger
      ? { live: shownLinger, startedAt: shownLinger.startedAt, runId: null }
      : conv?.activeRunId
        ? { live: null, startedAt: mountedAt.current, runId: conv.activeRunId }
        : null;

  const send = useMutation({
    mutationFn: (input: SendMessageInput) => api.conversations.send(conversationId, input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: key });
      const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const optimistic: Message = {
        id: tempId,
        conversationId,
        role: "user",
        content: input.content,
        blocks: [],
        runId: null,
        attachments: (input.attachments ?? []).map((a) => ({ name: a.name, mime: a.mime, path: "", size: Math.round((a.data.length * 3) / 4) })),
        createdAt: new Date().toISOString(),
      };
      qc.setQueryData<ConversationWithMessages>(key, (old) => (old ? { ...old, messages: [...old.messages, optimistic] } : old));
      return { tempId, wasBusy: busyRef.current };
    },
    onSuccess: (res, input, ctx) => {
      qc.setQueryData<ConversationWithMessages>(key, (old) =>
        old
          ? {
              ...old,
              messages: old.messages.some((m) => m.id === res.message.id)
                ? old.messages.filter((m) => m.id !== ctx.tempId)
                : old.messages.map((m) => (m.id === ctx.tempId ? res.message : m)),
              activeRunId: old.activeRunId ?? (res.run.status === "queued" || res.run.status === "running" ? res.run.id : null),
            }
          : old,
      );
      if (ctx.wasBusy || res.run.status === "queued") setQueued((q) => ({ ...q, [res.message.id]: res.run.id }));
      if (input.voice) markVoiceRun(res.run.id);
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
    },
    onError: (err, _input, ctx) => {
      if (ctx) qc.setQueryData<ConversationWithMessages>(key, (old) => (old ? { ...old, messages: old.messages.filter((m) => m.id !== ctx.tempId) } : old));
      toast.error("Message not sent", { description: errorMessage(err) });
    },
  });

  const cancel = useMutation({
    mutationFn: (runId: string) => api.runs.cancel(runId),
    onSuccess: () => toast("Stopping the agent…"),
    onError: (err) => toast.error("Couldn't stop the run", { description: errorMessage(err) }),
  });

  // Read replies aloud: speak-replies toggle, or a dictated message with auto-speak on. Voice mode speaks by itself.
  const settingsRef = useRef(voiceSettings);
  settingsRef.current = voiceSettings;
  useEffect(
    () =>
      onServerEvent((e) => {
        if (e.type !== "run.finished" || e.run.conversationId !== conversationId) return;
        if (useUi.getState().voiceMode || e.run.status !== "succeeded") return;
        const wasVoice = !!useVoiceSession.getState().voiceRunIds[e.run.id];
        const wanted = useVoicePrefs.getState().speakReplies || (wasVoice && (settingsRef.current?.autoSpeak ?? true));
        if (!wanted) return;
        const runId = e.run.id;
        void qc
          .fetchQuery({ queryKey: qk.conversation(conversationId), queryFn: () => api.conversations.get(conversationId), staleTime: 0 })
          .catch(() => null)
          .then((fresh) => {
            const m = fresh?.messages.findLast((x) => x.role === "assistant" && x.runId === runId);
            const text = e.run.result || m?.content || "";
            if (text) void speak(text, settingsRef.current, { key: m?.id ?? `run:${runId}` }).catch(() => {});
          });
      }),
    [conversationId, qc],
  );

  const onVoiceMode = () => {
    armVoice(true);
    setVoiceMode(true);
  };

  if (error) {
    const notFound = error instanceof ApiRequestError && error.status === 404;
    return (
      <div className="grid h-full place-items-center p-8">
        <EmptyState
          icon={<MessageSquareDashed />}
          title={notFound ? "This chat doesn't exist anymore" : "Couldn't load this chat"}
          description={notFound ? "It may have been deleted." : errorMessage(error)}
          action={
            <Button asChild>
              <Link to="/">Start a new chat</Link>
            </Button>
          }
        />
      </div>
    );
  }

  if (isLoading || !conv) return <ConversationSkeleton />;

  const lastMessage = messages[messages.length - 1] ?? null;

  return (
    <div className="flex h-full min-h-0">
      <ChatDropZone onFiles={(files) => composerRef.current?.addFiles(files)} className="flex h-full min-w-0 flex-1 flex-col">
        <ConversationHeader
          conversation={conv}
          agent={agent}
          onVoiceMode={onVoiceMode}
          browserToggle={
            browser?.running && !showBrowserPanel ? (
              <BrowserToggle working={!!activeRunId} onClick={() => (wide ? setBrowserPanel(true) : setBrowserFocus("watch"))} />
            ) : undefined
          }
        />

        <Thread
          messages={visibleMessages}
          agent={agent}
          inflight={inflight}
          queuedMessageIds={queuedIds}
          onStop={() => activeRunId && cancel.mutate(activeRunId)}
          stopping={cancel.isPending}
          empty={
            <ConversationWelcome agent={agent} onPick={(text) => composerRef.current?.setText(text)} />
          }
        />

        <div className="relative shrink-0 px-3 pb-3 sm:px-6 sm:pb-4">
          <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-8 h-8 bg-gradient-to-t from-background to-transparent" />
          <div className="mx-auto w-full max-w-3xl">
            <Composer
              ref={composerRef}
              draftKey={conversationId}
              autoFocus
              running={!!activeRunId}
              placeholder={agent ? `Message ${agent.name}…` : "Message…"}
              onSubmit={(input) => send.mutateAsync(input)}
            />
            <p className="mt-2 hidden text-center text-[11px] text-muted-foreground/80 sm:block">
              Agents act for you with your saved logins — secrets are filled into the browser, never shown to the AI.
            </p>
          </div>
        </div>

        <VoiceMode
          agent={agent}
          busy={!!activeRunId || send.isPending}
          activity={live ? liveActivityLabel(live) : null}
          lastMessage={lastMessage}
          onSend={async (text) => {
            await send.mutateAsync({ content: text, voice: true });
          }}
          onStop={activeRunId ? () => cancel.mutate(activeRunId) : undefined}
        />
      </ChatDropZone>
      <AnimatePresence initial={false}>
        {showBrowserPanel && (
          <BrowserPanel
            key={browser.id}
            profile={browser}
            agent={agent}
            activity={activeRunId ? liveActivityLabel(live) : null}
            onHide={() => setBrowserPanel(false)}
            onFocus={setBrowserFocus}
          />
        )}
      </AnimatePresence>
      <BrowserFocus profile={browser} mode={browserFocus} onClose={() => setBrowserFocus(null)} />
    </div>
  );
}

function ConversationWelcome({ agent, onPick }: { agent?: Agent; onPick: (text: string) => void }) {
  const ideas = agent?.isDefault
    ? [
        { icon: Sparkles, text: "What can you do for me?" },
        { icon: Wand2, text: "Create an agent that checks my inbox every morning and summarizes it" },
        { icon: Brain, text: "What do you remember about me?" },
      ]
    : [
        { icon: Sparkles, text: "What can you do for me?" },
        { icon: Wand2, text: "Run your usual task now and tell me what you found" },
        { icon: Brain, text: "What have you learned so far?" },
      ];
  return (
    <div className="flex flex-col items-center pt-[10vh] text-center">
      {agent && <AgentAvatar agent={agent} size="xl" className="animate-float" />}
      <h2 className="heading-display mt-6 text-[32px]">
        {agent?.name ?? "Your agent"}. <span className="text-muted-foreground">Ready when you are.</span>
      </h2>
      {agent?.description && <p className="mt-3 max-w-md text-sm text-muted-foreground">{agent.description}</p>}
      <div className="mt-8 grid w-full max-w-lg overflow-hidden rounded-xl border bg-card shadow-card">
        {ideas.map(({ icon: Icon, text }) => (
          <button
            key={text}
            type="button"
            onClick={() => onPick(text)}
            className="group flex items-center gap-3 border-b px-4 py-3 text-left text-sm transition last:border-b-0 hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
          >
            <Icon className="size-4 shrink-0 text-muted-foreground transition group-hover:text-foreground" />
            <span className="flex-1">{text}</span>
            <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
          </button>
        ))}
      </div>
    </div>
  );
}

function ConversationSkeleton() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-3 border-b px-4">
        <Skeleton className="size-6 rounded-md" />
        <Skeleton className="h-4 w-48" />
      </div>
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 pt-8">
        <Skeleton className="ml-auto h-10 w-2/5 rounded-2xl" />
        <div className="flex gap-3">
          <Skeleton className="size-9 rounded-xl" />
          <div className="flex-1 space-y-2.5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </div>
        <Skeleton className="ml-auto h-10 w-1/3 rounded-2xl" />
      </div>
      <div className="mx-auto w-full max-w-3xl px-6 pb-6">
        <Skeleton className="h-28 w-full rounded-2xl" />
      </div>
    </div>
  );
}
