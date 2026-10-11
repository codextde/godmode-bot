import { dehydrate, hydrate, type DehydratedState, type Query } from "@tanstack/react-query";
import { File, Paths } from "expo-file-system";
import { AppState } from "react-native";
import { queryClient } from "./query";

/**
 * The lists the app opens with (chats, tasks, agents, what needs you) are kept on the phone between launches, so a cold
 * start shows them at once and refreshes them behind. Chats themselves, settings and live pictures are not kept. The
 * file is in the app's cache folder: not backed up, and gone with the pairing.
 */
const KEPT = new Set(["bootstrap", "workspaces", "agents", "conversations", "tasks", "routines", "human-tasks", "questions", "missing-logins", "browser-profiles", "vms", "models"]);
const VERSION = 1;
const MAX_AGE_MS = 7 * 24 * 3600_000;
const SAVE_AFTER_MS = 3000;

const file = () => new File(Paths.cache, "godmode-lists.json");

function kept(query: Query): boolean {
  const [scope, kind, search] = query.queryKey as unknown[];
  if (query.state.status !== "success" || !KEPT.has(String(scope))) return false;
  if (kind === "detail" || kind === "events") return false;
  return !(scope === "conversations" && kind === "list" && search);
}

/** Before the first screen: what the last session saw, when it was this pairing's. */
export async function restoreQueries(deviceId: string): Promise<void> {
  try {
    const saved = file();
    if (!saved.exists) return;
    const { v, device, at, state } = JSON.parse(await saved.text()) as { v: number; device: string; at: number; state: DehydratedState };
    if (v !== VERSION || device !== deviceId || Date.now() - at > MAX_AGE_MS) return saved.delete();
    hydrate(queryClient, state);
  } catch {
    forgetQueries();
  }
}

/** Saves the lists a moment after they change, and when the app leaves the screen. */
export function persistQueries(deviceId: string): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      file().write(JSON.stringify({ v: VERSION, device: deviceId, at: Date.now(), state: dehydrate(queryClient, { shouldDehydrateQuery: kept }) }));
    } catch {
      /* the next change tries again */
    }
  };
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success" || !kept(event.query)) return;
    timer ??= setTimeout(save, SAVE_AFTER_MS);
  });
  const app = AppState.addEventListener("change", (state) => {
    if (state !== "active" && timer) save();
  });
  return () => {
    unsubscribe();
    app.remove();
    if (timer) clearTimeout(timer);
  };
}

export function forgetQueries() {
  try {
    const saved = file();
    if (saved.exists) saved.delete();
  } catch {
    /* nothing to forget */
  }
}
