import type {
  AndroidStatus,
  ClaudeAccount,
  ClaudeAccountLogin,
  ClaudeLoginStatus,
  DependencyId,
  FixReport,
  FixResult,
  HexStatus,
  PermissionId,
  SelfRepairInput,
  SelfRepairResult,
  ToolId,
  ToolUpdateResult,
  UpdateReport,
  VmStatus,
} from "@godmode/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Alert } from "react-native";
import { errorText, request } from "./api";
import { t } from "./i18n";
import { queryClient } from "./query";

/** Installs and updates download and build: give them as long as the desktop does. */
const LONG = 600_000;

const get = <T>(path: string, minTimeoutMs = 0) => request<T>("GET", path, undefined, minTimeoutMs);
const post = <T>(path: string, body: unknown = {}, minTimeoutMs = 0) => request<T>("POST", path, body, minTimeoutMs);
const del = <T>(path: string) => request<T>("DELETE", path);

export type InstallResult = { ok: boolean; output: string };

/**
 * What a full-access phone does to the programs on the computer, like the desktop app: installs, updates, repairs,
 * Claude Code sign-ins and the log. A limited phone is refused all of it (403 `device_forbidden`).
 */
export const programsApi = {
  doctor: {
    install: (id: DependencyId) => post<InstallResult>("/api/doctor/install", { id }, LONG),
    fixAll: () => post<FixReport>("/api/doctor/fix", {}, LONG),
    fixPermission: (id: PermissionId) => post<FixResult>("/api/doctor/permissions/fix", { id }, LONG),
    updates: (refresh = false) => get<UpdateReport>(`/api/doctor/updates${refresh ? "?refresh=1" : ""}`, refresh ? 120_000 : 0),
    /** One tool, or every tool that has an update. */
    update: (id?: ToolId) => post<ToolUpdateResult[]>("/api/doctor/updates", id ? { id } : {}, LONG),
    login: () => get<ClaudeLoginStatus>("/api/doctor/claude-login"),
    startLogin: () => post<ClaudeLoginStatus>("/api/doctor/claude-login"),
    submitLoginCode: (code: string) => post<ClaudeLoginStatus>("/api/doctor/claude-login/code", { code }, 30_000),
    cancelLogin: () => del<ClaudeLoginStatus>("/api/doctor/claude-login"),
  },

  accounts: {
    /** `accountId`: sign that account in again; null adds another one. */
    startLogin: (accountId: string | null) => post<ClaudeAccountLogin>("/api/claude-accounts/login", { accountId }),
    submitCode: (code: string) => post<ClaudeAccountLogin>("/api/claude-accounts/login/code", { code }, 30_000),
    cancelLogin: () => del<ClaudeAccountLogin>("/api/claude-accounts/login"),
    remove: (id: string) => del<ClaudeAccount[]>(`/api/claude-accounts/${encodeURIComponent(id)}`),
  },

  hex: {
    status: () => get<HexStatus>("/api/voice/hex"),
    /** Starts the download (and the app's install where it can); the status shows the progress. */
    prepare: (language?: string) => post<HexStatus>("/api/voice/hex/prepare", { language }),
  },

  installCua: () => post<InstallResult>("/api/computer/cua/install", {}, LONG),
  vmStatus: () => get<VmStatus>("/api/vms/status"),
  installVmTools: () => post<InstallResult>("/api/vms/install", {}, LONG),
  androidStatus: () => get<AndroidStatus>("/api/android/status"),
  installAndroidTools: () => post<InstallResult>("/api/android/install", {}, LONG),

  logs: {
    /** Markdown of the log for an AI to read; `full` has every entry. */
    report: (full = false) => get<string>(`/api/logs/report${full ? "?full=1" : ""}`, 60_000),
    clear: () => del<{ ok: true }>("/api/logs"),
    fix: (input: SelfRepairInput) => post<SelfRepairResult>("/api/logs/fix", input, 60_000),
  },
};

/** Query keys of these screens (the doctor's own keys live in settings-api's `sq`). */
export const pk = {
  updates: ["doctor", "updates"],
  claudeLogin: ["doctor", "claude-login"],
  hex: ["voice", "hex"],
  vmStatus: ["vms", "status"],
  androidStatus: ["android", "status"],
} as const;

/** The last lines of an install's output: what went wrong, without the whole log. */
export function lastLines(output: string, count = 4): string {
  return output
    .split("\n")
    .filter((l) => l.trim())
    .slice(-count)
    .join("\n");
}

/**
 * Claude Code's own sign-in on the computer, from the phone: started here, the code from the sign-in page goes back
 * here; `onSignedIn` runs once it went through.
 */
export function useClaudeLogin(enabled: boolean, onSignedIn: () => void) {
  const status = useQuery({
    queryKey: pk.claudeLogin,
    queryFn: programsApi.doctor.login,
    enabled,
    refetchInterval: (q) => (q.state.data?.state === "waiting" ? 1500 : false),
  });
  const set = (next: ClaudeLoginStatus) =>
    queryClient.setQueryData<ClaudeLoginStatus>(pk.claudeLogin, (old) => (old?.state === "waiting" && next.state === "waiting" && old.url && !next.url ? { ...next, url: old.url } : next));
  const start = useMutation({
    mutationFn: programsApi.doctor.startLogin,
    onSuccess: set,
    onError: (err) => Alert.alert(t("programs:signIn.startFailed"), errorText(err)),
  });
  const cancel = useMutation({ mutationFn: programsApi.doctor.cancelLogin, onSuccess: set });
  const submit = useMutation({ mutationFn: programsApi.doctor.submitLoginCode, onSuccess: set });
  const send = (code: string) =>
    submit.mutateAsync(code).then(
      () => true,
      (err: unknown) => {
        Alert.alert(t("programs:signIn.codeFailed"), errorText(err));
        return false;
      },
    );

  const state = status.data?.state ?? "idle";
  const prev = useRef(state);
  const message = status.data?.message;
  useEffect(() => {
    if (prev.current === "waiting" && state === "done") onSignedIn();
    if (prev.current === "waiting" && state === "failed") Alert.alert(t("programs:signIn.failed"), message ?? undefined);
    prev.current = state;
  }, [state, message, onSignedIn]);

  return { status: status.data, waiting: state === "waiting", start, cancel, submit, send };
}
