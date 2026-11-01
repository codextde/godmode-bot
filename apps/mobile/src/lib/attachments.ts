import { CameraView } from "expo-camera";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { ActionSheetIOS, Alert, Linking } from "react-native";
import { MAX_TASK_ATTACHMENT_BYTES, type SendMessageInput } from "@godmode/shared";
import { intlLocale, t } from "./i18n";
import type { PastedFile } from "../../modules/paste-input";

/** A file picked on the phone, not sent yet. */
export interface PendingFile {
  id: string;
  uri: string;
  name: string;
  mime: string;
  size: number;
}

export type UploadFile = NonNullable<SendMessageInput["attachments"]>[number];

export const MAX_FILES = 10;
export const MAX_FILE_BYTES = MAX_TASK_ATTACHMENT_BYTES;
// The phones' listener takes 64 MB a request, and base64 makes files a third larger.
export const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
};

function mimeOf(name: string, given?: string | null): string {
  if (given && given !== "application/octet-stream") return given;
  return MIME_BY_EXT[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

function nameFrom(uri: string, fallback: string): string {
  const last = decodeURIComponent(uri.split("/").pop() ?? "");
  return last.includes(".") ? last : fallback;
}

let counter = 0;
const nextId = () => `f${Date.now().toString(36)}${(counter++).toString(36)}`;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toLocaleString(intlLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false })} MB`;
}

export const isImage = (mime: string) => mime.startsWith("image/");

/** Keeps what fits next to the files already there and says what was left out. */
export function addFiles(current: PendingFile[], picked: PendingFile[]): PendingFile[] {
  const out = [...current];
  let total = current.reduce((sum, f) => sum + f.size, 0);
  const skipped: string[] = [];
  for (const f of picked) {
    if (out.length >= MAX_FILES) skipped.push(t("system:attachments.tooMany", { name: f.name, max: MAX_FILES }));
    else if (f.size > MAX_FILE_BYTES) skipped.push(t("system:attachments.tooLarge", { name: f.name, size: formatBytes(MAX_FILE_BYTES) }));
    else if (total + f.size > MAX_TOTAL_BYTES) skipped.push(t("system:attachments.tooMuch", { name: f.name, size: formatBytes(MAX_TOTAL_BYTES) }));
    else {
      out.push(f);
      total += f.size;
    }
  }
  if (skipped.length) Alert.alert(t("system:attachments.leftOut", { count: skipped.length }), skipped.join("\n"));
  return out;
}

function sizeOf(uri: string, given?: number | null): number {
  if (given) return given;
  try {
    return new File(uri).size ?? 0;
  } catch {
    return 0;
  }
}

function fromImage(asset: ImagePicker.ImagePickerAsset): PendingFile {
  const fallback = `${asset.type === "video" ? "video" : "photo"}-${Date.now()}.${asset.type === "video" ? "mp4" : "jpg"}`;
  const name = asset.fileName || nameFrom(asset.uri, fallback);
  return { id: nextId(), uri: asset.uri, name, mime: mimeOf(name, asset.mimeType), size: sizeOf(asset.uri, asset.fileSize) };
}

const IMAGE_OPTIONS: ImagePicker.ImagePickerOptions = {
  quality: 0.85,
  // HEIC photos arrive as JPEG, which the agent can look at.
  preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
};

async function fromLibrary(room: number): Promise<PendingFile[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    ...IMAGE_OPTIONS,
    mediaTypes: ["images", "videos"],
    allowsMultipleSelection: room > 1,
    selectionLimit: room,
    orderedSelection: true,
  });
  return result.canceled ? [] : result.assets.map(fromImage);
}

async function fromCamera(): Promise<PendingFile[]> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    Alert.alert(t("system:attachments.cameraOffTitle"), t("system:attachments.cameraOffBody"), [
      { text: t("system:attachments.notNow"), style: "cancel" },
      { text: t("system:attachments.openSettings"), onPress: () => void Linking.openSettings() },
    ]);
    return [];
  }
  const result = await ImagePicker.launchCameraAsync({ ...IMAGE_OPTIONS, mediaTypes: ["images"] });
  return result.canceled ? [] : result.assets.map(fromImage);
}

async function fromFiles(room: number): Promise<PendingFile[]> {
  const result = await DocumentPicker.getDocumentAsync({ multiple: room > 1, copyToCacheDirectory: true });
  if (result.canceled) return [];
  return result.assets.map((a) => ({ id: nextId(), uri: a.uri, name: a.name, mime: mimeOf(a.name, a.mimeType), size: sizeOf(a.uri, a.size) }));
}

export function canScanDocuments(): boolean {
  if (process.env.EXPO_OS === "web") return false;
  try {
    return CameraView.isDocumentScannerAvailable;
  } catch {
    return false;
  }
}

function scanName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `scan-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.pdf`;
}

async function fromScan(): Promise<PendingFile[]> {
  const result = await CameraView.scanDocumentAsync({ requestPdf: true, quality: 0.85 });
  if (!result) return [];
  if (result.pdfUri) {
    const name = scanName();
    return [{ id: nextId(), uri: result.pdfUri, name, mime: "application/pdf", size: sizeOf(result.pdfUri) }];
  }
  return result.pages.map((uri, i) => {
    const name = scanName().replace(/\.pdf$/, `-${i + 1}.jpg`);
    return { id: nextId(), uri, name, mime: "image/jpeg", size: sizeOf(uri) };
  });
}

export function chooseCameraMode(): Promise<"camera" | "scan" | null> {
  if (!canScanDocuments()) return Promise.resolve("camera");
  return new Promise((resolve) => {
    Alert.alert(
      t("system:attachments.camera"),
      undefined,
      [
        { text: t("system:attachments.takePhoto"), onPress: () => resolve("camera") },
        { text: t("system:attachments.scanDocument"), onPress: () => resolve("scan") },
      ],
      { cancelable: true, onDismiss: () => resolve(null) },
    );
  });
}

export function fromPasted(files: PastedFile[]): PendingFile[] {
  return files.map((f) => ({ id: nextId(), uri: f.uri, name: f.name, mime: mimeOf(f.name, f.mime), size: sizeOf(f.uri, f.size) }));
}

export type FileSource = "library" | "camera" | "scan" | "files";

export async function pickFrom(source: FileSource, room: number): Promise<PendingFile[]> {
  if (room <= 0) {
    Alert.alert(t("system:attachments.limitTitle"), t("system:attachments.limitBody", { max: MAX_FILES }));
    return [];
  }
  try {
    if (source === "library") return await fromLibrary(room);
    if (source === "camera") return await fromCamera();
    if (source === "scan") return await fromScan();
    return await fromFiles(room);
  } catch (err) {
    Alert.alert(t("system:attachments.couldNotAdd"), err instanceof Error ? err.message : String(err));
    return [];
  }
}

const SOURCES = [
  { source: "library", labelKey: "system:attachments.photoLibrary" },
  { source: "camera", labelKey: "system:attachments.takePhoto" },
  { source: "scan", labelKey: "system:attachments.scanDocument" },
  { source: "files", labelKey: "system:attachments.chooseFile" },
] as const satisfies readonly { source: FileSource; labelKey: string }[];

/** The system's own sheet on iOS, a plain dialog on Android. */
export function chooseSource(): Promise<FileSource | null> {
  return new Promise((resolve) => {
    if (process.env.EXPO_OS === "ios") {
      const sources = SOURCES.filter((s) => s.source !== "scan" || canScanDocuments());
      ActionSheetIOS.showActionSheetWithOptions({ options: [...sources.map((s) => t(s.labelKey)), t("common:actions.cancel")], cancelButtonIndex: sources.length }, (i) =>
        resolve(sources[i]?.source ?? null),
      );
      return;
    }
    const sources = SOURCES.filter((s) => s.source !== "scan");
    Alert.alert(t("system:attachments.attach"), undefined, sources.map((s) => ({ text: t(s.labelKey), onPress: () => resolve(s.source === "camera" ? chooseCameraMode() : s.source) })), {
      cancelable: true,
      onDismiss: () => resolve(null),
    });
  });
}

/** Files picked for a message or a task: `attach` asks where from and adds what fits. */
export function usePendingFiles() {
  const [files, setFiles] = useState<PendingFile[]>([]);
  const attach = async () => {
    const source = await chooseSource();
    if (!source) return;
    const picked = await pickFrom(source, MAX_FILES - files.length);
    if (picked.length) setFiles((current) => addFiles(current, picked));
  };
  const remove = (id: string) => setFiles((current) => current.filter((f) => f.id !== id));
  return { files, attach, remove, clear: () => setFiles([]) };
}

/** The files as the API takes them (base64), read only when they are sent. */
export async function encodeFiles(files: PendingFile[]): Promise<UploadFile[]> {
  return Promise.all(files.map(async (f) => ({ name: f.name, mime: f.mime, data: await new File(f.uri).base64() })));
}
