import { Image } from "expo-image";
import { useRecyclingState } from "@shopify/flash-list";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Attachment } from "@godmode/shared";
import { PictureViewer } from "./picture-viewer";
import { tap } from "./ui";
import { pictureBases } from "@/lib/api";
import { useSession } from "@/lib/session";
import { radius, useColors } from "@/lib/theme";

const PICTURE = /^image\/(png|jpe?g|gif|webp)$/i;

/** A picture the computer keeps for the chat (attached on the computer or sent from the phone), not one still on its way. */
export const isChatPicture = (a: Attachment) => !!a.path && PICTURE.test(a.mime);

const pictureUrl = (conversationId: string, path: string) => `/api/conversations/${encodeURIComponent(conversationId)}/attachment?path=${encodeURIComponent(path)}`;

/** The picture's address on each of the computer's addresses in turn, with this phone's key. */
function usePictureSource(url: string) {
  const connection = useSession((s) => s.connection);
  const [attempt, setAttempt] = useRecyclingState(0, [url]);
  if (!connection) return { source: null, failed: true, next: () => undefined };
  const bases = pictureBases(connection);
  const base = bases[attempt];
  return {
    source: base ? { uri: base + url, headers: { authorization: `Bearer ${connection.token}` }, cacheKey: url } : null,
    failed: !base,
    next: () => setAttempt((a) => a + 1),
  };
}

/**
 * The pictures of a message as thumbnails above its bubble; a tap shows one full screen. One that doesn't load (an older
 * Godmode on the computer, a file that is gone) falls back to its chip.
 */
export function AttachmentPictures({ files, conversationId, fallback }: { files: Attachment[]; conversationId: string; fallback: (file: Attachment) => ReactNode }) {
  const single = files.length === 1;
  const [open, setOpen] = useRecyclingState<number | null>(null, [conversationId, files[0]?.path]);
  return (
    <View style={styles.row}>
      {files.map((f, i) => (
        <Thumbnail key={`${f.path}-${i}`} file={f} url={pictureUrl(conversationId, f.path)} single={single} fallback={fallback} onOpen={() => setOpen(i)} />
      ))}
      {open !== null ? <PictureViewer pictures={files.map((f) => ({ url: pictureUrl(conversationId, f.path), name: f.name }))} start={open} onClose={() => setOpen(null)} /> : null}
    </View>
  );
}

function Thumbnail({ file, url, single, fallback, onOpen }: { file: Attachment; url: string; single: boolean; fallback: (file: Attachment) => ReactNode; onOpen: () => void }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const { source, failed, next } = usePictureSource(url);
  const [ratio, setRatio] = useRecyclingState(4 / 3, [url]);
  if (failed || !source) return <>{fallback(file)}</>;
  const r = Math.min(2, Math.max(0.6, ratio));
  const width = 240 * Math.min(1, r);
  const box = single ? { width, height: Math.round(width / r) } : { width: 104, height: 104 };
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={t("attachmentPictures.enlarge", { name: file.name })}
      onPress={() => {
        tap();
        onOpen();
      }}
      style={({ pressed }) => [styles.thumb, { borderColor: c.border, backgroundColor: c.sunken }, box, pressed && { opacity: 0.8 }]}
    >
      <Image
        source={source}
        onLoad={(e) => e.source.width && e.source.height && setRatio(e.source.width / e.source.height)}
        onError={next}
        contentFit="cover"
        cachePolicy="disk"
        transition={150}
        style={StyleSheet.absoluteFill}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: 6,
  },
  thumb: {
    overflow: "hidden",
    borderRadius: radius.xl,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
});
