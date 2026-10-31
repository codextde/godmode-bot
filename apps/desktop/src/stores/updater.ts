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

export const useUpdater = create<{ update: UpdateState; canary: boolean }>(() => ({ update: { status: "disabled" }, canary: false }));

const set = (update: UpdateState) => useUpdater.setState({ update });

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
    const [snapshot, canary] = await Promise.all([invoke<UpdateState>("update_state"), invoke<boolean>("canary_updates")]);
    useUpdater.setState({ canary });
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

export async function setCanaryUpdates(enabled: boolean) {
  const { invoke } = await import("@tauri-apps/api/core");
  useUpdater.setState({ canary: enabled });
  try {
    await invoke("set_canary_updates", { enabled });
  } catch (err) {
    useUpdater.setState({ canary: !enabled });
    throw err;
  }
}
