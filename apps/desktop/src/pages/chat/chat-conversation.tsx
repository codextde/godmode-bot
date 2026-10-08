import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import type { Agent, BrowserProfile, ComputerTarget, ConversationWithMessages, Message, SendMessageInput, SshServer, Vm } from "@godmode/shared";
import { characterGreeting, computerTargetLabel } from "@godmode/shared";
import { Archive, ArchiveRestore, ArrowUpRight, Brain, MessageSquareDashed, MessageSquarePlus, Moon, Power, PowerOff, Sparkles, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { AgentAvatar, EmptyState } from "@/components/common";
import { SpeechBubble } from "@/components/character";
import { BrowserFocus, BrowserPanel, BrowserToggle, agentBrowserProfile, useChatBrowser, useChatTab, type BrowserFocusMode } from "@/components/chat/browser-panel";
import { BrowserProfileChip } from "@/components/browser/profile-chip";
import { ComputerFocus, ComputerPanel, ComputerShareChip, ComputerToggle, type ComputerFocusMode } from "@/components/computer/computer-panel";
import { useStartAgentChat, useToggleAgent } from "@/components/agents/agent-actions";
import { Composer, type ComposerHandle } from "@/components/chat/composer";
import { QueueTray, type QueueTrayHandle } from "@/components/chat/queue-tray";
import { useArchiveChat } from "@/components/chat/chat-actions";
import { ConversationHeader } from "@/components/chat/conversation-header";
import { useConversationMood } from "@/components/chat/conversation-mood";
import { FollowupBar } from "@/components/chat/followup";
import { HumanTaskBar } from "@/components/human-tasks/human-task-chat";
import { PauseBar, usePauseActions } from "@/components/chat/pause";
import { QuestionScopeProvider } from "@/components/chat/question-card";
import { ModelPicker, type ModelChoice } from "@/components/chat/model-picker";
import { FolderChip, folderName } from "@/components/chat/folder-picker";
import { InstructionsChip } from "@/components/instructions/instructions";
import { SshChip } from "@/components/ssh/ssh-chip";
import { RunnerOfflineBar, RunnerPill } from "@/components/runners/runner-chip";
import { VmChip, type InheritedVm } from "@/components/vms/vm-picker";
import { VmFocus, VmPanel, VmToggle, useChatVm } from "@/components/vms/vm-panel";
import { ChatDropZone } from "@/components/chat/drop-zone";
import { Thread } from "@/components/chat/thread";
import { TurnEnd } from "@/components/chat/turn-end";
import { ChatFilesScope } from "@/components/chat/local-files";
import { liveActivityLabel } from "@/components/chat/messages";
import { VoiceMode } from "@/components/chat/voice-mode";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useVoiceSettings } from "@/hooks/use-voice";
import { api, ApiRequestError, errorMessage, isLicenseRequired } from "@/lib/api";
import { newQueueId, pendingQueued, withPending } from "@/lib/pending-queue";
import { qk } from "@/lib/queryKeys";
import { useAllAgents, useBootstrap, useConversation, useRunners, useWorkspaces } from "@/lib/hooks";
import { onServerEvent, viewConversation } from "@/lib/realtime";
import { speak, useVoicePrefs, useVoiceSession } from "@/lib/voice";
import { useConversationLiveRun, type LiveRun } from "@/stores/live";
import { useUi } from "@/stores/ui";

const NO_INHERITED_VMS: InheritedVm[] = [];

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
  const { data: workspaces = [] } = useWorkspaces();
  const agentWorkspace = agent?.workspaceId ? workspaces.find((w) => w.id === agent.workspaceId) : undefined;
  const live = useConversationLiveRun(conversationId);
  const voiceSettings = useVoiceSettings();
  const voiceMode = useUi((s) => s.voiceMode);
  const setVoiceMode = useUi((s) => s.setVoiceMode);
  const armVoice = useVoiceSession((s) => s.arm);
  const markVoiceRun = useVoiceSession((s) => s.markVoiceRun);
  const composerRef = useRef<ComposerHandle>(null);
  useViewing(conversationId);
  const queueRef = useRef<QueueTrayHandle>(null);
  const mountedAt = useRef(Date.now());
  // A profile picked mid-run applies from the next message: keep showing the browser the running agent drives.
  const [runProfile, setRunProfile] = useState<{ runId: string; profileId: string | null } | null>(null);
  if ((live?.runId ?? null) !== (runProfile?.runId ?? null)) setRunProfile(live ? { runId: live.runId, profileId: conv?.browserProfileId ?? null } : null);
  const chatProfileId = runProfile ? runProfile.profileId : (conv?.browserProfileId ?? null);
  const chatBrowser = useChatBrowser(agent, chatProfileId, conv?.workspaceId ?? null);
  // A runner's chat browses in the runner's copy of this profile: its frames come over the link, and whether that
  // browser runs is the runner's business — the panels show what arrives.
  const browser = useMemo(
    () => (conv?.runnerId && chatBrowser ? { ...chatBrowser, running: true, chats: [] } : chatBrowser),
    [conv?.runnerId, chatBrowser],
  );
  // The panel appears once the agent opens this chat's own tab (other chats browse in theirs).
  const chatTab = useChatTab(browser, conversationId);
  const browserPanel = useUi((s) => s.browserPanel);
  const setBrowserPanel = useUi((s) => s.setBrowserPanel);
  // Opened by hand before there is a tab: stays for this chat and leaves the saved preference alone.
  const [browserOpened, setBrowserOpened] = useState(false);
  const wide = useMediaQuery("(min-width: 1024px)");
  const [browserFocus, setBrowserFocus] = useState<BrowserFocusMode | null>(null);
  const { setArchived } = useArchiveChat();
  // A chat that lives on a runner does its work there: this computer's folders, shared screens and VMs aren't part of
  // it, and nothing can be sent while the runner is away.
  const onRunner = !!conv?.runnerId;
  const { data: runners } = useRunners();
  const runner = conv?.runnerId ? (runners?.find((r) => r.id === conv.runnerId) ?? null) : null;
  const runnerAway = !!runner && runner.state !== "online";
  const computerTarget = onRunner ? null : (conv?.computerTarget ?? null);
  const computerPanel = useUi((s) => s.computerPanel);
  const setComputerPanel = useUi((s) => s.setComputerPanel);
  const [computerFocus, setComputerFocus] = useState<ComputerFocusMode | null>(null);
  const vmInherited = [
    agent?.vmId ? { vmId: agent.vmId, from: agent.name } : null,
    agentWorkspace?.vmId ? { vmId: agentWorkspace.vmId, from: `the ${agentWorkspace.name} workspace` } : null,
  ];
  // A chat that works in a VM does everything there: its panel shows the VM, not this Mac's browser or screen.
  const chatVm = useChatVm(onRunner ? null : (conv?.vmId ?? null), onRunner ? NO_INHERITED_VMS : vmInherited);
  const vmPanel = useUi((s) => s.vmPanel);
  const setVmPanel = useUi((s) => s.setVmPanel);
  const [vmFocus, setVmFocus] = useState(false);
  const showVmPanel = !!chatVm && !!agent && wide && vmPanel;
  // Something shared takes the side panel; the browser stays one click away in the header.
  const showComputerPanel = !chatVm && !!computerTarget && !!agent && wide && computerPanel;
  // On a runner this computer can't see the chat's tab before frames come: the panel shows while the agent works there.
  const browserActive = !!chatTab || (onRunner && !!live);
  const showBrowserPanel = !chatVm && !!browser && !!agent && wide && !showComputerPanel && (browserOpened || (browserActive && browserPanel));
  useEffect(() => setBrowserFocus(null), [browser?.id]);
  useEffect(() => {
    if (!computerTarget) setComputerFocus(null);
  }, [computerTarget]);

  const messages = useMemo(() => conv?.messages ?? [], [conv?.messages]);
  const queue = useMemo(() => conv?.queue ?? [], [conv?.queue]);
  const activeRunId = live?.runId ?? conv?.activeRunId ?? null;
  // The chat's run stands still (one that continues is live again before the chat says so). Runs that came after it wait.
  const paused = (conv?.paused && conv.paused.runId !== activeRunId && conv.paused) || null;
  const liveMood = useConversationMood(conversationId, messages, live);
  // The run waits for the human's answer to a question or an approval (the card in the thread asks it).
  const waiting = paused?.reason === "question" ? paused : null;
  const approval = waiting?.question?.kind === "approval";
  const mood = waiting
    ? { mood: "attention" as const, label: approval ? "Needs your OK" : "Needs your answer" }
    : paused
      ? { mood: "idle" as const, label: paused.reason === "limit" ? "Waiting for the limit to reset" : paused.reason === "budget" ? "Held — budget used up" : "Paused" }
      : liveMood;
  const { pause } = usePauseActions(conversationId);
  const pausing = pause.isPending || live?.activity === "Pausing…" || live?.activity === "Asking you…";
  const answeringRef = useRef(false);
  answeringRef.current = !!waiting;
  const busyRef = useRef(false);
  busyRef.current = !!activeRunId;
  // While the agent works, is paused or older messages still wait, a new message joins the queue.
  const queueingRef = useRef(false);
  queueingRef.current = !!activeRunId || !!paused || queue.length > 0;

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
      const id = input.queueId!;
      const tempId = `pending-${id}`;
      const attachments = (input.attachments ?? []).map((a) => ({ name: a.name, mime: a.mime, path: "", size: Math.round((a.data.length * 3) / 4) }));
      const draft = { conversationId, content: input.content, attachments, createdAt: new Date().toISOString() };
      // A message to a chat that waits for an answer is the answer: no queue chip, no bubble — the card shows it.
      if (answeringRef.current && !input.content.trim().startsWith("/")) return { id, tempId: null };
      const queueing = queueingRef.current;
      if (queueing) pendingQueued.set(id, { ...draft, id });
      qc.setQueryData<ConversationWithMessages>(key, (old) =>
        !old
          ? old
          : queueing
            ? { ...old, queue: withPending(conversationId, old.queue) }
            : { ...old, messages: [...old.messages, { ...draft, id: tempId, role: "user", blocks: [], runId: null }] },
      );
      return { id, tempId };
    },
    onSuccess: (res, input, ctx) => {
      pendingQueued.delete(ctx.id);
      qc.setQueryData<ConversationWithMessages>(key, (old) => {
        if (!old) return old;
        const sent = old.messages.filter((m) => m.id !== ctx.tempId);
        if ("queued" in res) {
          const shown = old.queue.some((m) => m.id === ctx.id);
          return { ...old, messages: sent, queue: shown ? old.queue.map((m) => (m.id === ctx.id ? res.queued : m)) : [...old.queue, res.queued] };
        }
        return {
          ...old,
          queue: old.queue.filter((m) => m.id !== ctx.id),
          messages: sent.some((m) => m.id === res.message.id)
            ? sent
            : old.messages.some((m) => m.id === ctx.tempId)
              ? old.messages.map((m) => (m.id === ctx.tempId ? res.message : m))
              : [...sent, res.message],
          activeRunId: old.activeRunId ?? (res.run.status === "queued" || res.run.status === "running" ? res.run.id : null),
        };
      });
      if ("run" in res && input.voice) markVoiceRun(res.run.id);
      // It was the answer to a question: the card in the thread shows it now.
      if ("question" in res && res.question) qc.invalidateQueries({ queryKey: key });
      // Also settles the queue when the agent took the message before this answer arrived.
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
    },
    onError: (err, _input, ctx) => {
      if (ctx) {
        pendingQueued.delete(ctx.id);
        qc.setQueryData<ConversationWithMessages>(key, (old) =>
          old ? { ...old, messages: old.messages.filter((m) => m.id !== ctx.tempId), queue: old.queue.filter((m) => m.id !== ctx.id) } : old,
        );
      }
      if (!isLicenseRequired(err)) toast.error("Message not sent", { description: errorMessage(err) });
    },
  });

  const choose = useMutation({
    mutationFn: (patch: Partial<ModelChoice>) => api.conversations.update(conversationId, patch),
    onMutate: (patch) => {
      const old = qc.getQueryData<ConversationWithMessages>(key);
      qc.setQueryData<ConversationWithMessages>(key, (c) => (c ? { ...c, ...patch } : c));
      return { prev: { model: old?.model ?? null, effort: old?.effort ?? null, ultracode: old?.ultracode ?? null } };
    },
    onError: (err, patch, ctx) => {
      if (ctx) qc.setQueryData<ConversationWithMessages>(key, (c) => (c ? { ...c, ...ctx.prev } : c));
      toast.error(patch.ultracode !== undefined && patch.model === undefined ? "Couldn't switch Ultracode" : "Couldn't switch the model", { description: errorMessage(err) });
    },
  });

  const setFolder = useMutation({
    mutationFn: (workingDirectory: string | null) => api.conversations.update(conversationId, { workingDirectory }),
    onSuccess: (updated) => {
      qc.setQueryData<ConversationWithMessages>(key, (old) => (old ? { ...old, ...updated } : old));
      qc.invalidateQueries({ queryKey: qk.recentFolders });
      const folder = updated.workingDirectory ?? agent?.workingDirectory ?? null;
      toast.success(folder ? `Working in ${folderName(folder)}` : "Folder removed", {
        description: folder ? "The next messages run in this folder." : `${agent?.name ?? "The agent"} works in its own repository again.`,
      });
    },
    onError: (err) => toast.error("Couldn't change the folder", { description: errorMessage(err) }),
  });

  const setInstructions = useMutation({
    mutationFn: (instructions: string) => api.conversations.update(conversationId, { instructions }),
    onSuccess: (updated) => {
      qc.setQueryData<ConversationWithMessages>(key, (old) => (old ? { ...old, ...updated } : old));
      toast.success(updated.instructions ? "Chat instructions saved" : "Chat instructions removed", {
        description: busyRef.current ? "They apply from your next message." : undefined,
      });
    },
    onError: (err) => toast.error("Couldn't save the instructions", { description: errorMessage(err) }),
  });

  const setVm = useMutation({
    mutationFn: (vmId: string | null) => api.conversations.update(conversationId, { vmId }),
    onSuccess: (updated) => {
      qc.setQueryData<ConversationWithMessages>(key, (old) => (old ? { ...old, ...updated } : old));
      // "Used by" on the VMs page.
      qc.invalidateQueries({ queryKey: qk.vmList });
      const vm = updated.vmId ? qc.getQueryData<Vm[]>(qk.vmList)?.find((v) => v.id === updated.vmId) : undefined;
      if (updated.vmId)
        toast.success(`Working in ${vm?.name ?? "the VM"}`, {
          description: vm?.state === "running" ? "The next messages run in this VM." : "The next messages run in this VM — it starts when the agent needs it.",
        });
      else toast.success("Back to the default", { description: `${agent?.name ?? "The agent"} uses its own or its workspace's VM again, if there is one.` });
    },
    onError: (err) => toast.error("Couldn't change the VM", { description: errorMessage(err) }),
  });

  const setBrowserProfile = useMutation({
    mutationFn: (browserProfileId: string | null) => api.conversations.update(conversationId, { browserProfileId }),
    onSuccess: (updated) => {
      qc.setQueryData<ConversationWithMessages>(key, (old) => (old ? { ...old, ...updated } : old));
      const profiles = qc.getQueryData<BrowserProfile[]>(qk.browserProfiles) ?? [];
      const profile = updated.browserProfileId
        ? profiles.find((p) => p.id === updated.browserProfileId)
        : agent && agentBrowserProfile(agent, profiles, null, updated.workspaceId);
      const when = busyRef.current ? "Your next message uses" : "The next messages use";
      if (updated.browserProfileId) toast.success(`Browsing in ${profile?.name ?? "the new profile"}`, { description: `${when} its cookies and logins.` });
      else toast.success("Back to the default profile", { description: `${agent?.name ?? "The agent"} browses in ${profile?.name ?? "its own profile"} again.` });
    },
    onError: (err) => toast.error("Couldn't change the browser profile", { description: errorMessage(err) }),
  });

  const setSshServers = useMutation({
    // One change at a time, in the order they were made.
    scope: { id: `ssh-servers:${conversationId}` },
    mutationFn: (sshServerIds: string[]) => api.conversations.update(conversationId, { sshServerIds }),
    onMutate: (next) => {
      const prev = qc.getQueryData<ConversationWithMessages>(key)?.sshServerIds ?? [];
      qc.setQueryData<ConversationWithMessages>(key, (c) => (c ? { ...c, sshServerIds: next } : c));
      return { prev };
    },
    onSuccess: (updated, next, ctx) => {
      // The cache already holds the latest pick (toggles can overlap); take everything else from the answer.
      qc.setQueryData<ConversationWithMessages>(key, (old) => (old ? { ...old, ...updated, sshServerIds: old.sshServerIds } : old));
      qc.invalidateQueries({ queryKey: qk.sshServers });
      const servers = qc.getQueryData<SshServer[]>(qk.sshServers) ?? [];
      const nameOf = (id: string) => servers.find((s) => s.id === id)?.name ?? "the server";
      const added = next.find((id) => !ctx.prev.includes(id));
      const removed = ctx.prev.find((id) => !next.includes(id));
      if (added)
        toast.success(`Next message can use ${nameOf(added)}`, {
          description: "Godmode signs in for the agent — the password or key stays in the vault.",
        });
      else if (removed) toast.success(`Removed ${nameOf(removed)}`, { description: "Runs in this chat can't sign in to it anymore." });
    },
    onError: (err) => {
      void qc.invalidateQueries({ queryKey: key });
      toast.error("Couldn't change the SSH servers", { description: errorMessage(err) });
    },
  });

  const share = useMutation({
    mutationFn: (computerTarget: ComputerTarget | null) => api.conversations.update(conversationId, { computerTarget }),
    onSuccess: (updated, target) => {
      qc.setQueryData<ConversationWithMessages>(key, (old) => (old ? { ...old, ...updated } : old));
      if (target) {
        setComputerPanel(true);
        toast.success(`Sharing ${computerTargetLabel(target)}`, {
          description: busyRef.current ? "The agent can use it from your next message." : `${agent?.name ?? "The agent"} can see and control it in this chat.`,
        });
      } else toast("Stopped sharing");
    },
    onError: (err) => toast.error("Couldn't change what's shared", { description: errorMessage(err) }),
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
  // The agent's dream log: the core refuses messages here, so it reads like a transcript.
  const dreamLog = conv.origin === "dream";
  // The latest turn, when nothing else is about to happen in the chat: if it ended early, the thread offers to pick it up.
  const lastTurn =
    !inflight && !paused && !queue.length && !dreamLog && !runnerAway && agent?.enabled !== false && lastMessage?.role === "assistant" && lastMessage.runId ? lastMessage : null;

  return (
    <div className="flex h-full min-h-0">
      <ChatDropZone onFiles={(files) => composerRef.current?.addFiles(files)} disabled={dreamLog || voiceMode} className="@container flex h-full min-w-0 flex-1 flex-col">
        <ConversationHeader
          conversation={conv}
          agent={agent}
          mood={mood}
          onVoiceMode={dreamLog ? undefined : onVoiceMode}
          browserToggle={
            chatVm ? (
              !showVmPanel && <VmToggle working={!!activeRunId} onClick={() => (wide ? setVmPanel(true) : setVmFocus(true))} />
            ) : (
            <>
              {computerTarget && !showComputerPanel && (
                <ComputerToggle working={!!activeRunId} onClick={() => (wide ? setComputerPanel(true) : setComputerFocus("watch"))} />
              )}
              {!!browser && !showBrowserPanel && (
                <BrowserToggle
                  working={!!activeRunId && !!chatTab}
                  onClick={() => {
                    if (!wide || showComputerPanel) setBrowserFocus("watch");
                    else if (chatTab) setBrowserPanel(true);
                    else setBrowserOpened(true);
                  }}
                />
              )}
            </>
            )
          }
        />

        <ChatFilesScope conversationId={conversationId} runnerId={conv.runnerId}>
          <QuestionScopeProvider value={{ conversationId, agentName: agent?.name ?? "The agent", openId: waiting?.question?.id ?? null }}>
            <Thread
              messages={visibleMessages}
              agent={agent}
              delegatedFrom={conv.delegatedFrom}
              inflight={inflight}
              after={lastTurn && <TurnEnd key={lastTurn.id} conversation={conv} message={lastTurn} agent={agent} />}
              onStop={() => activeRunId && cancel.mutate(activeRunId)}
              stopping={cancel.isPending}
              onPause={conv.origin === "dream" || live?.trigger === "dream" || live?.trigger === "check" || paused ? undefined : () => pause.mutate()}
              pausing={pausing}
              empty={
                <ConversationWelcome agent={agent} seed={conversationId} onPick={(text) => composerRef.current?.setText(text)} />
              }
            />
          </QuestionScopeProvider>
        </ChatFilesScope>

        {dreamLog ? (
          <div className="relative shrink-0 px-3 pb-3 @xl:px-6 @xl:pb-4">
            <DreamLogNote agent={agent ?? { id: conv.agentId, name: "The agent", enabled: true }} />
          </div>
        ) : (
          <div className="relative shrink-0 px-3 pb-3 @xl:px-6 @xl:pb-4">
            <div className="mx-auto w-full max-w-3xl">
              <AnimatePresence initial={false}>
                {conv.archived && (
                  <motion.div
                    key="archived"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
                    className="overflow-hidden"
                  >
                    <div className="mb-2 flex items-center gap-2.5 rounded-lg border bg-card py-1.5 pr-1.5 pl-3 text-[13px] text-muted-foreground shadow-card">
                      <Archive className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium text-foreground">Archived.</span> Send a message to move it back to Recent.
                      </span>
                      <Button size="xs" variant="ghost" onClick={() => setArchived(conv, false)}>
                        <ArchiveRestore /> Unarchive
                      </Button>
                    </div>
                  </motion.div>
                )}
                {agent && !agent.enabled && conv.origin !== "dream" && (
                  <motion.div
                    key="off"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
                    className="overflow-hidden"
                  >
                    <SwitchedOffBar agent={agent} />
                  </motion.div>
                )}
                {paused && (
                  <motion.div
                    key="paused"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
                    className="overflow-hidden"
                  >
                    <PauseBar conversationId={conversationId} pause={paused} agentName={agent?.name ?? "The agent"} agentId={agent?.id} queued={queue.length} />
                  </motion.div>
                )}
                {runnerAway && (
                  <motion.div
                    key="runner-away"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
                    className="overflow-hidden"
                  >
                    <RunnerOfflineBar runner={runner} />
                  </motion.div>
                )}
                {conv.followup && (
                  <motion.div
                    key="followup"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
                    className="overflow-hidden"
                  >
                    <FollowupBar conversationId={conversationId} followup={conv.followup} agentName={agent?.name ?? "The agent"} running={!!activeRunId || !!paused} />
                  </motion.div>
                )}
              </AnimatePresence>
              {!conv.runnerId && <HumanTaskBar conversationId={conversationId} agentName={agent?.name ?? "The agent"} />}
              <QueueTray
                ref={queueRef}
                conversationId={conversationId}
                queue={queue}
                agentName={agent?.name ?? "The agent"}
                running={!!activeRunId}
                paused={paused?.reason ?? null}
                onLost={(text) => composerRef.current?.insert(text)}
                onDone={() => composerRef.current?.focus()}
              />
              <Composer
                ref={composerRef}
                draftKey={conversationId}
                agentId={conv.agentId}
                autoFocus
                running={!!activeRunId && !paused}
                blocked={agent && !agent.enabled ? `Switch ${agent.name} on to send` : undefined}
                disabled={runnerAway}
                onRecall={() => queueRef.current?.editLast() ?? false}
                leading={
                  <>
                    {onRunner ? (
                      <RunnerPill runner={runner} />
                    ) : (
                      <FolderChip
                        chatFolder={conv.workingDirectory}
                        agentFolder={agent?.workingDirectory ?? null}
                        agentName={agent?.name}
                        onChange={(path) => setFolder.mutate(path)}
                        busy={setFolder.isPending}
                      />
                    )}
                    {!chatVm && (
                      <>
                        <BrowserProfileChip
                          agent={agent}
                          value={conv.browserProfileId ?? null}
                          workspaceId={conv.workspaceId ?? null}
                          onChange={(id) => setBrowserProfile.mutateAsync(id).catch(() => undefined)}
                          busy={setBrowserProfile.isPending}
                        />
                        {!onRunner && (
                          <ComputerShareChip
                            target={computerTarget}
                            agentName={agent?.name}
                            onShare={(t) => share.mutateAsync(t)}
                            onWatch={() => setComputerFocus("watch")}
                            busy={share.isPending}
                          />
                        )}
                      </>
                    )}
                    <SshChip
                      agent={agent}
                      value={conv.sshServerIds ?? []}
                      onChange={(ids) => setSshServers.mutateAsync(ids).catch(() => undefined)}
                      busy={setSshServers.isPending}
                    />
                    {!onRunner && (
                      <VmChip
                        value={conv.vmId ?? null}
                        inherited={vmInherited}
                        onChange={(vmId) => setVm.mutateAsync(vmId).catch(() => undefined)}
                        busy={setVm.isPending}
                      />
                    )}
                    <InstructionsChip
                      value={conv.instructions ?? ""}
                      agent={agent}
                      onChange={(text) => setInstructions.mutateAsync(text)}
                      busy={setInstructions.isPending}
                    />
                  </>
                }
                sendHint={waiting ? "Send answer" : paused ? (paused.reason === "limit" || paused.reason === "budget" ? "Queue message" : "Send and continue") : undefined}
                placeholder={
                  runnerAway
                    ? runner.state === "connecting"
                      ? `Connecting to ${runner.name}…`
                      : `${runner.name} ${runner.state === "offline" ? "is offline" : "needs an update"}`
                    : !agent
                    ? "Message…"
                    : !agent.enabled
                      ? `${agent.name} is switched off — your message waits here as a draft`
                    : waiting
                      ? approval
                        ? `Reply to ${agent.name} — or use Approve / Decline above`
                        : `Answer ${agent.name}…`
                    : paused?.reason === "user"
                      ? `Message ${agent.name} to continue with new instructions…`
                      : paused
                        ? paused.reason === "budget"
                          ? `Message ${agent.name} — it goes along when the run continues`
                          : `Message ${agent.name} — it goes along when the limit resets`
                        : `Message ${agent.name} — or type / for commands`
                }
                trailing={
                  <ModelPicker
                    agent={agent}
                    value={{ model: conv.model ?? null, effort: conv.effort ?? null, ultracode: conv.ultracode ?? null }}
                    onChange={(patch) => choose.mutate(patch)}
                  />
                }
                onSubmit={(input) => send.mutateAsync({ ...input, queueId: newQueueId() })}
              />
              <p className="mt-2 hidden text-center text-[11px] text-muted-foreground/80 @2xl:block">
                Agents act for you with your saved logins — secrets are filled into the browser, never shown to the AI.
              </p>
            </div>
          </div>
        )}

        {!dreamLog && (
          <VoiceMode
            agent={agent}
            busy={!!activeRunId || send.isPending}
            activity={live ? liveActivityLabel(live) : null}
            lastMessage={lastMessage}
            onSend={async (text) => {
              await send.mutateAsync({ content: text, voice: true, queueId: newQueueId() });
            }}
            onStop={activeRunId ? () => cancel.mutate(activeRunId) : undefined}
          />
        )}
      </ChatDropZone>
      <AnimatePresence initial={false}>
        {showVmPanel && (
          <VmPanel
            key="vm"
            vm={chatVm.vm}
            from={chatVm.from}
            activity={activeRunId ? liveActivityLabel(live) : null}
            onHide={() => setVmPanel(false)}
            onFocus={() => setVmFocus(true)}
          />
        )}
        {showComputerPanel && (
          <ComputerPanel
            key="computer"
            target={computerTarget!}
            agent={agent!}
            activity={activeRunId ? liveActivityLabel(live) : null}
            onHide={() => setComputerPanel(false)}
            onFocus={setComputerFocus}
            onStop={() => share.mutate(null)}
            stopping={share.isPending && share.variables === null}
          />
        )}
        {showBrowserPanel && (
          <BrowserPanel
            key={browser.id}
            profile={browser}
            conversationId={conversationId}
            agent={agent}
            forChat={browser.id === chatProfileId}
            activity={activeRunId ? liveActivityLabel(live) : null}
            onHide={() => {
              setBrowserOpened(false);
              if (chatTab) setBrowserPanel(false);
            }}
            onFocus={setBrowserFocus}
          />
        )}
      </AnimatePresence>
      <BrowserFocus profile={browser} conversationId={conversationId} mode={browserFocus} onClose={() => setBrowserFocus(null)} />
      <ComputerFocus target={computerTarget} mode={computerFocus} onClose={() => setComputerFocus(null)} />
      <VmFocus vm={chatVm?.vm ?? null} open={vmFocus} working={!!activeRunId} onClose={() => setVmFocus(false)} />
    </div>
  );
}

/** A switched-off agent answers nothing: say so where the human types, with the way back. */
function SwitchedOffBar({ agent }: { agent: Agent }) {
  const toggle = useToggleAgent();
  return (
    <div className="mb-2 flex items-center gap-3 rounded-xl border bg-card py-2 pr-2 pl-2.5 shadow-card" role="status">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-muted text-muted-foreground">
        <PowerOff className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 leading-snug">
        <p className="truncate text-[13px] font-medium">{agent.name} is switched off</p>
        <p className="text-xs text-muted-foreground">It doesn't answer, run its automations or take handoffs until you switch it on.</p>
      </div>
      <Button size="sm" variant="outline" className="shrink-0" disabled={toggle.isPending} onClick={() => toggle.mutate({ id: agent.id, enabled: true })}>
        {toggle.isPending ? <Spinner /> : <Power />} Switch on
      </Button>
    </div>
  );
}

/** Footer of an agent's dream log: nothing to send here — point to a fresh chat instead. */
function DreamLogNote({ agent }: { agent: Pick<Agent, "id" | "name" | "enabled"> }) {
  const agentName = agent.name;
  const chat = useStartAgentChat();
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-4 py-3 text-[13px] text-muted-foreground shadow-card">
      <span className="grid size-7 shrink-0 place-items-center rounded-lg border bg-dream-soft text-dream">
        <Moon className="size-3.5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 basis-56">
        This is where <span className="font-medium text-foreground">{agentName}</span> dreams — start a new chat to talk to it.
      </span>
      <Button size="sm" variant="outline" disabled={chat.isPending} onClick={() => chat.mutate(agent)}>
        {chat.isPending ? <Spinner /> : <MessageSquarePlus />} New chat
      </Button>
    </div>
  );
}

function ConversationWelcome({ agent, seed, onPick }: { agent?: Agent; seed: string; onPick: (text: string) => void }) {
  const { data: boot } = useBootstrap();
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
    <div className="flex flex-col items-center pt-[8vh] text-center">
      {agent && (
        <>
          <SpeechBubble tail="bottom" className="max-w-sm text-balance">
            {characterGreeting({ name: agent.name, personality: agent.personality, human: boot?.settings.general.userName, seed })}
          </SpeechBubble>
          <AgentAvatar agent={agent} size="xl" follow className="mt-4 size-28" />
        </>
      )}
      <h2 className="mt-4 text-lg font-medium tracking-[-0.02em]">{agent?.name ?? "Your agent"}</h2>
      {agent?.description && <p className="mt-1 max-w-md text-sm text-muted-foreground">{agent.description}</p>}
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

/** While this chat is on screen in a focused window, the core knows: it's read, and its runs don't notify. */
function useViewing(conversationId: string | undefined) {
  useEffect(() => {
    if (!conversationId) return;
    const update = () => viewConversation(document.visibilityState === "visible" && document.hasFocus() ? conversationId : null);
    update();
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
      viewConversation(null);
    };
  }, [conversationId]);
}
