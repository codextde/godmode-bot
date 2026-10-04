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
    if (Notification.permission === "granted") new Notification(title, { body, icon: `${import.meta.env.BASE_URL}logo.svg` });
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

/**
 * Links that leave the app open in the default browser. The desktop webview can't follow them, and the shell plugin's
 * own handler for `target="_blank"` links only cancels the click: the webview has no shell access.
 */
export function installExternalLinks() {
  if (!isTauri) return;
  document.addEventListener(
    "click",
    (e) => {
      const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!a || a.isContentEditable || a.hasAttribute("download")) return;
      const external = a.protocol === "mailto:" || (/^https?:$/.test(a.protocol) && a.origin !== location.origin);
      if (!external && a.target !== "_blank") return;
      e.preventDefault();
      // Without its target the shell plugin leaves the link alone.
      a.removeAttribute("target");
      if (external) void openExternal(a.href);
    },
    true,
  );
}

/**
 * Whatever is dropped where nothing takes it would be opened by the webview (or the browser tab) in place of the app:
 * a file, or a link dragged over from a browser. Drop zones take theirs first, text and links still go into fields,
 * the rest is refused.
 */
export function installDropGuard() {
  const refuse = (e: DragEvent) => {
    if (e.defaultPrevented || !e.dataTransfer) return;
    const el = e.target instanceof Element ? e.target : null;
    const input = el instanceof HTMLInputElement ? el.type : "";
    // Date and time inputs count as writable, but take no dropped text.
    const taken = e.dataTransfer.types.includes("Files") ? input === "file" : !!el?.matches(":read-write") && !/^(date|datetime-local|month|week|time)$/.test(input);
    if (taken) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "none";
  };
  // On window: listeners on the document (a dialog that takes drops anywhere) come first.
  window.addEventListener("dragover", refuse);
  window.addEventListener("drop", refuse);
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
