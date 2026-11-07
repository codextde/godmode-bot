import { Image } from "expo-image";
import { useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, useWindowDimensions, View, type ImageStyle, type StyleProp } from "react-native";
import type { Artifact, ArtifactFile } from "@godmode/shared";
import { Icon, type IconName } from "./icon";
import { T, tap } from "./ui";
import { pictureBases } from "@/lib/api";
import { artifactFilePath } from "@/lib/artifact-files";
import { formatBytes } from "@/lib/attachments";
import { useSession } from "@/lib/session";
import { radius, space, useColors } from "@/lib/theme";

const MIN_TILE = 150;
const GAP = space.md;

export const fileIcon = (file: ArtifactFile): IconName => (file.kind === "image" ? "photo" : file.kind === "video" ? "video" : file.kind === "audio" ? "waveform" : "doc");

type WithFiles = Pick<Artifact, "files" | "filesBase">;

/** A picture of the artifact, from each of the computer's addresses in turn. The secret in its path is the credential. */
export function ArtifactPicture({
  artifact,
  file,
  contentFit = "contain",
  style,
}: {
  artifact: WithFiles;
  file: ArtifactFile;
  contentFit?: "contain" | "cover";
  style?: StyleProp<ImageStyle>;
}) {
  const c = useColors();
  const connection = useSession((s) => s.connection);
  const [attempt, setAttempt] = useState(0);
  const bases = connection ? pictureBases(connection) : [];
  if (attempt >= bases.length) return <Icon name="photo" size={22} color={c.textFaint} />;
  const path = artifactFilePath(artifact, file.name);
  return (
    <Image
      source={{ uri: bases[attempt] + path, cacheKey: `${path}:${file.updatedAt}` }}
      onError={() => setAttempt((a) => a + 1)}
      accessibilityLabel={file.name}
      contentFit={contentFit}
      cachePolicy="disk"
      recyclingKey={path}
      style={style}
    />
  );
}

/** Everything attached to the artifact, whatever its page shows. */
export function ArtifactFilesGrid({ artifact, refreshing, onRefresh, onOpen }: { artifact: WithFiles; refreshing: boolean; onRefresh: () => void; onOpen: (name: string) => void }) {
  const c = useColors();
  const { width } = useWindowDimensions();
  const columns = Math.max(2, Math.floor((width - space.lg * 2 + GAP) / (MIN_TILE + GAP)));
  const tile = (width - space.lg * 2 - GAP * (columns - 1)) / columns;
  return (
    <FlatList
      key={columns}
      data={artifact.files}
      numColumns={columns}
      keyExtractor={(f) => f.name}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      contentContainerStyle={styles.grid}
      columnWrapperStyle={{ gap: GAP }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.textMuted} />}
      renderItem={({ item: f }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={f.name}
          onPress={() => {
            tap();
            onOpen(f.name);
          }}
          style={({ pressed }) => [styles.tile, { width: tile, backgroundColor: c.surface, borderColor: c.border, opacity: pressed ? 0.7 : 1 }]}
        >
          <View style={[styles.picture, { backgroundColor: c.sunken }]}>
            {f.kind === "image" ? <ArtifactPicture artifact={artifact} file={f} style={StyleSheet.absoluteFill} /> : <Icon name={fileIcon(f)} size={24} color={c.textMuted} />}
          </View>
          <View style={styles.caption}>
            <T variant="footnote" numberOfLines={1} style={{ fontWeight: "500" }}>
              {f.name}
            </T>
            <T variant="caption" muted>
              {formatBytes(f.size)}
            </T>
          </View>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  grid: {
    gap: GAP,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.lg,
  },
  tile: {
    overflow: "hidden",
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  picture: {
    aspectRatio: 4 / 3,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  caption: {
    gap: 1,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
});
