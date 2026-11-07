import { Directory, File } from "expo-file-system";
import { Share } from "react-native";

/** The share sheet with the file on iOS; on Android (whose sheet takes no files) a folder the human picks. False when closed. */
export async function saveOrShareFile(file: File, mime = "application/octet-stream"): Promise<boolean> {
  if (process.env.EXPO_OS === "ios") {
    const result = await Share.share({ url: file.uri });
    return result.action !== Share.dismissedAction;
  }
  const dir = await Directory.pickDirectoryAsync().catch(() => null);
  if (!dir) return false;
  const target = dir.createFile(file.name, mime);
  await target.write(await file.bytes());
  return true;
}
