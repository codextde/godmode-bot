import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { browserView, computerTargetLabel, computerView, type Agent, type BrowserProfile, type Conversation, type Vm } from "@godmode/shared";
import { api } from "./api";
import { useLive, type Frame } from "./live";
import { qk } from "./query";
import { subscribeBrowser, subscribeComputer } from "./realtime";

/** Something an agent works on that the phone can watch. */
export type LiveScreen =
  /** `conversationId`: that chat's own tab (chats browse in parallel, each in its tabs). */
  | { kind: "browser"; key: string; id: string; conversationId: string | null; title: string; running: boolean }
  | { kind: "vm"; key: string; id: string; title: string; vm: Vm }
  | { kind: "share"; key: string; view: string; title: string; conversationId: string };

export function screenHref(screen: LiveScreen) {
  const params =
    screen.kind === "share"
      ? { kind: screen.kind, id: screen.view, title: screen.title }
      : screen.kind === "browser"
        ? { kind: screen.kind, id: screen.id, title: screen.title, chat: screen.conversationId ?? "" }
        : { kind: screen.kind, id: screen.id, title: screen.title };
  return { pathname: "/live" as const, params };
}

export function useLiveScreens() {
  const profiles = useQuery({ queryKey: qk.browserProfiles, queryFn: api.browser.profiles });
  const vms = useQuery({ queryKey: qk.vms, queryFn: api.vms.list, retry: false });
  const conversations = useQuery({ queryKey: qk.conversationList(""), queryFn: () => api.conversations.list({ limit: 100 }) });

  const screens = useMemo(() => {
    const out: LiveScreen[] = [];
    for (const c of shared(conversations.data)) {
      const view = computerView(c.computerTarget!);
      if (!out.some((s) => s.key === `computer:${view}`)) out.push({ kind: "share", key: `computer:${view}`, view, title: computerTargetLabel(c.computerTarget!), conversationId: c.id });
    }
    for (const p of profiles.data ?? []) {
      const chats = p.running ? p.chats : [];
      for (const chat of chats) out.push(browserScreen(p, chat.conversationId, chat.title || chat.pageTitle || p.name));
      if (!chats.length) out.push(browserScreen(p, null, p.name));
    }
    for (const vm of vms.data ?? []) out.push({ kind: "vm", key: `vm:${vm.id}`, id: vm.id, title: vm.name, vm });
    return out.sort((a, b) => rank(b) - rank(a));
  }, [profiles.data, vms.data, conversations.data]);

  return {
    screens,
    loading: profiles.isLoading || conversations.isLoading,
    refetch: () => Promise.all([profiles.refetch(), vms.refetch(), conversations.refetch()]),
  };
}

function browserScreen(profile: BrowserProfile, conversationId: string | null, title: string): LiveScreen {
  return { kind: "browser", key: `browser:${browserView(profile.id, conversationId)}`, id: profile.id, conversationId, title, running: profile.running };
}

function shared(list: Conversation[] | undefined) {
  return (list ?? []).filter((c) => c.computerTarget);
}

function rank(s: LiveScreen): number {
  if (s.kind === "share") return 3;
  if (s.kind === "browser") return s.running ? 2 : 0;
  return s.vm.state === "running" ? 2.5 : s.vm.state === "starting" ? 1 : 0.5;
}

export function isLive(s: LiveScreen): boolean {
  return s.kind === "share" || (s.kind === "browser" ? s.running : s.vm.state === "running");
}

/** The newest picture of a browser or shared screen, streamed while this is mounted. */
export function useStreamFrame(screen: LiveScreen | null, active = true): Frame | undefined {
  const key = screen && screen.kind !== "vm" ? screen.key : null;
  const target = screen?.kind === "browser" ? screen.id : screen?.kind === "share" ? screen.view : null;
  const chat = screen?.kind === "browser" ? screen.conversationId : null;
  const kind = screen?.kind;
  useEffect(() => {
    if (!active || !target) return;
    return kind === "browser" ? subscribeBrowser(target, chat) : subscribeComputer(target);
  }, [active, kind, target, chat]);
  return useLive((s) => (key ? s.frames[key] : undefined));
}

/** A running VM's screen, polled while visible (VMs have no stream). */
export function useVmFrame(vm: Vm | null, active = true, intervalMs = 2500) {
  return useQuery({
    queryKey: qk.vmScreen(vm?.id ?? "none"),
    queryFn: async (): Promise<Frame> => {
      const shot = await api.vms.screenshot(vm!.id, 1280);
      return { data: shot.data, mime: shot.mime, width: shot.width, height: shot.height, title: vm!.name, at: Date.now() };
    },
    enabled: active && vm?.state === "running",
    refetchInterval: active ? intervalMs : false,
    placeholderData: (prev) => prev,
    retry: false,
  });
}

/** Mirrors the core: the chat's profile, the agent's pinned one, the workspace default, the global default. */
function chatBrowser(conversation: Conversation, agent: Agent, profiles: BrowserProfile[]): BrowserProfile | undefined {
  const workspaceId = agent.workspaceId ?? conversation.workspaceId;
  return (
    profiles.find((p) => p.id === conversation.browserProfileId) ??
    profiles.find((p) => p.id === agent.browser.profileId) ??
    (workspaceId ? profiles.find((p) => p.workspaceId === workspaceId && p.isDefault) : undefined) ??
    profiles.find((p) => !p.workspaceId && p.isDefault)
  );
}

/** Where this chat's agent works: a screen shared in the chat, its VM, or its browser — best first. */
export function useChatScreens(conversation: Conversation | undefined, agent: Agent | undefined): LiveScreen[] {
  const profiles = useQuery({ queryKey: qk.browserProfiles, queryFn: api.browser.profiles });
  const vms = useQuery({ queryKey: qk.vms, queryFn: api.vms.list, retry: false });
  const workspaces = useQuery({ queryKey: qk.workspaces, queryFn: api.workspaces });
  return useMemo(() => {
    if (!conversation || !agent) return [];
    const out: LiveScreen[] = [];
    if (conversation.computerTarget) {
      const view = computerView(conversation.computerTarget);
      out.push({ kind: "share", key: `computer:${view}`, view, title: computerTargetLabel(conversation.computerTarget), conversationId: conversation.id });
    }
    const workspaceVm = workspaces.data?.find((w) => w.id === agent.workspaceId)?.vmId ?? null;
    const vm = vms.data?.find((v) => v.id === (conversation.vmId ?? agent.vmId ?? workspaceVm));
    if (vm) out.push({ kind: "vm", key: `vm:${vm.id}`, id: vm.id, title: vm.name, vm });
    else if (agent.browser.enabled) {
      const profile = chatBrowser(conversation, agent, profiles.data ?? []);
      if (profile) out.push(browserScreen(profile, conversation.id, profile.name));
    }
    return out;
  }, [conversation, agent, profiles.data, vms.data, workspaces.data]);
}
