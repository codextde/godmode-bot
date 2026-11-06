import type { MobileSession } from "@godmode/shared";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { AndroidImportance } from "expo-notifications";
import { router } from "expo-router";
import { openNotificationLink } from "@/components/notification-row";
import { api } from "./api";
import { t } from "./i18n";
import { qk, queryClient } from "./query";

/** The Android channel the computer sends to (core mobile/push.ts). */
const CHANNEL = "default";
const platform = process.env.EXPO_OS === "android" ? "android" : "ios";

export type PushPermission = "granted" | "denied" | "undetermined";

/** The screen a notification belongs to, as the app's own path ("/chat/…", "/task/…"), or null. */
export function screenOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const [path = "", query = ""] = url.split("?");
  const chat = /^\/chat\/([^/]+)$/.exec(path);
  if (chat) return `/chat/${chat[1]}`;
  const task = /(?:^|&)task=([^&]+)/.exec(query)?.[1];
  if (task && path === "/tasks") return `/task/${task}`;
  if (task && path === "/my-tasks") return `/human-task/${task}`;
  return null;
}

/** What is on screen (set by PushBridge): a notification for it shows no banner while the app is in front. */
let onScreen: string | null = null;
export function setOnScreen(path: string | null) {
  onScreen = path;
}

Notifications.setNotificationHandler({
  handleNotification: async (n) => {
    const here = !!onScreen && screenOf(n.request.content.data?.url) === onScreen;
    return { shouldShowBanner: !here, shouldShowList: !here, shouldPlaySound: !here, shouldSetBadge: true };
  },
});

async function ensureChannel() {
  if (platform !== "android") return;
  await Notifications.setNotificationChannelAsync(CHANNEL, {
    name: t("settings:notifications.title"),
    importance: AndroidImportance.HIGH,
  });
}

export async function pushPermission(): Promise<PushPermission> {
  const { status } = await Notifications.getPermissionsAsync();
  return status === "granted" ? "granted" : status === "denied" ? "denied" : "undetermined";
}

/** This phone's Expo push token; asks for permission first when `ask` (only after the user turned notifications on). */
async function pushToken(ask: boolean): Promise<string | PushPermission> {
  await ensureChannel();
  let current = await Notifications.getPermissionsAsync();
  if (current.status !== "granted" && ask && current.canAskAgain) current = await Notifications.requestPermissionsAsync();
  if (current.status !== "granted") return current.status === "denied" || !current.canAskAgain ? "denied" : "undetermined";
  const projectId = (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId;
  // A simulator only ever gets Apple's sandbox tokens; a phone's build says which service it uses.
  return (await Notifications.getExpoPushTokenAsync({ projectId, ...(Device.isDevice ? {} : { development: true }) })).data;
}

const isToken = (v: string) => v.includes("PushToken[");

function remember(session: MobileSession) {
  queryClient.setQueryData(qk.me, session);
}

/** Turns notifications on: permission, token, and the computer stores it. "denied" when iOS or Android says no. */
export async function enablePush(): Promise<"on" | "denied"> {
  const token = await pushToken(true);
  if (!isToken(token)) return "denied";
  remember(await api.push.on(token, platform));
  return "on";
}

export async function disablePush(): Promise<void> {
  remember(await api.push.off());
  await Notifications.setBadgeCountAsync(0).catch(() => undefined);
}

/** On every start with notifications on: the token again (it can change), or off when the permission was taken back. */
export async function refreshPush(): Promise<void> {
  const token = await pushToken(false);
  if (isToken(token)) remember(await api.push.on(token, platform));
  else await disablePush();
}

/** After unpairing: no badge, nothing left in the notification list, and Apple stops delivering to the old pairing. */
export async function forgetPush(): Promise<void> {
  await Promise.all([Notifications.setBadgeCountAsync(0), Notifications.dismissAllNotificationsAsync()]).catch(() => undefined);
  if ((await pushPermission().catch(() => "undetermined")) === "granted") await Notifications.unregisterForNotificationsAsync().catch(() => undefined);
}

export async function setBadge(count: number): Promise<void> {
  await Notifications.setBadgeCountAsync(count).catch(() => undefined);
}

/** Notifications already in the list for the screen that just opened: read now. */
export async function dismissFor(path: string): Promise<void> {
  const shown = await Notifications.getPresentedNotificationsAsync().catch(() => []);
  for (const n of shown) {
    if (screenOf(n.request.content.data?.url) === path) await Notifications.dismissNotificationAsync(n.request.identifier).catch(() => undefined);
  }
}

const opened = new Set<string>();

/** A tap on a notification: its screen, or the inbox when the phone has none for it. */
export function openFromNotification(response: Notifications.NotificationResponse | null): void {
  if (!response) return;
  const id = response.notification.request.identifier;
  if (opened.has(id)) return;
  opened.add(id);
  const data = response.notification.request.content.data ?? {};
  const url = typeof data.url === "string" ? data.url : null;
  if (!openNotificationLink(url)) router.push("/inbox");
  if (typeof data.id === "string") void api.notifications.read([data.id]).catch(() => undefined);
  Notifications.clearLastNotificationResponse();
}
