import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, setUnauthorizedHandler } from "@/lib/api";
import { getCoreInfo, isTauri } from "@/lib/core";
import { qk } from "@/lib/queryKeys";
import { startRealtime, onServerEvent } from "@/lib/realtime";
import { notifyDesktop } from "@/lib/desktop";
import { syncUpdater } from "@/stores/updater";
import { AppShell } from "@/components/layout/app-shell";
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
const RoutinesPage = lazy(() => import("@/pages/routines/routines-page"));
const ActivityPage = lazy(() => import("@/pages/activity/activity-page"));
const WorkspacesPage = lazy(() => import("@/pages/workspaces/workspaces-page"));
const LoginsPage = lazy(() => import("@/pages/vault/logins-page"));
const TotpPage = lazy(() => import("@/pages/vault/totp-page"));
const IntegrationsPage = lazy(() => import("@/pages/integrations/integrations-page"));
const BrowserPage = lazy(() => import("@/pages/browser/browser-page"));
const ComputerPage = lazy(() => import("@/pages/computer/computer-page"));
const InboxPage = lazy(() => import("@/pages/inbox/inbox-page"));
const SettingsPage = lazy(() => import("@/pages/settings/settings-page"));

export function App() {
  const qc = useQueryClient();
  const [coreReady, setCoreReady] = useState(false);
  const [coreError, setCoreError] = useState<string | null>(null);

  useEffect(() => {
    getCoreInfo()
      .then(() => setCoreReady(true))
      .catch((e) => setCoreError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => syncUpdater(), []);

  useEffect(() => {
    setUnauthorizedHandler(() => qc.invalidateQueries({ queryKey: qk.authStatus }));
  }, [qc]);

  const auth = useQuery({ queryKey: qk.authStatus, queryFn: api.auth.status, enabled: coreReady, retry: 30, retryDelay: 500 });
  const authed = auth.data?.authenticated ?? false;
  const boot = useQuery({ queryKey: qk.bootstrap, queryFn: api.bootstrap, enabled: authed, staleTime: 5_000 });

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
      if (event.type === "notification") {
        const n = event.notification;
        const fn = n.kind === "error" ? toast.error : n.kind === "warning" || n.kind === "missing_login" ? toast.warning : n.kind === "success" ? toast.success : toast;
        fn(n.title, { description: n.body || undefined });
        const desktopOn = qc.getQueryData<{ settings?: { general?: { desktopNotifications?: boolean } } }>(qk.bootstrap)?.settings?.general
          ?.desktopNotifications;
        if (desktopOn !== false && !document.hasFocus()) void notifyDesktop(n.title, n.body);
      }
    });
  }, [authed, qc]);

  if (coreError) return <SplashScreen error={coreError} />;
  if (!coreReady || auth.isLoading) return <SplashScreen />;
  if (auth.isError) return <SplashScreen error="Cannot reach the Godmode core." />;
  if (!authed) return <LoginPage hasPassword={auth.data?.hasDashboardPassword ?? false} />;
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
          <Route path="/routines" element={<RoutinesPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/workspaces" element={<WorkspacesPage />} />
          <Route path="/vault" element={<Navigate to="/vault/logins" replace />} />
          <Route path="/vault/logins" element={<LoginsPage />} />
          <Route path="/vault/2fa" element={<TotpPage />} />
          <Route path="/integrations" element={<IntegrationsPage />} />
          <Route path="/browser" element={<BrowserPage />} />
          <Route path="/computer" element={<ComputerPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/settings" element={<Navigate to="/settings/general" replace />} />
          <Route path="/settings/:section" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundRedirect />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}

function NotFoundRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate("/", { replace: true });
  }, [navigate]);
  return null;
}
