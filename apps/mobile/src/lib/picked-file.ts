import * as DocumentPicker from "expo-document-picker";
import { Directory, File, Paths } from "expo-file-system";

/** The picked file is bigger than the screen takes. */
export class FileTooBig extends Error {
  constructor() {
    super("File too big");
    this.name = "FileTooBig";
  }
}

function remove(entry: File | Directory) {
  try {
    if (entry.exists) entry.delete();
  } catch {
    // Already gone.
  }
}

/**
 * Picks one file that holds secrets (a password export, a private key) and reads it into memory with `read`. The copies
 * the system and the picker leave on the phone are deleted right away. Null when the human cancels.
 */
export async function pickSecretFile<T>(maxBytes: number, read: (file: File) => Promise<T>): Promise<{ name: string; mime: string; data: T } | null> {
  // iOS hands over a copy of its own (tmp/…-Inbox): a second one in the cache would be left behind.
  const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: process.env.EXPO_OS !== "ios", multiple: false, type: "*/*" });
  if (result.canceled || !result.assets[0]) return null;
  const asset = result.assets[0];
  const file = new File(asset.uri);
  try {
    if ((asset.size ?? file.size ?? 0) > maxBytes) throw new FileTooBig();
    return { name: asset.name, mime: asset.mimeType ?? "application/octet-stream", data: await read(file) };
  } finally {
    remove(file);
  }
}

/** Copies an earlier pick left in iOS's tmp/…-Inbox (the app was closed before it was read) go too. */
export function clearPickerLeftovers() {
  if (process.env.EXPO_OS !== "ios") return;
  try {
    const tmp = new Directory(Paths.cache.uri.replace(/Library\/Caches\/?$/, "tmp/"));
    if (!tmp.exists) return;
    for (const entry of tmp.list()) if (entry instanceof Directory && /-Inbox\/?$/.test(entry.uri)) remove(entry);
  } catch {
    // Nothing to clear.
  }
}
