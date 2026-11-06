import { Image } from "expo-image";
import { useRecyclingState } from "@shopify/flash-list";
import { useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Attachment } from "@godmode/shared";
import { Icon } from "./icon";
import { T, tap } from "./ui";
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
  return (
    <View style={styles.row}>
      {files.map((f, i) => (
        <Thumbnail key={`${f.path}-${i}`} file={f} url={pictureUrl(conversationId, f.path)} single={single} fallback={fallback} />
      ))}
    </View>
  );
}

function Thumbnail({ file, url, single, fallback }: { file: Attachment; url: string; single: boolean; fallback: (file: Attachment) => ReactNode }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const { source, failed, next } = usePictureSource(url);
  const [ratio, setRatio] = useRecyclingState(4 / 3, [url]);
  const [open, setOpen] = useState(false);
  if (failed || !source) return <>{fallback(file)}</>;
  const r = Math.min(2, Math.max(0.6, ratio));
  const width = 240 * Math.min(1, r);
  const box = single ? { width, height: Math.round(width / r) } : { width: 104, height: 104 };
  return (
    <>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={t("attachmentPictures.enlarge", { name: file.name })}
        onPress={() => {
          tap();
          setOpen(true);
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
      {open ? <Viewer source={source} name={file.name} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** One picture on black, pinched to zoom; swipe down or Close to go back. */
function Viewer({ source, name, onClose }: { source: { uri: string; headers: Record<string, string>; cacheKey: string }; name: string; onClose: () => void }) {
  const { t } = useTranslation("common");
  const insets = useSafeAreaInsets();
  return (
    <Modal visible animationType="fade" presentationStyle="overFullScreen" transparent={false} onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.viewer}>
        <ScrollView
          style={StyleSheet.absoluteFill}
          contentContainerStyle={{ flex: 1 }}
          maximumZoomScale={4}
          minimumZoomScale={1}
          centerContent
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        >
          <Image source={source} accessibilityLabel={name} contentFit="contain" cachePolicy="disk" style={{ flex: 1 }} />
        </ScrollView>
        <View style={[styles.viewerBar, { paddingTop: insets.top + 6 }]} pointerEvents="box-none">
          <Pressable accessibilityRole="button" accessibilityLabel={t("actions.close")} hitSlop={10} onPress={onClose} style={({ pressed }) => [styles.close, pressed && { opacity: 0.6 }]}>
            <Icon name="close" size={15} color="#FFFFFF" weight="semibold" />
          </Pressable>
          <T variant="footnote" color="#FFFFFF" numberOfLines={1} style={{ flex: 1, opacity: 0.85 }}>
            {name}
          </T>
        </View>
      </View>
    </Modal>
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
  viewer: {
    flex: 1,
    backgroundColor: "#000000",
  },
  viewerBar: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 10,
    backgroundColor: "rgba(0, 0, 0, 0.35)",
  },
  close: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.16)",
  },
});
