import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { browserView, type Agent, type BrowserProfile } from "@godmode/shared";
import { ArrowUpRight, Globe, Hand, Layers, Maximize2, PanelRightClose, PanelRightOpen, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LiveDot, WorkingTicks } from "@/components/aicss/Motion";
import { Orb } from "@/components/aicss/Orb";
import { LiveView } from "@/components/browser/live-view";
import { useProfileActions } from "@/components/browser/use-profile-actions";
import { Favicon } from "@/components/vault/favicon";
import { domainFromUrl } from "@/components/vault/vault-utils";
import { useNow } from "@/components/vault/use-now";
import { api } from "@/lib/api";
import { useSettings, useWorkspaceName } from "@/lib/hooks";
import { isTauri } from "@/lib/core";
import { isMac } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { subscribeBrowser } from "@/lib/realtime";
import { useLive } from "@/stores/live";
import { cn } from "@/lib/utils";

export type BrowserFocusMode = "watch" | "control";

/** The profile new chats in a workspace browse with: its default, else the global default. */
export function defaultProfileFor(profiles: BrowserProfile[], workspaceId: string | null | undefined): BrowserProfile | null {
  const workspaceDefault = workspaceId ? profiles.find((p) => p.workspaceId === workspaceId && p.isDefault) : undefined;
  return workspaceDefault ?? profiles.find((p) => !p.workspaceId && p.isDefault) ?? null;
}

/**
 * Mirrors the core's resolveProfileForAgent: the chat's profile → pinned profile → default of the agent's (or the
 * chat's) workspace → global default.
 */
export function agentBrowserProfile(
  agent: Agent,
  profiles: BrowserProfile[],
  chatProfileId: string | null = null,
  chatWorkspaceId: string | null = null,
): BrowserProfile | null {
  const own = chatProfileId ? profiles.find((p) => p.id === chatProfileId) : undefined;
  if (own) return own;
  const pinned = agent.browser.profileId ? profiles.find((p) => p.id === agent.browser.profileId) : undefined;
  if (pinned) return pinned;
  return defaultProfileFor(profiles, agent.workspaceId ?? chatWorkspaceId);
}

/** The browser profile this chat drives (null when its agent has no browser). */
export function useChatBrowser(agent: Agent | undefined, chatProfileId: string | null = null, chatWorkspaceId: string | null = null): BrowserProfile | null {
  const { data: settings } = useSettings();
  const enabled = !!agent?.browser.enabled && settings?.browser.enabled !== false;
  const { data: profiles } = useQuery({ queryKey: qk.browserProfiles, queryFn: api.browser.profiles, enabled });
  return enabled && agent && profiles ? agentBrowserProfile(agent, profiles, chatProfileId, chatWorkspaceId) : null;
}

/** The chat's own tab in its agent's browser (undefined until the agent opens one). */
export function useChatTab(profile: BrowserProfile | null, conversationId: string) {
  return profile?.running ? profile.chats.find((c) => c.conversationId === conversationId) : undefined;
}

function useFrame(profile: BrowserProfile, conversationId: string) {
  const frame = useLive((s) => (profile.running ? s.frames[browserView(profile.id, conversationId)] : undefined));
  const now = useNow(1000);
  return { frame, live: !!frame && now - frame.at < 4000 };
}

export function BrowserPanel({
  profile,
  conversationId,
  agent,
  forChat,
  activity,
  onHide,
  onFocus,
}: {
  profile: BrowserProfile;
  conversationId: string;
  agent: Agent;
  /** The profile was picked for this chat rather than inherited from the agent. */
  forChat?: boolean;
  /** What the agent is doing right now; null while this chat is idle. */
  activity: string | null;
  onHide: () => void;
  onFocus: (mode: BrowserFocusMode) => void;
}) {
  const { frame, live: streaming } = useFrame(profile, conversationId);
  const hasFrame = !!frame;
  const chat = useChatTab(profile, conversationId);
  const { data: settings } = useSettings();
  const liveViewOff = settings?.browser.liveView === false;
  const [waitedLong, setWaitedLong] = useState(false);
  // A fresh frame counts too: it can arrive before the tab shows up in the profile's chats.
  const hasTab = !!chat || streaming;
  const actions = useProfileActions();

  useEffect(() => subscribeBrowser(profile.id, { passive: true, conversationId }), [profile.id, conversationId]);

  useEffect(() => {
    setWaitedLong(false);
    if (hasFrame) return;
    const t = setTimeout(() => setWaitedLong(true), 5000);
    return () => clearTimeout(t);
  }, [hasFrame, profile.id, conversationId]);

  const url = frame?.url ?? chat?.url;
  const pageTitle = frame?.title || chat?.pageTitle;
  const domain = domainFromUrl(url);
  const parallel = profile.chats.filter((c) => c.conversationId !== conversationId && c.active).length;

  return (
    <motion.aside
      aria-label="Browser"
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 320, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 36 }}
      className="h-full shrink-0 overflow-hidden border-l bg-paper-2"
    >
      <div className="flex h-full w-80 flex-col">
        <div className={cn("flex h-14 shrink-0 items-center gap-2 border-b px-4", isTauri && isMac && "h-auto pt-7 pb-2")}>
          <span className="text-sm font-medium">Browser</span>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[5px] border px-1.5 py-0.5 text-[11px] font-medium",
              streaming ? "border-brand/25 bg-brand-soft text-brand-strong" : "bg-card text-muted-foreground",
            )}
          >
            <LiveDot live={streaming} />
            {streaming ? "Live" : profile.running ? "Idle" : "Closed"}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="-mr-1.5 ml-auto text-muted-foreground" onClick={onHide} aria-label="Hide browser">
                <PanelRightClose />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Hide browser</TooltipContent>
          </Tooltip>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {!hasTab ? (
            <div className="relative overflow-hidden rounded-xl border bg-card shadow-card" style={{ aspectRatio: "16 / 10" }}>
              <span className="absolute inset-0 grid place-items-center bg-paper-2 px-6 text-center">
                <span className="flex flex-col items-center gap-2.5">
                  <span className="grid size-9 place-items-center rounded-xl border bg-card text-muted-foreground shadow-card">
                    <Globe className="size-4" />
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {profile.running ? "No page open in this chat yet" : "Closed — opens when it's needed"}
                  </span>
                  {profile.running ? (
                    <Button size="xs" variant="outline" onClick={() => onFocus("watch")}>
                      <Maximize2 /> Open a page
                    </Button>
                  ) : (
                    <Button size="xs" variant="outline" onClick={() => actions.launch.mutate(profile)} disabled={actions.launch.isPending}>
                      {actions.launch.isPending ? <Spinner className="size-3" /> : <Play />} Launch now
                    </Button>
                  )}
                </span>
              </span>
            </div>
          ) : (
            <div className={cn("rounded-xl", activity && "glow-border")}>
              <button
                type="button"
                onClick={() => onFocus("watch")}
                aria-label="Open the browser full size"
                className="group/preview relative block max-h-[45vh] w-full overflow-hidden rounded-xl border bg-card shadow-card outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                style={{ aspectRatio: frame ? `${frame.width} / ${frame.height}` : "16 / 10" }}
              >
                {frame ? (
                  <img
                    src={`data:image/jpeg;base64,${frame.data}`}
                    alt={frame.title ? `Live view: ${frame.title}` : "Live view"}
                    draggable={false}
                    className="absolute inset-0 size-full object-cover object-top select-none"
                  />
                ) : (
                  <span className="absolute inset-0 grid place-items-center bg-paper-2 px-6 text-center">
                    <span className="flex flex-col items-center gap-2.5">
                      {liveViewOff ? (
                        <span className="text-xs text-muted-foreground">Live view is off</span>
                      ) : (
                        <>
                          <Orb variant="C3" size={24} label="Connecting to the screen" />
                          <span className="text-shimmer text-xs font-medium">{waitedLong ? "No picture yet" : "Connecting…"}</span>
                        </>
                      )}
                    </span>
                  </span>
                )}
                <span className="absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition group-hover/preview:bg-black/30 group-hover/preview:opacity-100 group-focus-visible/preview:bg-black/30 group-focus-visible/preview:opacity-100">
                  <span className="glass inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-foreground">
                    <Maximize2 className="size-3.5" /> Watch full size
                  </span>
                </span>
              </button>
            </div>
          )}

          {hasTab && (
            <div className="flex min-w-0 items-center gap-2.5">
              {domain ? (
                <Favicon domain={domain} name={frame?.title || domain} size="sm" />
              ) : (
                <span className="grid size-6 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground">
                  <Globe className="size-3.5" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] leading-5 font-medium">{pageTitle || domain || "New tab"}</p>
                <p className="truncate font-mono text-[11px] leading-4 text-muted-foreground">{domain || "about:blank"}</p>
              </div>
              {chat && chat.tabs > 1 && (
                <span className="shrink-0 rounded-[5px] border bg-card px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">{chat.tabs} tabs</span>
              )}
            </div>
          )}

          <AnimatePresence initial={false}>
            {activity && (
              <motion.div
                key="activity"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2 shadow-card">
                  <WorkingTicks count={8} className="shrink-0 text-brand" />
                  <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{activity}</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {hasTab && (
            <div className="flex gap-2">
              <Button size="sm" className="flex-1" onClick={() => onFocus("control")} disabled={!frame}>
                <Hand /> Take control
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="icon-sm" onClick={() => onFocus("watch")} aria-label="Watch full size">
                    <Maximize2 />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Watch full size</TooltipContent>
              </Tooltip>
            </div>
          )}
          {hasTab && !frame && (liveViewOff || waitedLong) && (
            <p className="text-xs text-muted-foreground">
              {liveViewOff ? "Turn on live view in Settings → Browser to watch and take control here." : "Still nothing? The page may still be loading."}
            </p>
          )}
        </div>

        <ProfileFooter profile={profile} conversationId={conversationId} forChat={!!forChat} pinned={agent.browser.profileId === profile.id} parallel={parallel} />
      </div>
    </motion.aside>
  );
}

function ProfileFooter({
  profile,
  conversationId,
  forChat,
  pinned,
  parallel,
}: {
  profile: BrowserProfile;
  conversationId: string;
  forChat: boolean;
  pinned: boolean;
  parallel: number;
}) {
  const workspace = useWorkspaceName(profile.workspaceId);
  const detail = parallel
    ? `Own tab · ${parallel} more ${parallel === 1 ? "chat" : "chats"} browsing alongside`
    : forChat
      ? "Own tab · profile picked for this chat"
      : pinned
        ? "Own tab · profile pinned in this agent's settings"
        : `Own tab · logins shared with every chat${profile.workspaceId ? ` in ${workspace}` : ""}`;
  return (
    <Link
      to={`/browser?profile=${profile.id}&chat=${conversationId}`}
      className="group flex shrink-0 items-center gap-3 border-t px-4 py-3 transition hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground shadow-card">
        <Layers className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{profile.name} profile</span>
        <span className="block truncate text-[11px] text-muted-foreground">{detail}</span>
      </span>
      <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
    </Link>
  );
}

/** Full-size live view of the chat's tab on top of the chat, optionally starting in takeover mode. */
export function BrowserFocus({
  profile,
  conversationId,
  mode,
  onClose,
}: {
  profile: BrowserProfile | null;
  conversationId: string;
  mode: BrowserFocusMode | null;
  onClose: () => void;
}) {
  const actions = useProfileActions();
  return (
    <AnimatePresence>
      {profile && mode && (
        <LiveView
          key={`${profile.id}:${mode}`}
          profile={profile}
          conversationId={conversationId}
          expanded
          onExpandedChange={(expanded) => !expanded && onClose()}
          defaultTakeover={mode === "control"}
          onLaunch={() => actions.launch.mutate(profile)}
          launching={actions.launch.isPending}
        />
      )}
    </AnimatePresence>
  );
}

/** Header button that brings the browser back once the panel is hidden (or opens it full size on narrow windows). */
export function BrowserToggle({ working, onClick }: { working: boolean; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Show browser" onClick={onClick} className="relative text-muted-foreground">
          <PanelRightOpen />
          {working && <LiveDot className="absolute top-1.5 right-1.5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>Show browser</TooltipContent>
    </Tooltip>
  );
}
