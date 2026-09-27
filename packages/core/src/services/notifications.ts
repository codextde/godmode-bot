import type { AppNotification, NotificationKind } from "@godmode/shared";
import { all, bool, get, insert, run } from "../db";
import { bus } from "../events/bus";
import { newId, now } from "../util";

interface NotificationRow {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string | null;
  read: number;
  created_at: string;
}

function toModel(r: NotificationRow): AppNotification {
  return { id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, read: bool(r.read), createdAt: r.created_at };
}

export function notify(kind: NotificationKind, title: string, body = "", link: string | null = null): AppNotification {
  const row: NotificationRow = { id: newId("ntf"), kind, title, body, link, read: 0, created_at: now() };
  insert("notifications", { ...row });
  const n = toModel(row);
  bus.emit({ type: "notification", notification: n });
  return n;
}

export function listNotifications(limit = 100): AppNotification[] {
  return all<NotificationRow>("SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?", limit).map(toModel);
}

export function markRead(ids: string[] | "all") {
  if (ids === "all") run("UPDATE notifications SET read = 1");
  else for (const id of ids) run("UPDATE notifications SET read = 1 WHERE id = ?", id);
  bus.changed("notifications");
}

export function clearNotifications() {
  run("DELETE FROM notifications");
  bus.changed("notifications");
}

export function unreadCount(): number {
  return get<{ c: number }>("SELECT COUNT(*) AS c FROM notifications WHERE read = 0")?.c ?? 0;
}
