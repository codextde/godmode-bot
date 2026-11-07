/**
 * Push notifications on paired phones (owner: mobile). What the desktop app shows as a notification goes to every phone
 * that switched notifications on, through Expo's push service (no server of Godmode's own): short, without known
 * secrets, with the in-app link the app opens on a tap and the "Needs you" count as the badge. Expo answers with a
 * ticket per phone; a phone the app is gone from (DeviceNotRegistered, then or in the receipt later) loses its token.
 */
import type { AppNotification } from "@godmode/shared";
import { get } from "../db";
import { logger } from "../log";
import { listAttention } from "../services/attention";
import { onNotificationAnnounced } from "../services/notifications";
import { getSettings } from "../services/settings";
import { truncate } from "../util";
import { maskKnownSecrets } from "../vault/vault";
import { dropPushToken, pushTargets } from "./devices";

const log = logger("push");

export const EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
/** Expo takes up to 100 messages per request and 1000 receipt ids. */
const BATCH = 100;
const RECEIPT_BATCH = 1000;
const TIMEOUT_MS = 15_000;
const RETRY_MS = 2_000;
/** Expo's advice: receipts are there after about 15 minutes (and gone after a day). */
const RECEIPT_DELAY_MS = 15 * 60_000;
const TITLE_MAX = 120;
const BODY_MAX = 240;
/** The Android channel the app creates (lib/push.ts). */
const ANDROID_CHANNEL = "default";

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data: { id: string; kind: AppNotification["kind"]; url: string | null };
  sound: "default";
  priority: "default" | "high";
  /** iOS: one notification per id, also when a retry sends it again. */
  collapseId: string;
  /** iOS: a chat's or task's notifications stack together. */
  threadId: string;
  badge?: number;
  channelId?: string;
}

interface Ticket {
  status: "ok" | "error";
  id?: string;
  details?: { error?: string };
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

let send: Fetch = (url, init) => fetch(url, init);
/** Ticket id → token, checked once the receipts are there. */
const pendingReceipts = new Map<string, string>();
let receiptTimer: ReturnType<typeof setTimeout> | null = null;
let retryWait = RETRY_MS;
let stopListening: (() => void) | null = null;

/** Tests hand in a fake fetch; null puts the real one back. */
export function setPushFetch(fn: Fetch | null, retryMs = RETRY_MS): void {
  send = fn ?? ((url, init) => fetch(url, init));
  retryWait = retryMs;
}

export function startPush(): void {
  // After the caller's own work (it may be inside a transaction): the "Needs you" count reads its result.
  stopListening ??= onNotificationAnnounced((n) => queueMicrotask(() => void pushNotification(n).catch((err) => log.warn("could not push a notification", err))));
}

export function stopPush(): void {
  stopListening?.();
  stopListening = null;
  if (receiptTimer) clearTimeout(receiptTimer);
  receiptTimer = null;
  pendingReceipts.clear();
}

/** "chat:<id>" for a chat's link, "task:<id>" for a task's: what groups and what the phone compares with its screen. */
function threadOf(link: string | null, kind: string): string {
  const chat = link && /^\/chat\/([^/?#]+)/.exec(link);
  if (chat) return `chat:${chat[1]}`;
  const task = link && /[?&]task=([^&#]+)/.exec(link);
  if (task) return `${link!.startsWith("/my-tasks") ? "todo" : "task"}:${task[1]}`;
  return kind;
}

function privateChat(link: string | null): boolean {
  const chat = link && /^\/chat\/([^/?#]+)/.exec(link);
  if (!chat) return false;
  let id = chat[1]!;
  try {
    id = decodeURIComponent(id);
  } catch {
    /* as it is */
  }
  return !!get<{ private: number }>("SELECT private FROM conversations WHERE id = ?", id)?.private;
}

function needsYouCount(): number | undefined {
  try {
    return listAttention().length;
  } catch {
    return undefined;
  }
}

/** What a phone shows for a notification: a private chat's words stay on the computer. */
export function pushText(n: AppNotification): { title: string; body: string } {
  if (privateChat(n.link)) return { title: n.kind === "question" ? "Someone in a private chat needs you" : "News in a private chat", body: "" };
  // The licence notice names ways to buy, for the desktop; a store app must not show that (the phone maps it in its inbox).
  if (n.link === "/settings/license") return { title: "Godmode on your computer needs a licence", body: "" };
  const clean = (s: string, max: number) => truncate(maskKnownSecrets(s.replace(/\s+/g, " ").trim()), max);
  return { title: clean(n.title, TITLE_MAX) || "Godmode", body: clean(n.body, BODY_MAX) };
}

export function pushMessages(n: AppNotification, targets: { platform: "ios" | "android"; token: string }[], badge = needsYouCount()): PushMessage[] {
  const { title, body } = pushText(n);
  const urgent = n.kind === "question" || n.kind === "missing_login";
  return targets.map((t) => ({
    to: t.token,
    title,
    body,
    data: { id: n.id, kind: n.kind, url: n.link },
    sound: "default",
    priority: urgent ? "high" : "default",
    collapseId: n.id,
    threadId: threadOf(n.link, n.kind),
    ...(t.platform === "ios" && badge !== undefined ? { badge } : {}),
    ...(t.platform === "android" ? { channelId: ANDROID_CHANNEL } : {}),
  }));
}

/** One POST to Expo, once more after a moment when the network or Expo had a problem (not for a refused request). */
async function post<T>(url: string, payload: unknown): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await Bun.sleep(retryWait);
    try {
      const res = await send(url, {
        method: "POST",
        headers: { accept: "application/json", "accept-encoding": "gzip, deflate", "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return ((await res.json()) as { data?: T }).data ?? null;
      const retry = res.status === 429 || res.status >= 500;
      log.warn(`Expo push answered ${res.status}${retry && !attempt ? ", trying once more" : ""}`);
      if (!retry) return null;
    } catch (err) {
      log.warn(`Expo push couldn't be reached${attempt ? "" : ", trying once more"}`, err instanceof Error ? err.message : String(err));
    }
  }
  return null;
}

function scheduleReceipts(): void {
  if (receiptTimer || !pendingReceipts.size) return;
  receiptTimer = setTimeout(() => {
    receiptTimer = null;
    void checkReceipts();
  }, RECEIPT_DELAY_MS);
  receiptTimer.unref?.();
}

/** Asks Expo how the sent notifications fared at Apple and Google; drops the tokens of phones the app is gone from. */
export async function checkReceipts(): Promise<void> {
  const ids = [...pendingReceipts.keys()];
  for (let i = 0; i < ids.length; i += RECEIPT_BATCH) {
    const chunk = ids.slice(i, i + RECEIPT_BATCH);
    const receipts = await post<Record<string, Ticket>>(EXPO_RECEIPTS_URL, { ids: chunk });
    for (const id of chunk) {
      const token = pendingReceipts.get(id);
      pendingReceipts.delete(id);
      const receipt = receipts?.[id];
      if (!token || receipt?.status !== "error") continue;
      if (receipt.details?.error === "DeviceNotRegistered") dropPushToken(token);
      // Expo's message names the token: only the error code goes to the log.
      else log.warn(`a push notification didn't arrive: ${receipt.details?.error ?? "unknown"}`);
    }
  }
}

/** Sends one notification to every phone with notifications on. Resolves when Expo answered (or gave up). */
export async function pushNotification(n: AppNotification): Promise<void> {
  if (!getSettings().mobile.enabled) return;
  const targets = pushTargets();
  if (!targets.length) return;
  const messages = pushMessages(n, targets);
  for (let i = 0; i < messages.length; i += BATCH) {
    const batch = messages.slice(i, i + BATCH);
    const tickets = await post<Ticket[]>(EXPO_SEND_URL, batch);
    if (!Array.isArray(tickets)) continue;
    tickets.forEach((ticket, j) => {
      const token = batch[j]?.to;
      if (!token || !ticket) return;
      if (ticket.status === "ok" && ticket.id) pendingReceipts.set(ticket.id, token);
      else if (ticket.status === "error") {
        if (ticket.details?.error === "DeviceNotRegistered") dropPushToken(token);
        else log.warn(`Expo refused a push notification: ${ticket.details?.error ?? "unknown"}`);
      }
    });
  }
  scheduleReceipts();
}
