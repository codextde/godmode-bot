import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import type { Agent, AndroidDevice, BrowserProfile, ComputerTarget, ConversationWithMessages, Message, SendMessageInput, SshServer, Vm } from "@godmode/shared";
import { characterGreeting, computerTargetLabel } from "@godmode/shared";
import { Archive, ArchiveRestore, ArrowUpRight, Brain, MessageSquareDashed, MessageSquarePlus, Moon, Power, PowerOff, Sparkles, Wand2 } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
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
import { PrivateChatNote, usePrivateChatLifetime } from "@/components/chat/private-chat";
import { useConversationMood } from "@/components/chat/conversation-mood";
import { FollowupBar } from "@/components/chat/followup";
import { HumanTaskBar } from "@/components/human-tasks/human-task-chat";
import { PauseBar, usePauseActions } from "@/components/chat/pause";
import { QuestionScopeProvider } from "@/components/chat/question-card";
import { ModelPicker, type ModelChoice } from "@/components/chat/model-picker";
import { FolderChip, folderName } from "@/components/chat/folder-picker";
import { InstructionsChip } from "@/components/instructions/instructions";
import { SshChip } from "@/components/ssh/ssh-chip";
import { AndroidChip } from "@/components/android/android-chip";
import { PhonePanel, PhoneToggle, useChatPhones } from "@/components/android/phone-panel";
import { ArtifactPanel, ArtifactScopeProvider, ArtifactToggle, useArtifactPanel, useAutoOpenArtifacts } from "@/components/artifacts/artifact-panel";
import { RunnerOfflineBar, RunnerPill } from "@/components/runners/runner-chip";
import { MoveChatDialog } from "@/components/runners/move-chat";
import { isOlderRunner, usePlaces, type Place } from "@/lib/places";
import { VmChip, type InheritedVm } from "@/components/vms/vm-picker";
import { VmFocus, VmPanel, VmToggle, useChatVm } from "@/components/vms/vm-panel";
import { SidePanelScopeProvider, sideKey, useChatSidePanel } from "@/components/side-panel/store";
import { SubagentPanel, findSubagent } from "@/components/side-panel/subagent-panel";
import { PullRequestPanel } from "@/components/github/pull-request-panel";
import { ChatDropZone } from "@/components/chat/drop-zone";
import { Thread } from "@/components/chat/thread";
import { QuoteSelection } from "@/components/chat/quote-selection";
import { TurnEnd } from "@/components/chat/turn-end";
import { ChatFilesScope } from "@/components/chat/local-files";
import { liveActivityLabel } from "@/components/chat/messages";
import { CompressBar, ContextMeter, useContextGauge } from "@/components/chat/context-meter";
import { VoiceMode } from "@/components/chat/voice-mode";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useVoiceSettings } from "@/hooks/use-voice";
import { api, ApiRequestError, errorMessage, isLicenseRequired } from "@/lib/api";
import { newQueueId, pendingQueued, withPending } from "@/lib/pending-queue";
import { qk } from "@/lib/queryKeys";
import { useAllAgents, useBootstrap, useConversation, useRunners, useWorkspaces } from "@/lib/hooks";
import { ProjectChip, type PlacePick } from "@/components/projects/project-chip";
import { effectiveProject, useProjectIndex } from "@/components/projects/project-utils";
import { onServerEvent, settleRun, viewConversation } from "@/lib/realtime";
import { speak, useVoiceSession } from "@/lib/voice";
import { EASE_OUT } from "@/lib/motion";
import { useConversationLiveRun, type LiveRun } from "@/stores/live";
import { useUi } from "@/stores/ui";
import { currentLanguage } from "@/i18n";

const FilePanel = lazy(() => import("@/components/side-panel/file-panel"));

const NO_INHERITED_VMS: InheritedVm[] = [];

export default function ChatConversation() {
  const { conversationId = "" } = useParams();
  // Remount per conversation so scroll, drafts and transient state reset cleanly.
  return <ConversationView key={conversationId} conversationId={conversationId} />;
}

function ConversationView({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation(["chat", "common"]);
  const focusMessage = useSearchParams()[0].get("m");
  const qc = useQueryClient();
  const key = qk.conversation(conversationId);
  const projectIndex = useProjectIndex();
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
  usePrivateChatLifetime(conversationId, !!conv?.private);
  const queueRef = useRef<QueueTrayHandle>(null);
  const mountedAt = useRef(Date.now());
  // A profile picked mid-run applies from the next message: keep showing the browser the running agent drives.
  const [runProfile, setRunProfile] = useState<{ runId: string; profileId: string | null } | null>(null);
  if ((live?.runId ?? null) !== (runProfile?.runId ?? null)) setRunProfile(live ? { runId: live.runId, profileId: conv?.browserProfileId ?? null } : null);
  const chatProfileId = runProfile ? runProfile.profileId : (conv?.browserProfileId ?? null);
  const chatBrowser = useChatBrowser(agent, chatProfileId, conv?.workspaceId ?? null, conv?.projectId ?? null);
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
  // In a device group every chat works on one of its computers; "here" is the one this app runs on.
  const { inGroup, hereId, places, placeOf } = usePlaces();
  const onRunner = !!conv && (conv.runnerId ?? null) !== hereId;
  const chatPlace = conv ? placeOf(conv.runnerId ?? null) : null;
  const runner = onRunner ? (chatPlace?.runner ?? null) : null;
  const runnerAway = onRunner && !!chatPlace && chatPlace.state !== "online";
  const [moving, setMoving] = useState(false);
  const [moveTo, setMoveTo] = useState<Place | null>(null);
  const moveTargets = useMemo(() => places.filter((p) => p.runnerId !== (conv?.runnerId ?? null) && p.state === "online" && !isOlderRunner(p)), [places, conv?.runnerId]);
  const openMove = (to: Place | null) => {
    setMoveTo(to);
    setMoving(true);
  };
  const computerTarget = onRunner ? null : (conv?.computerTarget ?? null);
  const computerPanel = useUi((s) => s.computerPanel);
  const setComputerPanel = useUi((s) => s.setComputerPanel);
  const [computerFocus, setComputerFocus] = useState<ComputerFocusMode | null>(null);
  const vmInherited = [
    agent?.vmId ? { vmId: agent.vmId, from: agent.name } : null,
    agentWorkspace?.vmId ? { vmId: agentWorkspace.vmId, from: t("home.workspaceFrom", { name: agentWorkspace.name }) } : null,
  ];
  // A chat that works in a VM does everything there: its panel shows the VM, not this Mac's browser or screen.
  const chatVm = useChatVm(onRunner ? null : (conv?.vmId ?? null), onRunner ? NO_INHERITED_VMS : vmInherited);
  // An artifact the agent built or the human opened takes the side panel while it is open.
  const chatArtifacts = useAutoOpenArtifacts(conversationId, wide);
  const artifactId = useArtifactPanel((s) => s.open[conversationId] ?? null);
  const showArtifact = useArtifactPanel((s) => s.show);
  const hideArtifact = useArtifactPanel((s) => s.hide);
  const side = useChatSidePanel((s) => s.open[conversationId] ?? null);
  const hideSide = useChatSidePanel((s) => s.hide);
  useEffect(() => {
    if (side) hideArtifact(conversationId);
  }, [side, conversationId, hideArtifact]);
  useEffect(() => {
    if (artifactId) hideSide(conversationId);
  }, [artifactId, conversationId, hideSide]);
  const showSidePanel = wide && !!side && !artifactId;
  const showArtifactPanel = wide && !!artifactId;
  const sidePanelTaken = showArtifactPanel || showSidePanel;
  const vmPanel = useUi((s) => s.vmPanel);
  const setVmPanel = useUi((s) => s.setVmPanel);
  const [vmFocus, setVmFocus] = useState(false);
  const showVmPanel = !!chatVm && !!agent && wide && vmPanel && !sidePanelTaken;
  // Something shared takes the side panel; the browser stays one click away in the header.
  const showComputerPanel = !chatVm && !!computerTarget && !!agent && wide && computerPanel && !sidePanelTaken;
  // Phones are plugged into this computer: a runner's chat has none.
  const navigate = useNavigate();
  const chatPhones = useChatPhones(onRunner ? undefined : conv?.androidDeviceIds, onRunner ? undefined : agent?.androidDeviceIds);
  const phonePanel = useUi((s) => s.phonePanel);
  const setPhonePanel = useUi((s) => s.setPhonePanel);
  const showPhonePanel = !chatVm && !showComputerPanel && !sidePanelTaken && chatPhones.length > 0 && !!agent && wide && phonePanel;
  // On a runner this computer can't see the chat's tab before frames come: the panel shows while the agent works there.
  const browserActive = !!chatTab || (onRunner && !!live);
  const showBrowserPanel =
    !chatVm && !!browser && !!agent && wide && !showComputerPanel && !showPhonePanel && !sidePanelTaken && (browserOpened || (browserActive && browserPanel));
  useEffect(() => setBrowserFocus(null), [browser?.id]);
  useEffect(() => {
    if (!computerTarget) setComputerFocus(null);
  }, [computerTarget]);

  const messages = useMemo(() => conv?.messages ?? [], [conv?.messages]);
  const queue = useMemo(() => conv?.queue ?? [], [conv?.queue]);
  const activeRunId = live?.runId ?? conv?.activeRunId ?? null;
  // The chat's run stands still (one that continues is live again before the chat says so). Runs that came after it wait.
  const paused = (conv?.paused && conv.paused.runId !== activeRunId && conv.paused) || null;
  // While the other computer is away nothing is known to work there; while a run works the move stops it and the agent continues.
  const moveWorking = !runnerAway && (!!activeRunId || !!conv?.running || !!paused);
  const liveMood = useConversationMood(conversationId, messages, live);
  // The run waits for the human's answer to a question or an approval (the card in the thread asks it).
  const waiting = paused?.reason === "question" ? paused : null;
  const approval = waiting?.question?.kind === "approval";
  const mood = waiting
    ? { mood: "attention" as const, label: approval ? t("status.needsOk") : t("status.needsAnswer") }
    : paused
      ? { mood: "idle" as const, label: paused.reason === "limit" ? t("conv.waitingLimitReset") : t("status.paused") }
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

  const subagentSide = useMemo(() => {
    if (side?.kind !== "subagent") return null;
    const sources = [live?.blocks ?? [], shownLinger?.blocks ?? [], ...messages.toReversed().map((m) => m.blocks ?? [])];
    const found = findSubagent(sources, side.id);
    return found ? { ...found, streaming: found.index === 0 && !!live } : null;
  }, [side, live, shownLinger, messages]);

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
      if (!isLicenseRequired(err)) toast.error(t("conv.sendError"), { description: errorMessage(err) });
    },
  });

  // Chat memory: the ring in the composer, and a bar once the chat gets long (hidden until it grows further).
  const gauge = useContextGauge(conv?.context);
  const compressing = !!live && live.status === "running" && liveActivityLabel(live).startsWith("Compressing");
  const [compressHiddenAt, setCompressHiddenAt] = useState<number | null>(null);
  const compress = () => send.mutate({ content: "/compress", queueId: newQueueId() });
  const compressQueued = queue.some((m) => /^\/(compress|compact)\b/.test(m.content.trim()));

  const choose = useMutation({
    mutationFn: (patch: Partial<ModelChoice>) => api.conversations.update(conversationId, patch),
    onMutate: (patch) => {
      const old = qc.getQueryData<ConversationWithMessages>(key);
      qc.setQueryData<ConversationWithMessages>(key, (c) => (c ? { ...c, ...patch } : c));
      return { prev: { model: old?.model ?? null, effort: old?.effort ?? null, ultracode: old?.ultracode ?? null } };
    },
    onError: (err, patch, ctx) => {
      if (ctx) qc.setQueryData<ConversationWithMessages>(key, (c) => (c ? { ...c, ...ctx.prev } : c));
      toast.error(patch.ultracode !== undefined && patch.model === undefined ? t("conv.switchUltracodeError") : t("conv.switchModelError"), { description: errorMessage(err) });
    },
  });

  const setFolder = useMutation({
    mutationFn: (workingDirectory: string | null) => api.conversations.update(conversationId, { workingDirectory }),
    onSuccess: (updated) => {
      qc.setQueryData<ConversationWithMessages>(key, (old) => (old ? { ...old, ...updated } : old));
      qc.invalidateQueries({ queryKey: qk.recentFolders });
      const folder = updated.workingDirectory ?? agent?.workingDirectory ?? null;
      toast.success(folder ? t("conv.workingIn", { name: folderName(folder) }) : t("conv.folderRemoved"), {
        description: folder ? t("conv.folderHint") : t("conv.ownRepo", { name: agent?.name ?? t("turnEnd.theAgent") }),
      });
    },
    onError: (err) => toast.error(t("conv.folderError"), { description: errorMessage(err) }),
  });

  const setInstructions = useMutation({
    mutationFn: (instructions: string) => api.conversations.update(conversationId, { instructions }),
    onSuccess: (updated) => {
      qc.setQueryData<ConversationWithMessages>(key, (old) => (old ? { ...old, ...updated } : old));
      toast.success(updated.instructions ? t("conv.instructionsSaved") : t("conv.instructionsRemoved"), {
        description: busyRef.current ? t("conv.instructionsNext") : undefined,
      });
    },
    onError: (err) => toast.error(t("conv.instructionsError"), { description: errorMessage(err) }),
  });

  const setVm = useMutation({
    mutationFn: (vmId: string | null) => api.conversations.update(conversationId, { vmId }),
    onSuccess: (updated) => {
      qc.setQueryData<ConversationWithMessages>(key, (old) => (old ? { ...old, ...updated } : old));
      // "Used by" on the VMs page.
      qc.invalidateQueries({ queryKey: qk.vmList });
      const vm = updated.vmId ? qc.getQueryData<Vm[]>(qk.vmList)?.find((v) => v.id === updated.vmId) : undefined;
      if (updated.vmId)
        toast.success(vm ? t("conv.workingIn", { name: vm.name }) : t("conv.workingInVm"), {
          description: vm?.state === "running" ? t("conv.vmRunning") : t("conv.vmStarts"),
        });
      else toast.success(t("conv.backToDefault"), { description: t("conv.vmDefaultHint", { name: agent?.name ?? t("turnEnd.theAgent") }) });
    },
    onError: (err) => toast.error(t("conv.vmError"), { description: errorMessage(err) }),
  });

  const setProject = useMutation({
    mutationFn: (pick: PlacePick) => api.conversations.update(conversationId, pick),
    onSuccess: (updated, pick) => {
      qc.setQueryData<ConversationWithMessages>(key, (old) => (old ? { ...old, ...updated } : old));
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
      const project = updated.projectId ? projectIndex.get(updated.projectId)?.project : undefined;
      const workspace = !project && pick.workspaceId !== undefined && !agent?.workspaceId ? workspaces.find((w) => w.id === updated.workspaceId) : undefined;
      const description = busyRef.current ? t("conv.projectNext") : t("conv.projectNow");
      if (project) toast.success(t("conv.workingOn", { name: project.name }), { description });
      else if (workspace) toast.success(t("conv.workingIn", { name: workspace.name }), { description });
      else if (pick.workspaceId === null && !agent?.workspaceId) toast.success(t("conv.noWorkspace"), { description: t("conv.noWorkspaceHint") });
      else toast.success(t("conv.backToDefault"), { description: t("conv.projectDefaultHint", { name: agent?.name ?? t("turnEnd.theAgent") }) });
    },
    onError: (err, pick) => toast.error(pick.projectId ? t("conv.projectError") : t("conv.workspaceError"), { description: errorMessage(err) }),
  });

  const setBrowserProfile = useMutation({
    mutationFn: (browserProfileId: string | null) => api.conversations.update(conversationId, { browserProfileId }),
    onSuccess: (updated) => {
      qc.setQueryData<ConversationWithMessages>(key, (old) => (old ? { ...old, ...updated } : old));
      const profiles = qc.getQueryData<BrowserProfile[]>(qk.browserProfiles) ?? [];
      const profile = updated.browserProfileId
        ? profiles.find((p) => p.id === updated.browserProfileId)
        : agent && agentBrowserProfile(agent, profiles, null, updated.workspaceId, effectiveProject(agent, updated.projectId, projectIndex)?.project ?? null);
      if (updated.browserProfileId)
        toast.success(profile ? t("conv.browsingIn", { name: profile.name }) : t("conv.browsingInNew"), {
          description: busyRef.current ? t("conv.profileNext") : t("conv.profileNow"),
        });
      else
        toast.success(t("conv.backToDefaultProfile"), {
          description: profile
            ? t("conv.browsesIn", { name: agent?.name ?? t("turnEnd.theAgent"), profile: profile.name })
            : t("conv.browsesInOwn", { name: agent?.name ?? t("turnEnd.theAgent") }),
        });
    },
    onError: (err) => toast.error(t("conv.profileError"), { description: errorMessage(err) }),
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
      const nameOf = (id: string) => servers.find((s) => s.id === id)?.name ?? t("conv.theServer");
      const added = next.find((id) => !ctx.prev.includes(id));
      const removed = ctx.prev.find((id) => !next.includes(id));
      if (added)
        toast.success(t("conv.nextCanUse", { name: nameOf(added) }), {
          description: t("conv.sshAddedHint"),
        });
      else if (removed) toast.success(t("conv.removedNamed", { name: nameOf(removed) }), { description: t("conv.sshRemovedHint") });
    },
    onError: (err) => {
      void qc.invalidateQueries({ queryKey: key });
      toast.error(t("conv.sshError"), { description: errorMessage(err) });
    },
  });

  const setAndroidDevices = useMutation({
    // One change at a time, in the order they were made.
    scope: { id: `android-devices:${conversationId}` },
    mutationFn: (androidDeviceIds: string[]) => api.conversations.update(conversationId, { androidDeviceIds }),
    onMutate: (next) => {
      const prev = qc.getQueryData<ConversationWithMessages>(key)?.androidDeviceIds ?? [];
      qc.setQueryData<ConversationWithMessages>(key, (c) => (c ? { ...c, androidDeviceIds: next } : c));
      return { prev };
    },
    onSuccess: (updated, next, ctx) => {
      // The cache already holds the latest pick (toggles can overlap); take everything else from the answer.
      qc.setQueryData<ConversationWithMessages>(key, (old) => (old ? { ...old, ...updated, androidDeviceIds: old.androidDeviceIds } : old));
      qc.invalidateQueries({ queryKey: qk.android });
      const devices = qc.getQueryData<AndroidDevice[]>(qk.androidDevices) ?? [];
      const nameOf = (id: string) => devices.find((d) => d.id === id)?.name ?? t("conv.thePhone");
      const added = next.find((id) => !ctx.prev.includes(id));
      const removed = ctx.prev.find((id) => !next.includes(id));
      if (added) toast.success(t("conv.nextCanUse", { name: nameOf(added) }), { description: t("conv.phoneAddedHint") });
      else if (removed) toast.success(t("conv.removedNamed", { name: nameOf(removed) }), { description: t("conv.phoneRemovedHint") });
    },
    onError: (err) => {
      void qc.invalidateQueries({ queryKey: key });
      toast.error(t("conv.phonesError"), { description: errorMessage(err) });
    },
  });

  const share = useMutation({
    mutationFn: (computerTarget: ComputerTarget | null) => api.conversations.update(conversationId, { computerTarget }),
    onSuccess: (updated, target) => {
      qc.setQueryData<ConversationWithMessages>(key, (old) => (old ? { ...old, ...updated } : old));
      if (target) {
        setComputerPanel(true);
        toast.success(t("conv.sharing", { target: computerTargetLabel(target, currentLanguage()) }), {
          description: busyRef.current ? t("conv.shareNext") : t("conv.shareNow", { name: agent?.name ?? t("turnEnd.theAgent") }),
        });
      } else toast(t("conv.stoppedSharing"));
    },
    onError: (err) => toast.error(t("conv.shareError"), { description: errorMessage(err) }),
  });

  const cancel = useMutation({
    mutationFn: async (runId: string) => {
      await api.runs.cancel(runId);
      return settleRun(runId);
    },
    onSuccess: (ended) => toast(ended ? t("conv.alreadyEnded") : t("conv.stopping")),
    onError: (err) => toast.error(t("pause.stopError"), { description: errorMessage(err) }),
  });

  // Read replies aloud: a dictated message with auto-speak on. Voice mode speaks by itself.
  const settingsRef = useRef(voiceSettings);
  settingsRef.current = voiceSettings;
  useEffect(
    () =>
      onServerEvent((e) => {
        if (e.type !== "run.finished" || e.run.conversationId !== conversationId) return;
        if (useUi.getState().voiceMode || e.run.status !== "succeeded") return;
        const wasVoice = !!useVoiceSession.getState().voiceRunIds[e.run.id];
        const wanted = wasVoice && (settingsRef.current?.enabled ?? true) && (settingsRef.current?.autoSpeak ?? true);
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
          title={notFound ? t("conv.notFound") : t("conv.loadError")}
          description={notFound ? t("conv.maybeDeleted") : errorMessage(error)}
          action={
            <Button asChild>
              <Link to="/">{t("conv.startNew")}</Link>
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
          onVoiceMode={dreamLog || voiceSettings?.enabled === false ? undefined : onVoiceMode}
          move={(onRunner || inGroup) && moveTargets.length ? { onSelect: () => openMove(onRunner ? (placeOf(hereId) ?? moveTargets[0]!) : moveTargets[0]!), blocked: null, label: onRunner ? undefined : t("conv.moveToAnother") } : undefined}
          browserToggle={
            <>
            {chatArtifacts.length > 0 && !showArtifactPanel && wide && (
              <ArtifactToggle count={chatArtifacts.length} onClick={() => showArtifact(conversationId, chatArtifacts[0]!.id)} />
            )}
            {chatVm ? (
              !showVmPanel && <VmToggle working={!!activeRunId} onClick={() => (wide ? setVmPanel(true) : setVmFocus(true))} />
            ) : (
            <>
              {computerTarget && !showComputerPanel && (
                <ComputerToggle working={!!activeRunId} onClick={() => (wide ? setComputerPanel(true) : setComputerFocus("watch"))} />
              )}
              {chatPhones.length > 0 && !showPhonePanel && !showComputerPanel && (
                <PhoneToggle working={!!activeRunId} onClick={() => (wide ? setPhonePanel(true) : navigate(`/android/${chatPhones[0]!.id}`))} />
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
            )}
            </>
          }
        />
        {conv.private && <PrivateChatNote />}

        <MoveChatDialog
          conversation={conv}
          from={chatPlace}
          targets={moveTargets}
          initial={moveTo}
          working={moveWorking}
          agentName={agent?.name ?? t("turnEnd.theAgent")}
          open={moving}
          onOpenChange={setMoving}
        />

        <ChatFilesScope conversationId={conversationId} runnerId={conv.runnerId}>
          <ArtifactScopeProvider value={{ conversationId, openId: showArtifactPanel ? artifactId : null }}>
          <SidePanelScopeProvider value={wide ? { conversationId, current: showSidePanel ? side : null } : null}>
          <QuestionScopeProvider value={{ conversationId, agentName: agent?.name ?? t("turnEnd.theAgent"), openId: waiting?.question?.id ?? null }}>
            <QuoteSelection onQuote={(text) => composerRef.current?.insert(text)} disabled={dreamLog || voiceMode}>
              <Thread
                messages={visibleMessages}
                focusId={focusMessage}
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
            </QuoteSelection>
          </QuestionScopeProvider>
          </SidePanelScopeProvider>
          </ArtifactScopeProvider>
        </ChatFilesScope>

        {dreamLog ? (
          <div className="relative shrink-0 px-3 pb-3 @xl:px-6 @xl:pb-4">
            <DreamLogNote agent={agent ?? { id: conv.agentId, name: t("turnEnd.theAgent"), enabled: true }} />
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
                    transition={{ duration: 0.2, ease: EASE_OUT }}
                    className="overflow-hidden"
                  >
                    <div className="mb-2 flex items-center gap-2.5 rounded-lg border bg-card py-1.5 pr-1.5 pl-3 text-[13px] text-muted-foreground shadow-card">
                      <Archive className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">
                        <Trans
                          t={t}
                          i18nKey={activeRunId || paused || conv.followup ? "conv.archivedBarOngoing" : "conv.archivedBar"}
                          components={{ b: <span className="font-medium text-foreground" /> }}
                        />
                      </span>
                      <Button size="xs" variant="ghost" onClick={() => setArchived(conv, false)}>
                        <ArchiveRestore /> {t("header.unarchive")}
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
                    transition={{ duration: 0.2, ease: EASE_OUT }}
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
                    transition={{ duration: 0.2, ease: EASE_OUT }}
                    className="overflow-hidden"
                  >
                    <PauseBar conversationId={conversationId} pause={paused} agentName={agent?.name ?? t("turnEnd.theAgent")} queued={queue.length} />
                  </motion.div>
                )}
                {runnerAway && runner && (
                  <motion.div
                    key="runner-away"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2, ease: EASE_OUT }}
                    className="overflow-hidden"
                  >
                    <RunnerOfflineBar runner={runner} onMove={() => openMove(placeOf(hereId))} />
                  </motion.div>
                )}
                {conv.followup && (
                  <motion.div
                    key="followup"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2, ease: EASE_OUT }}
                    className="overflow-hidden"
                  >
                    <FollowupBar conversationId={conversationId} followup={conv.followup} agentName={agent?.name ?? t("turnEnd.theAgent")} running={!!activeRunId || !!paused} />
                  </motion.div>
                )}
              </AnimatePresence>
              <AnimatePresence initial={false}>
                {gauge &&
                  gauge.tone !== "calm" &&
                  gauge.compressible &&
                  !compressing &&
                  !compressQueued &&
                  !runnerAway &&
                  (compressHiddenAt === null || gauge.tokens > compressHiddenAt * 1.2) && (
                    <motion.div
                      key="compress"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2, ease: EASE_OUT }}
                      className="overflow-hidden"
                    >
                      <CompressBar gauge={gauge} agentName={agent?.name ?? t("turnEnd.theAgent")} running={!!activeRunId} onCompress={compress} onDismiss={() => setCompressHiddenAt(gauge.tokens)} />
                    </motion.div>
                  )}
              </AnimatePresence>
              {(!conv.runnerId || inGroup) && <HumanTaskBar conversationId={conversationId} agentName={agent?.name ?? t("turnEnd.theAgent")} />}
              <QueueTray
                ref={queueRef}
                conversationId={conversationId}
                queue={queue}
                agentName={agent?.name ?? t("turnEnd.theAgent")}
                running={!!activeRunId}
                paused={paused?.reason ?? null}
                onLost={(text) => composerRef.current?.insert(text)}
                onDone={() => composerRef.current?.focus()}
              />
              <Composer
                ref={composerRef}
                draftKey={conv.private ? undefined : conversationId}
                agentId={conv.agentId}
                autoFocus
                running={!!activeRunId && !paused}
                blocked={agent && !agent.enabled ? `Switch ${agent.name} on to send` : undefined}
                disabled={runnerAway}
                onRecall={() => queueRef.current?.editLast() ?? false}
                options={
                  <>
                    {(onRunner || inGroup) && <RunnerPill place={chatPlace} targets={moveTargets} onMove={openMove} />}
                    {!onRunner && (
                      <FolderChip
                        chatFolder={conv.workingDirectory}
                        agentFolder={agent?.workingDirectory ?? null}
                        agentName={agent?.name}
                        onChange={(path) => setFolder.mutate(path)}
                        busy={setFolder.isPending}
                      />
                    )}
                    <ProjectChip
                      agent={agent}
                      workspaceId={conv.workspaceId ?? null}
                      value={conv.projectId ?? null}
                      onChange={(pick) => setProject.mutateAsync(pick).catch(() => undefined)}
                      busy={setProject.isPending}
                    />
                    {!chatVm && (
                      <>
                        <BrowserProfileChip
                          agent={agent}
                          value={conv.browserProfileId ?? null}
                          workspaceId={conv.workspaceId ?? null}
                          projectId={conv.projectId ?? null}
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
                      <AndroidChip
                        agent={agent}
                        value={conv.androidDeviceIds ?? []}
                        onChange={(ids) => setAndroidDevices.mutateAsync(ids).catch(() => undefined)}
                        busy={setAndroidDevices.isPending}
                      />
                    )}
                    {!onRunner && (
                      <VmChip
                        value={conv.vmId ?? null}
                        inherited={vmInherited}
                        onChange={(vmId) => setVm.mutateAsync(vmId).catch(() => undefined)}
                        busy={setVm.isPending}
                      />
                    )}
                    {!!conv.instructions && (
                      <InstructionsChip
                        value={conv.instructions}
                        agent={agent}
                        onChange={(text) => setInstructions.mutateAsync(text)}
                        busy={setInstructions.isPending}
                      />
                    )}
                  </>
                }
                sendHint={waiting ? t("question.sendAnswer") : paused ? (paused.reason === "limit" ? t("composer.queueMessage") : t("conv.sendAndContinue")) : undefined}
                placeholder={
                  runnerAway && chatPlace
                    ? chatPlace.state === "connecting"
                      ? t("conv.connectingTo", { name: chatPlace.name })
                      : chatPlace.state === "offline"
                        ? t("conv.isOffline", { name: chatPlace.name })
                        : t("conv.needsUpdate", { name: chatPlace.name })
                    : !agent
                    ? t("conv.messageEllipsis")
                    : !agent.enabled
                      ? t("conv.switchedOffDraft", { name: agent.name })
                    : waiting
                      ? approval
                        ? t("conv.replyOrApprove", { name: agent.name })
                        : t("question.answerPlaceholder", { name: agent.name })
                    : paused?.reason === "user"
                      ? t("conv.continueWithNew", { name: agent.name })
                      : paused
                        ? t("conv.goesAlongLimit", { name: agent.name })
                        : t("conv.messageOrCommands", { name: agent.name })
                }
                status={
                  gauge && (
                    <ContextMeter
                      gauge={gauge}
                      agentName={agent?.name ?? t("turnEnd.theAgent")}
                      running={!!activeRunId}
                      compressing={compressing || compressQueued}
                      disabled={runnerAway || send.isPending}
                      onCompress={compress}
                    />
                  )
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
        {showSidePanel && side.kind === "pull" && (
          <PullRequestPanel key={sideKey(side)} conversationId={conversationId} url={side.url} onHide={() => hideSide(conversationId)} />
        )}
        {showSidePanel && side.kind === "file" && (
          <Suspense key={sideKey(side)} fallback={null}>
            <FilePanel file={side.file} line={side.line} local={side.local} onHide={() => hideSide(conversationId)} />
          </Suspense>
        )}
        {showSidePanel && side.kind === "subagent" && subagentSide && (
          <SubagentPanel
            key={sideKey(side)}
            block={subagentSide.block}
            childBlocks={subagentSide.children}
            streaming={subagentSide.streaming}
            agent={agent}
            onHide={() => hideSide(conversationId)}
          />
        )}
        {showArtifactPanel && <ArtifactPanel key={`artifact-${artifactId}`} id={artifactId!} onHide={() => hideArtifact(conversationId)} />}
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
        {showPhonePanel && <PhonePanel key="phone" phones={chatPhones} activity={activeRunId ? liveActivityLabel(live) : null} onHide={() => setPhonePanel(false)} />}
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
  const { t } = useTranslation("chat");
  const toggle = useToggleAgent();
  return (
    <div className="mb-2 flex items-center gap-3 rounded-xl border bg-card py-2 pr-2 pl-2.5 shadow-card" role="status">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-muted text-muted-foreground">
        <PowerOff className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 leading-snug">
        <p className="truncate text-[13px] font-medium">{t("conv.switchedOff", { name: agent.name })}</p>
        <p className="text-xs text-muted-foreground">{t("conv.switchedOffHint")}</p>
      </div>
      <Button size="sm" variant="outline" className="shrink-0" disabled={toggle.isPending} onClick={() => toggle.mutate({ id: agent.id, enabled: true })}>
        {toggle.isPending ? <Spinner /> : <Power />} {t("conv.switchOn")}
      </Button>
    </div>
  );
}

/** Footer of an agent's dream log: nothing to send here — point to a fresh chat instead. */
function DreamLogNote({ agent }: { agent: Pick<Agent, "id" | "name" | "enabled"> }) {
  const { t } = useTranslation("chat");
  const agentName = agent.name;
  const chat = useStartAgentChat();
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-4 py-3 text-[13px] text-muted-foreground shadow-card">
      <span className="grid size-7 shrink-0 place-items-center rounded-lg border bg-dream-soft text-dream">
        <Moon className="size-3.5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 basis-56">
        <Trans t={t} i18nKey="conv.dreamLog" values={{ name: agentName }} components={{ b: <span className="font-medium text-foreground" /> }} />
      </span>
      <Button size="sm" variant="outline" disabled={chat.isPending} onClick={() => chat.mutate(agent)}>
        {chat.isPending ? <Spinner /> : <MessageSquarePlus />} {t("header.newChat")}
      </Button>
    </div>
  );
}

function ConversationWelcome({ agent, seed, onPick }: { agent?: Agent; seed: string; onPick: (text: string) => void }) {
  const { t } = useTranslation("chat");
  const { data: boot } = useBootstrap();
  const ideas = agent?.isDefault
    ? [
        { icon: Sparkles, text: t("conv.ideas.whatCanYouDo") },
        { icon: Wand2, text: t("conv.ideas.inboxAgent") },
        { icon: Brain, text: t("conv.ideas.remember") },
      ]
    : [
        { icon: Sparkles, text: t("conv.ideas.whatCanYouDo") },
        { icon: Wand2, text: t("conv.ideas.runUsual") },
        { icon: Brain, text: t("conv.ideas.learned") },
      ];
  return (
    <div className="flex flex-col items-center pt-[8vh] text-center">
      {agent && (
        <>
          <SpeechBubble tail="bottom" className="max-w-sm text-balance">
            {characterGreeting({ name: agent.name, personality: agent.personality, human: boot?.settings.general.userName, seed, lang: currentLanguage() })}
          </SpeechBubble>
          <AgentAvatar agent={agent} size="xl" follow className="mt-4 size-28" />
        </>
      )}
      <h2 className="mt-4 text-lg font-medium tracking-[-0.02em]">{agent?.name ?? t("conv.yourAgent")}</h2>
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
