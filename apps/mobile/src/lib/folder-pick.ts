import { router } from "expo-router";

/** What the folder sheet was opened for; route params can't carry the answer back. */
export interface FolderRequest {
  title: string;
  action: string;
  /** An SSH server's folders; else the computer's. */
  serverId?: string;
  start?: string;
}

let current: { request: FolderRequest; settle: (path: string | null) => void } | null = null;

export const folderRequest = () => current?.request ?? null;

/** `request`: only while that is the open one. A sheet leaves after the next one opened, and has nothing to say about it. */
export function settleFolder(path: string | null, request?: FolderRequest | null) {
  if (request !== undefined && current?.request !== request) return;
  const open = current;
  current = null;
  open?.settle(path);
}

/** Opens the folder sheet; resolves with the folder taken, or null when it was closed. */
export function pickFolder(request: FolderRequest): Promise<string | null> {
  settleFolder(null);
  return new Promise((resolve) => {
    current = { request, settle: resolve };
    router.push("/folder-browse");
  });
}
