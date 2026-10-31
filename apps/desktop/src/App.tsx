import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, type Location } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudErrorCode, type Bootstrap } from "@godmode/shared";
import { ApiRequestError, api, isCloudError, setCloudIssueHandler, setLicenseRequiredHandler, setUnauthorizedHandler, type CloudIssue } from "@/lib/api";
import { cloudContext, getCoreInfo, isTauri } from "@/lib/core";
import { qk } from "@/lib/queryKeys";
import { startRealtime, onServerEvent } from "@/lib/realtime";
import { notifyDesktop } from "@/lib/desktop";
import { useLicense } from "@/lib/hooks";
import { syncUpdater } from "@/stores/updater";
import { AppShell } from "@/components/layout/app-shell";
import { CloudStatePage, type CloudState } from "@/components/layout/cloud-state";
import { LicenseGate } from "@/components/license/license-gate";
import { SplashScreen } from "@/components/layout/splash";
import { LoginPage } from "@/pages/auth/login";
import { UnlockPage } from "@/pages/auth/unlock";
import { OnboardingPage } from "@/pages/onboarding/onboarding";
import { toast } from "sonner";
import { t } from "@/i18n";

const ChatHome = lazy(() => import("@/pages/chat/chat-home"));
const ChatConversation = lazy(() => import("@/pages/chat/chat-conversation"));
const ArchivedPage = lazy(() => import("@/pages/chat/archived-page"));
const AgentsPage = lazy(() => import("@/pages/agents/agents-page"));
const AgentNewPage = lazy(() => import("@/pages/agents/agent-new"));
const AgentDetailPage = lazy(() => import("@/pages/agents/agent-detail"));
const FilesPage = lazy(() => import("@/pages/files/files-page"));
const ArtifactPage = lazy(() => import("@/pages/artifacts/artifact-page"));
const AutomationsPage = lazy(() => import("@/pages/automations/automations-page"));
const PluginsPage = lazy(() => import("@/pages/plugins/plugins-page"));
const ActivityPage = lazy(() => import("@/pages/activity/activity-page"));
const WorkspacesPage = lazy(() => import("@/pages/workspaces/workspaces-page"));
const TasksPage = lazy(() => import("@/pages/tasks/tasks-page"));
const LoginsPage = lazy(() => import("@/pages/vault/logins-page"));
const TotpPage = lazy(() => import("@/pages/vault/totp-page"));
const CardsPage = lazy(() => import("@/pages/vault/cards-page"));
const PasskeysPage = lazy(() => import("@/pages/vault/passkeys-page"));
const BrowserPage = lazy(() => import("@/pages/browser/browser-page"));
const ComputerPage = lazy(() => import("@/pages/computer/computer-page"));
const VmsPage = lazy(() => import("@/pages/vms/vms-page"));
const SshPage = lazy(() => import("@/pages/ssh/ssh-page"));
const AndroidDevicePage = lazy(() => import("@/pages/android/android-device-page"));
const CallsPage = lazy(() => import("@/pages/calls/calls-page"));
const InboxPage = lazy(() => import("@/pages/inbox/inbox-page"));
const SettingsDialog = lazy(() => import("@/pages/settings/settings-page"));

const isSettingsPath = (pathname: string) => pathname === "/settings" || pathname.startsWith("/settings/");

export function App() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // The page on screen as the router sees it (through Godmode Cloud the address bar has a /d/<device> prefix).
  const location = useLocation();
  const onScreen = useRef("");
  onScreen.current = `${location.pathname}${location.search}`;
  const settingsOpen = isSettingsPath(location.pathname);
  const underSettings = useRef<Location | null>(null);
  if (!settingsOpen) underSettings.current = location;
  const [coreReady, setCoreReady] = useState(false);
  const [coreError, setCoreError] = useState<string | null>(null);
  const [cloudIssue, setCloudIssue] = useState<CloudIssue | null>(null);

  useEffect(() => {
    getCoreInfo()
      .then(() => setCoreReady(true))
      .catch((e) => setCoreError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => syncUpdater(), []);

  useEffect(() => {
    setUnauthorizedHandler(() => qc.invalidateQueries({ queryKey: qk.authStatus }));
    // Cloud mode: an offline computer or a used-up plan replaces the whole dashboard until it clears.
    setCloudIssueHandler((issue) => setCloudIssue((prev) => (prev?.kind === issue.kind ? prev : issue)));
    // A run start refused for the licence: one calm toast that leads to activation (and the gate, when it blocks).
    setLicenseRequiredHandler((message) => {
      void qc.invalidateQueries({ queryKey: qk.license });
      toast.warning(t("layout:app.licenseRequired"), {
        id: "license-required",
        description: message,
        duration: 12_000,
        action: { label: t("layout:app.activate"), onClick: () => navigate("/settings/license") },
      });
    });
  }, [qc, navigate]);

  // The cloud's own answers (offline, signed out, plan limit) come back at once; retrying them only delays the page.
  const auth = useQuery({
    queryKey: qk.authStatus,
    queryFn: api.auth.status,
    enabled: coreReady,
    retry: (count, err) => !isCloudError(err) && count < 30,
    retryDelay: 500,
  });
  const authed = auth.data?.authenticated ?? false;
  const boot = useQuery({ queryKey: qk.bootstrap, queryFn: api.bootstrap, enabled: authed, staleTime: 5_000 });
  // The licence gate is for the computer itself; through the cloud, refused runs say why in their toast.
  const license = useLicense(authed && !cloudContext && !!boot.data?.settings.onboardingComplete && !!boot.data?.vault.unlocked);

  const recheck = useCallback(async () => {
    const status = await api.auth.status();
    qc.setQueryData(qk.authStatus, status);
    setCloudIssue(null);
    await qc.invalidateQueries();
  }, [qc]);

  // Desktop: tell the shell whether closing the window should keep Godmode running in the tray.
  const minimizeToTray = boot.data?.settings.general.minimizeToTray;
  useEffect(() => {
    if (!isTauri || minimizeToTray === undefined) return;
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("set_close_to_tray", { enabled: minimizeToTray })).catch(() => {});
  }, [minimizeToTray]);

  // Realtime connection once authenticated
  useEffect(() => {
    if (!authed) return;
    return startRealtime(qc);
  }, [authed, qc]);

  // Toasts + desktop notifications for important events
  useEffect(() => {
    if (!authed) return;
    return onServerEvent((event) => {
      // A question that was answered or withdrawn (here, in another window, on the phone) takes its toast along.
      if (event.type === "question.updated" && event.question.status !== "open") {
        const q = event.question;
        toast.dismiss(`question:${q.taskId ? `/tasks?task=${q.taskId}` : `/chat/${q.conversationId}`}`);
        return;
      }
      if (event.type === "notification" && event.notification.kind === "question") {
        // An agent waits for the human: a toast that leads to the question, unless it is on screen already.
        const n = event.notification;
        const here = !!n.link && onScreen.current === n.link && document.hasFocus();
        if (here) {
          void api.notifications.read([n.id]).catch(() => undefined);
          return;
        }
        toast.warning(n.title, {
          id: n.link ? `question:${n.link}` : undefined,
          description: n.body || undefined,
          duration: 20_000,
          action: n.link ? { label: n.link.startsWith("/my-tasks") ? t("common:actions.open") : t("layout:app.answer"), onClick: () => navigate(n.link!) } : undefined,
        });
        const desktopOn = qc.getQueryData<{ settings?: { general?: { desktopNotifications?: boolean } } }>(qk.bootstrap)?.settings?.general
          ?.desktopNotifications;
        if (desktopOn !== false && !document.hasFocus()) void notifyDesktop(n.title, n.body);
        return;
      }
      if (event.type === "notification") {
        const n = event.notification;
        const fn = n.kind === "error" ? toast.error : n.kind === "warning" || n.kind === "missing_login" ? toast.warning : n.kind === "success" ? toast.success : toast;
        const here = !!n.link && onScreen.current === n.link && document.hasFocus();
        // Already on screen: nothing to pop up, it's read.
        if (here) {
          void api.notifications.read([n.id]).catch(() => undefined);
          return;
        }
        fn(n.title, {
          description: n.body || undefined,
          action: n.link
            ? {
                label: t("common:actions.open"),
                onClick: () => {
                  navigate(n.link!);
                  void api.notifications.read([n.id]).catch(() => undefined);
                },
              }
            : undefined,
        });
        const desktopOn = qc.getQueryData<{ settings?: { general?: { desktopNotifications?: boolean } } }>(qk.bootstrap)?.settings?.general
          ?.desktopNotifications;
        if (desktopOn !== false && !document.hasFocus()) void notifyDesktop(n.title, n.body);
      }
    });
  }, [authed, qc, navigate]);

  if (coreError) return <SplashScreen error={coreError} />;
  if (cloudContext) {
    const state = cloudIssue ?? cloudBlock(auth.error, auth.data?.authenticated, boot.error, boot.data);
    if (state) return <CloudStatePage cloud={cloudContext} state={state} onRetry={recheck} />;
  }
  if (!coreReady || auth.isLoading) return <SplashScreen />;
  if (auth.isError) {
    // Signed out of the cloud: the browser is already on its way to the sign-in page.
    if (auth.error instanceof ApiRequestError && auth.error.code === CloudErrorCode.CloudUnauthorized) return <SplashScreen />;
    return <SplashScreen error={cloudContext ? t("layout:app.cannotReachCloud") : t("layout:app.cannotReachCore")} />;
  }
  // In cloud mode the cloud signs people in; the core's own sign-in page never shows there.
  if (!authed) return cloudContext ? <SplashScreen /> : <LoginPage hasPassword={auth.data?.hasDashboardPassword ?? false} />;
  if (!boot.data) return <SplashScreen />;

  const b = boot.data;
  if (!b.vault.initialized || !b.settings.onboardingComplete) return <OnboardingPage bootstrap={b} />;
  if (!b.vault.unlocked) return <UnlockPage />;
  if (!cloudContext && license.data?.blocked) return <LicenseGate state={license.data} />;

  return (
    <AppShell>
      <Suspense fallback={<div className="p-8" />}>
        <Routes location={settingsOpen ? (underSettings.current ?? "/") : location}>
          <Route path="/" element={<ChatHome />} />
          <Route path="/chat/:conversationId" element={<ChatConversation />} />
          <Route path="/archived" element={<ArchivedPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/new" element={<AgentNewPage />} />
          <Route path="/agents/:agentId/*" element={<AgentDetailPage />} />
          <Route path="/artifacts" element={<ToSettings section="artifacts" />} />
          <Route path="/artifacts/:artifactId" element={b.settings.artifacts.enabled ? <ArtifactPage /> : <ToSettings section="artifacts" />} />
          <Route path="/files" element={<Navigate to="/settings/files" replace />} />
          <Route path="/files/:agentId" element={<FilesPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/my-tasks" element={<MyTasksRedirect />} />
          <Route path="/automations" element={<AutomationsPage />} />
          <Route path="/routines" element={<Navigate to="/automations" replace />} />
          <Route path="/plugins" element={<FeaturePage on={b.settings.plugins.enabled} section="plugins" keep="plugin"><PluginsPage /></FeaturePage>} />
          <Route path="/mods" element={<LegacyModsRedirect />} />
          <Route path="/activity" element={<FeaturePage on={b.settings.activity.enabled} section="activity" keep="run"><ActivityPage /></FeaturePage>} />
          <Route path="/workspaces" element={<WorkspacesPage />} />
          <Route path="/vault" element={<Navigate to="/vault/logins" replace />} />
          <Route path="/vault/logins" element={<LoginsPage />} />
          <Route path="/vault/2fa" element={<TotpPage />} />
          <Route path="/vault/cards" element={<FeaturePage on={b.settings.cards.enabled} section="cards"><CardsPage /></FeaturePage>} />
          <Route path="/vault/passkeys" element={<PasskeysPage />} />
          <Route path="/integrations" element={<ToSettings section="integrations" />} />
          <Route path="/messaging" element={<ToSettings section="messaging" />} />
          <Route path="/browser" element={<BrowserPage />} />
          <Route path="/computer" element={<ComputerPage />} />
          <Route path="/vms" element={<FeaturePage on={b.settings.vm.enabled} section="vms"><VmsPage /></FeaturePage>} />
          <Route path="/ssh" element={<FeaturePage on={b.settings.ssh.enabled} section="ssh"><SshPage /></FeaturePage>} />
          <Route path="/android" element={<ToSettings section="android" />} />
          <Route path="/android/:id" element={b.settings.android.enabled ? <AndroidDevicePage /> : <ToSettings section="android" />} />
          <Route path="/calls" element={<FeaturePage on={b.settings.phone.enabled} section="calls" keep="call"><CallsPage /></FeaturePage>} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="*" element={<NotFoundRedirect />} />
        </Routes>
      </Suspense>
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsDialog closeTo={underSettings.current ?? "/"} />
        </Suspense>
      )}
    </AppShell>
  );
}

/** Cloud mode: the computer refuses this browser, or can't be used from here yet. */
function cloudBlock(authError: unknown, authenticated: boolean | undefined, bootError: unknown, boot: Bootstrap | undefined): CloudState | null {
  for (const err of [authError, bootError]) {
    if (err instanceof ApiRequestError && (err.code === CloudErrorCode.CloudForbidden || err.code === CloudErrorCode.DeviceNotFound)) {
      return { kind: "blocked", title: t("layout:app.cloudBlock.cantOpen"), message: err.message };
    }
  }
  if (authenticated === false) {
    return {
      kind: "blocked",
      title: t("layout:app.cloudBlock.browserOffTitle"),
      message: t("layout:app.cloudBlock.browserOffMessage"),
    };
  }
  if (boot && (!boot.vault.initialized || !boot.settings.onboardingComplete)) {
    return {
      kind: "blocked",
      title: t("layout:app.cloudBlock.notSetUpTitle"),
      message: t("layout:app.cloudBlock.notSetUpMessage"),
    };
  }
  return null;
}

function NotFoundRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate("/", { replace: true });
  }, [navigate]);
  return null;
}

/** Links from before Mods were Plugins (notifications, chat notes): /mods?mod=<id> → /plugins?plugin=<id>. */
/** My tasks became the Inbox's board: old links (notifications, tickets) open the same task there. */
/**
 * A page of a feature the human can turn off: while it's off, its address opens the feature's switch in Settings. A
 * link to one record (a run, a call) still opens it.
 */
function FeaturePage({ on, section, keep, children }: { on: boolean; section: string; keep?: string; children: ReactNode }) {
  const { search } = useLocation();
  if (on || (keep && new URLSearchParams(search).has(keep))) return children;
  return <Navigate to={`/settings/${section}`} replace />;
}

/** A page that moved into Settings: its old address, with its query (?tab=, ?connection=), opens the section. */
function ToSettings({ section }: { section: string }) {
  const { search } = useLocation();
  if (section === "integrations" && new URLSearchParams(search).get("tab") === "api-keys") return <Navigate to="/settings/api-keys" replace />;
  return <Navigate to={`/settings/${section}${search}`} replace />;
}

function MyTasksRedirect() {
  const params = new URLSearchParams(useLocation().search);
  if (!params.has("task")) params.set("view", "board");
  return <Navigate to={`/inbox?${params}`} replace />;
}

function LegacyModsRedirect() {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const id = params.get("mod");
  if (id) {
    params.delete("mod");
    params.set("plugin", id);
  }
  const query = params.toString();
  return <Navigate to={`/plugins${query ? `?${query}` : ""}`} replace />;
}
