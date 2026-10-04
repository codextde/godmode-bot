import { Image } from "expo-image";
import { Pressable, ScrollView, StyleSheet, View, type ColorValue } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { Icon, type IconName } from "./icon";
import { T, tap } from "./ui";
import { formatBytes, isImage, type PendingFile } from "@/lib/attachments";
import { radius, space, useColors } from "@/lib/theme";

export function fileIcon(mime: string, name = ""): IconName {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (isImage(mime)) return "photo";
  if (mime.startsWith("video/")) return "film";
  if (mime.includes("zip") || mime.includes("compressed") || ["zip", "gz", "tar", "7z"].includes(ext)) return "archiveFile";
  if (mime.includes("sheet") || mime.includes("csv") || ["csv", "xls", "xlsx", "numbers"].includes(ext)) return "table";
  if (mime.includes("pdf") || mime.startsWith("text/") || ["md", "txt", "pdf", "doc", "docx", "pages"].includes(ext)) return "doc";
  return "attach";
}

function kindLabel(name: string, size: number): string {
  const ext = name.includes(".") ? name.split(".").pop()!.toUpperCase().slice(0, 5) : "";
  return [ext, size > 0 ? formatBytes(size) : ""].filter(Boolean).join(" · ");
}

const THUMB = 64;

/** The files waiting in the composer: photos as thumbnails, everything else as a small card. */
export function AttachmentTray({ files, onRemove, busy }: { files: PendingFile[]; onRemove: (id: string) => void; busy?: boolean }) {
  const c = useColors();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.tray}
      style={{ opacity: busy ? 0.55 : 1 }}
    >
      {files.map((f) => (
        <Animated.View key={f.id} entering={FadeIn.duration(180)} exiting={FadeOut.duration(140)} layout={LinearTransition.duration(200)} style={styles.item}>
          {isImage(f.mime) ? (
            <Image source={{ uri: f.uri }} style={[styles.thumb, { backgroundColor: c.sunken }]} contentFit="cover" transition={120} accessibilityLabel={f.name} />
          ) : (
            <View style={[styles.card, { backgroundColor: c.sunken }]}>
              <View style={[styles.cardIcon, { backgroundColor: c.surface }]}>
                <Icon name={fileIcon(f.mime, f.name)} size={16} color={c.textMuted} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <T variant="footnote" numberOfLines={1} style={{ fontWeight: "600" }}>
                  {f.name}
                </T>
                <T variant="caption" muted numberOfLines={1}>
                  {kindLabel(f.name, f.size)}
                </T>
              </View>
            </View>
          )}
          {!busy && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${f.name}`}
              hitSlop={8}
              onPress={() => {
                tap();
                onRemove(f.id);
              }}
              style={({ pressed }) => [styles.remove, { backgroundColor: c.primary, borderColor: c.surface, opacity: pressed ? 0.7 : 1 }]}
            >
              <Icon name="close" size={9} weight="bold" color={c.onPrimary} />
            </Pressable>
          )}
        </Animated.View>
      ))}
    </ScrollView>
  );
}

/** A sent file inside a message bubble. */
export function FileChip({ name, mime, size, color }: { name: string; mime: string; size?: number; color: ColorValue }) {
  return (
    <View style={styles.chip}>
      <View style={styles.chipIcon}>
        <Icon name={fileIcon(mime, name)} size={15} color={color} />
      </View>
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <T variant="footnote" color={color} numberOfLines={1} style={{ fontWeight: "600" }}>
          {name}
        </T>
        <T variant="caption" color={color} numberOfLines={1} style={{ opacity: 0.65 }}>
          {kindLabel(name, size ?? 0)}
        </T>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tray: {
    gap: space.sm,
    paddingTop: 8,
    paddingBottom: 4,
    paddingHorizontal: 8,
  },
  item: {
    paddingTop: 6,
    paddingRight: 6,
  },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    width: 184,
    height: THUMB,
    paddingHorizontal: 10,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  cardIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  remove: {
    position: "absolute",
    top: 0,
    right: 0,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    paddingLeft: 8,
    paddingRight: 12,
    borderRadius: 14,
    borderCurve: "continuous",
    backgroundColor: "rgba(127, 127, 127, 0.16)",
  },
  chipIcon: {
    width: 30,
    height: 30,
    borderRadius: 9,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(127, 127, 127, 0.18)",
  },
});
