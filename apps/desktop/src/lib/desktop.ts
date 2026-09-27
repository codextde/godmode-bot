import { isTauri } from "./core";

/** Show a native notification (Tauri) or a Web Notification (browser dashboard). */
export async function notifyDesktop(title: string, body?: string) {
  try {
    if (isTauri) {
      const n = await import("@tauri-apps/plugin-notification");
      let granted = await n.isPermissionGranted();
      if (!granted) granted = (await n.requestPermission()) === "granted";
      if (granted) n.sendNotification({ title, body });
      return;
    }
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") await Notification.requestPermission();
    if (Notification.permission === "granted") new Notification(title, { body, icon: "/logo.svg" });
  } catch {
    /* ignore */
  }
}

/** Open a URL in the user's default browser. */
export async function openExternal(url: string) {
  if (isTauri) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/** Save a blob to disk (native dialog in Tauri, download in browser). */
export async function saveBlob(blob: Blob, filename: string) {
  if (isTauri) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { invoke } = await import("@tauri-apps/api/core");
      const path = await save({ defaultPath: filename });
      if (!path) return false;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await invoke("write_file", { path, data: Array.from(bytes) });
      return true;
    } catch {
      /* fall back to download */
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
  return true;
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const modKey = isMac ? "⌘" : "Ctrl";
