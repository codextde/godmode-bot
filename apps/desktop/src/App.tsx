import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudErrorCode, type Bootstrap } from "@godmode/shared";
import { ApiRequestError, api, isCloudError, setCloudIssueHandler, setUnauthorizedHandler, type CloudIssue } from "@/lib/api";
import { cloudContext, getCoreInfo, isTauri } from "@/lib/core";
import { qk } from "@/lib/queryKeys";
import { startRealtime, onServerEvent } from "@/lib/realtime";
import { notifyDesktop } from "@/lib/desktop";
import { syncUpdater } from "@/stores/updater";
import { AppShell } from "@/components/layout/app-shell";
import { CloudStatePage, type CloudState } from "@/components/layout/cloud-state";
import { SplashScreen } from "@/components/layout/splash";
import { LoginPage } from "@/pages/auth/login";
import { UnlockPage } from "@/pages/auth/unlock";
import { OnboardingPage } from "@/pages/onboarding/onboarding";
import { toast } from "sonner";

const ChatHome = lazy(() => import("@/pages/chat/chat-home"));
const ChatConversation = lazy(() => import("@/pages/chat/chat-conversation"));
const ArchivedPage = lazy(() => import("@/pages/chat/archived-page"));
const AgentsPage = lazy(() => import("@/pages/agents/agents-page"));
const AgentNewPage = lazy(() => import("@/pages/agents/agent-new"));
const AgentDetailPage = lazy(() => import("@/pages/agents/agent-detail"));
const AutomationsPage = lazy(() => import("@/pages/automations/automations-page"));
const ModsPage = lazy(() => import("@/pages/mods/mods-page"));
const ActivityPage = lazy(() => import("@/pages/activity/activity-page"));
const WorkspacesPage = lazy(() => import("@/pages/workspaces/workspaces-page"));
const TasksPage = lazy(() => import("@/pages/tasks/tasks-page"));
const LoginsPage = lazy(() => import("@/pages/vault/logins-page"));
const TotpPage = lazy(() => import("@/pages/vault/totp-page"));
const IntegrationsPage = lazy(() => import("@/pages/integrations/integrations-page"));
const MessagingPage = lazy(() => import("@/pages/messaging/messaging-page"));
const BrowserPage = lazy(() => import("@/pages/browser/browser-page"));
const ComputerPage = lazy(() => import("@/pages/computer/computer-page"));
const VmsPage = lazy(() => import("@/pages/vms/vms-page"));
const SshPage = lazy(() => import("@/pages/ssh/ssh-page"));
const RunnersPage = lazy(() => import("@/pages/runners/runners-page"));
const InboxPage = lazy(() => import("@/pages/inbox/inbox-page"));
const SettingsPage = lazy(() => import("@/pages/settings/settings-page"));

export function App() {
  const qc = useQueryClient();
  const navigate = useNavigate();
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
  }, [qc]);

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
        const here = n.link && `${location.pathname}${location.search}` === n.link && document.hasFocus();
        if (here) {
          void api.notifications.read([n.id]).catch(() => undefined);
          return;
        }
        toast.warning(n.title, {
          id: n.link ? `question:${n.link}` : undefined,
          description: n.body || undefined,
          duration: 20_000,
          action: n.link ? { label: "Answer", onClick: () => navigate(n.link!) } : undefined,
        });
        const desktopOn = qc.getQueryData<{ settings?: { general?: { desktopNotifications?: boolean } } }>(qk.bootstrap)?.settings?.general
          ?.desktopNotifications;
        if (desktopOn !== false && !document.hasFocus()) void notifyDesktop(n.title, n.body);
        return;
      }
      if (event.type === "notification") {
        const n = event.notification;
        const fn = n.kind === "error" ? toast.error : n.kind === "warning" || n.kind === "missing_login" ? toast.warning : n.kind === "success" ? toast.success : toast;
        fn(n.title, { description: n.body || undefined });
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
    return <SplashScreen error={cloudContext ? "Cannot reach this computer through Godmode Cloud." : "Cannot reach the Godmode core."} />;
  }
  // In cloud mode the cloud signs people in; the core's own sign-in page never shows there.
  if (!authed) return cloudContext ? <SplashScreen /> : <LoginPage hasPassword={auth.data?.hasDashboardPassword ?? false} />;
  if (!boot.data) return <SplashScreen />;

  const b = boot.data;
  if (!b.vault.initialized || !b.settings.onboardingComplete) return <OnboardingPage bootstrap={b} />;
  if (!b.vault.unlocked) return <UnlockPage />;

  return (
    <AppShell>
      <Suspense fallback={<div className="p-8" />}>
        <Routes>
          <Route path="/" element={<ChatHome />} />
          <Route path="/chat/:conversationId" element={<ChatConversation />} />
          <Route path="/archived" element={<ArchivedPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/new" element={<AgentNewPage />} />
          <Route path="/agents/:agentId/*" element={<AgentDetailPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/automations" element={<AutomationsPage />} />
          <Route path="/routines" element={<Navigate to="/automations" replace />} />
          <Route path="/mods" element={<ModsPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/workspaces" element={<WorkspacesPage />} />
          <Route path="/vault" element={<Navigate to="/vault/logins" replace />} />
          <Route path="/vault/logins" element={<LoginsPage />} />
          <Route path="/vault/2fa" element={<TotpPage />} />
          <Route path="/integrations" element={<IntegrationsPage />} />
          <Route path="/messaging" element={<MessagingPage />} />
          <Route path="/browser" element={<BrowserPage />} />
          <Route path="/computer" element={<ComputerPage />} />
          <Route path="/vms" element={<VmsPage />} />
          <Route path="/ssh" element={<SshPage />} />
          <Route path="/runners" element={<RunnersPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/settings" element={<Navigate to="/settings/general" replace />} />
          <Route path="/settings/:section" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundRedirect />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}

/** Cloud mode: the computer refuses this browser, or can't be used from here yet. */
function cloudBlock(authError: unknown, authenticated: boolean | undefined, bootError: unknown, boot: Bootstrap | undefined): CloudState | null {
  for (const err of [authError, bootError]) {
    if (err instanceof ApiRequestError && (err.code === CloudErrorCode.CloudForbidden || err.code === CloudErrorCode.DeviceNotFound)) {
      return { kind: "blocked", title: "Can't open this computer", message: err.message };
    }
  }
  if (authenticated === false) {
    return {
      kind: "blocked",
      title: "Browser access is off",
      message: "Godmode on this computer doesn't accept browser access through the cloud right now. Turn it on there under Settings → Cloud.",
    };
  }
  if (boot && (!boot.vault.initialized || !boot.settings.onboardingComplete)) {
    return {
      kind: "blocked",
      title: "Godmode isn't set up on this computer yet",
      message: "Finish the setup in Godmode on the computer itself, then open it here again.",
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
