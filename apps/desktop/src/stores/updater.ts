import { create } from "zustand";
import { isTauri } from "@/lib/core";

/** Mirrors `UpdateState` in `src-tauri/src/updater.rs`. */
export type UpdateState =
  | { status: "disabled" | "idle" | "checking" }
  | { status: "upToDate"; checkedAt: number }
  | { status: "downloading"; version: string; downloaded: number; total: number | null }
  | { status: "ready"; version: string; notes: string | null }
  | { status: "installing"; version: string }
  | { status: "error"; message: string };

export const useUpdater = create<{ update: UpdateState }>(() => ({ update: { status: "disabled" } }));

const set = (update: UpdateState) => useUpdater.setState({ update });

/** Desktop only: follows the shell's background updater. */
export function syncUpdater() {
  if (!isTauri) return () => {};
  let stop: (() => void) | undefined;
  let cancelled = false;
  void (async () => {
    const [{ invoke }, { listen }] = await Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]);
    let heard = false;
    const unlisten = await listen<UpdateState>("update-state", (e) => {
      heard = true;
      set(e.payload);
    });
    if (cancelled) return unlisten();
    stop = unlisten;
    const snapshot = await invoke<UpdateState>("update_state");
    if (!heard) set(snapshot);
  })().catch(() => {});
  return () => {
    cancelled = true;
    stop?.();
  };
}

export async function checkForUpdates() {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("check_for_updates");
}

export async function installUpdate() {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("install_update");
}
