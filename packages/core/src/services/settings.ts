import type { Settings } from "@godmode/shared";
import { DEFAULT_AUTO_COMPACT_PERCENT, DEFAULT_CLOUD_SETTINGS, DEFAULT_FALLBACK_MODEL, DEFAULT_LOOP_REPEATS, DEFAULT_MEMORY_CHARS, DEFAULT_MODEL, DEFAULT_PORT, DEFAULT_STALL_MINUTES, MOBILE_DEFAULT_PORT } from "@godmode/shared";
import { all, run } from "../db";
import { bus } from "../events/bus";
import { parseJson } from "../util";

export const DEFAULT_SETTINGS: Settings = {
  general: {
    theme: "light",
    mode: "pro",
    accent: "violet",
    userName: "",
    launchAtLogin: false,
    minimizeToTray: true,
    desktopNotifications: true,
    language: "en",
  },
  runner: {
    claudePath: "",
    model: DEFAULT_MODEL,
    fallbackModel: DEFAULT_FALLBACK_MODEL,
    effort: "high",
    ultracode: false,
    bypassPermissions: true,
    maxConcurrentRuns: 3,
    runTimeoutMinutes: 60,
    autoContinueOnLimit: true,
    resumeAfterRestart: true,
    watchdog: true,
    stallMinutes: DEFAULT_STALL_MINUTES,
    loopRepeats: DEFAULT_LOOP_REPEATS,
    autoCompactPercent: DEFAULT_AUTO_COMPACT_PERCENT,
    spendTracking: false,
    defaultMaxBudgetUsd: null,
    monthlyBudgetUsd: null,
    extraArgs: [],
    appendSystemPrompt: "",
  },
  browser: {
    enabled: true,
    chromePath: "",
    headless: false,
    browserUseCommand: "",
    keepAliveMinutes: 5,
    liveView: true,
    stealth: true,
    muteAudio: true,
    passkeys: true,
    captchaSolver: "off",
    captchaDailyLimit: 30,
  },
  computer: {
    enabled: true,
    useCuaDriver: true,
    cuaDriverCommand: "",
    allowForeground: false,
    agentCursor: true,
    liveView: true,
    liveViewFps: 4,
    screenshotMaxSize: 1280,
  },
  vm: {
    enabled: true,
    isolateHostShell: true,
    vaultFill: false,
    onQuit: "suspend",
    idleStopMinutes: 0,
    tartPath: "",
  },
  android: {
    enabled: false,
    vaultFill: false,
    adbPath: "",
  },
  artifacts: { enabled: false },
  integrations: { enabled: false },
  messaging: { enabled: false },
  voice: {
    enabled: true,
    sttProvider: "browser",
    ttsProvider: "browser",
    autoSpeak: true,
    language: "en-US",
    openaiBaseUrl: "https://api.openai.com/v1",
    sttModel: "gpt-4o-mini-transcribe",
    ttsModel: "gpt-4o-mini-tts",
    ttsVoice: "alloy",
    elevenlabsVoiceId: "21m00Tcm4TlvDq8ikWAM",
    browserVoice: "",
    rate: 1,
  },
  phone: {
    enabled: false,
    numberId: "",
    ownerNumber: "",
    callOwner: true,
    quietFrom: "22:00",
    quietTo: "07:30",
    voiceId: "",
    llm: "claude-opus-5-5",
    language: "en",
    maxMinutes: 10,
    answerInbound: false,
    inboundAgentId: "",
    inboundGreeting: "",
    inboundInstructions: "",
  },
  security: {
    autoLockMinutes: 0,
    defaultSecretAccess: "fill",
    redactSecrets: true,
    fetchSiteIcons: true,
    auditRetentionDays: 180,
  },
  server: {
    host: "127.0.0.1",
    port: DEFAULT_PORT,
    remoteAccess: false,
    hasDashboardPassword: false,
    allowedOrigins: [],
  },
  memory: {
    backend: "files",
    autoCommit: true,
    reflectAfterRun: true,
    injectMemory: true,
    dreaming: {
      enabled: true,
      cron: "0 3 * * *",
      model: DEFAULT_MODEL,
      maxMemoryChars: DEFAULT_MEMORY_CHARS,
      minNewExchanges: 3,
      refreshDays: 7,
      tidyWorkspace: true,
      offers: true,
    },
  },
  diagnostics: {
    verbose: false,
  },
  maintenance: {
    autoFix: true,
    autoUpdate: true,
    autoCleanup: true,
  },
  selfRepair: {
    repoUrl: "",
    baseBranch: "main",
    agentId: null,
    autoMerge: true,
  },
  mobile: {
    enabled: false,
    port: MOBILE_DEFAULT_PORT,
  },
  power: {
    lidClosedAwake: false,
    onlyWhileWorking: false,
    minBattery: 20,
  },
  cloud: { ...DEFAULT_CLOUD_SETTINGS },
  onboardingComplete: false,
};

type Section = keyof Settings;

let cache: Settings | null = null;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function merge<T>(base: T, patch: unknown): T {
  if (!isObject(base) || !isObject(patch)) return (patch === undefined ? base : (patch as T));
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isObject(out[k]) && isObject(v) ? merge(out[k], v) : v;
  }
  return out as T;
}

export function getSettings(): Settings {
  if (cache) return cache;
  const rows = all<{ key: string; value: string }>("SELECT key, value FROM settings");
  let s: Settings = structuredClone(DEFAULT_SETTINGS);
  for (const row of rows) {
    const key = row.key as Section;
    if (!(key in s)) continue;
    s = { ...s, [key]: merge(s[key], parseJson(row.value, undefined)) };
  }
  cache = s;
  return s;
}

/** Deep-merge a partial settings patch and persist changed sections. */
export function updateSettings(patch: DeepPartial<Settings>): Settings {
  const current = getSettings();
  const next = merge(current, patch);
  for (const key of Object.keys(patch) as Section[]) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(next[key]),
    );
  }
  cache = next;
  bus.changed("settings");
  return next;
}

export function resetSettingsCache() {
  cache = null;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };
