import { mock } from "bun:test";

type Button = { text: string; style?: string };
type Status = { didJustFinish: boolean; error?: string | null };

/** The native side of the phone for `bun test`, and what the code under test did to it. Mocks reach all test files, so they share this one. */
export const phone = {
  alerts: [] as { title: string; message?: string; buttons?: Button[] }[],
  sheets: [] as { message?: string; options: string[] }[],
  awake: [] as string[],
  silentMode: [] as boolean[],
  spoken: [] as string[],
  played: 0,
  onStatus: (_status: Status) => {},
  stored: {} as Record<string, string>,
  reset() {
    phone.alerts.length = 0;
    phone.sheets.length = 0;
    phone.awake.length = 0;
    phone.silentMode.length = 0;
    phone.spoken.length = 0;
    phone.played = 0;
  },
};

class FakeEntry {
  exists = false;
  uri = "file:///cache";
  size = 0;
  create() {
    this.exists = true;
  }
  write() {}
  delete() {
    this.exists = false;
  }
}

mock.module("expo", () => ({ requireOptionalNativeModule: () => ({}) }));
mock.module("expo-audio", () => ({
  setAudioModeAsync: async ({ playsInSilentMode }: { playsInSilentMode: boolean }) => void phone.silentMode.push(playsInSilentMode),
  createAudioPlayer: () => ({
    addListener: (_event: string, listener: (status: Status) => void) => {
      phone.onStatus = listener;
    },
    play: () => {
      phone.played++;
    },
    remove: () => undefined,
    pause: () => undefined,
  }),
}));
mock.module("expo-constants", () => ({ default: { expoConfig: { version: "1" } } }));
mock.module("expo-device", () => ({ modelName: "iPhone", deviceName: "iPhone" }));
mock.module("expo-file-system", () => ({ File: FakeEntry, Directory: FakeEntry, Paths: { cache: "cache" } }));
mock.module("expo-haptics", () => ({ notificationAsync: async () => undefined, NotificationFeedbackType: { Success: "success" } }));
mock.module("expo-keep-awake", () => ({
  activateKeepAwakeAsync: async (tag: string) => void phone.awake.push(`on ${tag}`),
  deactivateKeepAwake: async (tag: string) => void phone.awake.push(`off ${tag}`),
}));
mock.module("expo-localization", () => ({ getCalendars: () => [], getLocales: () => [] }));
mock.module("expo-router", () => ({ router: { push: () => undefined, replace: () => undefined, back: () => undefined } }));
mock.module("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => phone.stored[key] ?? null,
  setItemAsync: async (key: string, value: string) => void (phone.stored[key] = value),
  deleteItemAsync: async (key: string) => void delete phone.stored[key],
}));
mock.module("expo-speech", () => ({
  VoiceQuality: { Enhanced: "Enhanced" },
  maxSpeechInputLength: 4000,
  getAvailableVoicesAsync: async () => [],
  stop: () => undefined,
  speak: (text: string, options: { onDone?: () => void }) => {
    phone.spoken.push(text);
    options.onDone?.();
  },
}));
mock.module("react-native", () => ({
  ActionSheetIOS: { showActionSheetWithOptions: (options: { message?: string; options: string[] }) => void phone.sheets.push(options) },
  Alert: { alert: (title: string, message?: string, buttons?: Button[]) => void phone.alerts.push({ title, message, buttons }) },
  Share: { share: async () => ({ action: "sharedAction" }) },
}));
