import { Image } from "expo-image";
import { useState } from "react";
import { FlatList, Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "./icon";
import { T } from "./ui";
import { pictureBases } from "@/lib/api";
import { useSession } from "@/lib/session";

export type ViewerPicture = { url: string; name: string };

/**
 * The pictures of a message on black, one at a time: swipe between them, pinch to zoom, Close to go back. `onShare` adds
 * sharing the one in front.
 */
export function PictureViewer({ pictures, start, onClose, onShare }: { pictures: ViewerPicture[]; start: number; onClose: () => void; onShare?: (index: number) => void }) {
  const { t } = useTranslation(["common", "files"]);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [index, setIndex] = useState(start);
  const current = pictures[index] ?? pictures[0];
  return (
    <Modal visible animationType="fade" presentationStyle="overFullScreen" transparent={false} onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.viewer}>
        <FlatList
          data={pictures}
          horizontal
          pagingEnabled
          initialScrollIndex={start}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          keyExtractor={(p, i) => `${p.url}-${i}`}
          renderItem={({ item }) => <Page picture={item} width={width} height={height} />}
          showsHorizontalScrollIndicator={false}
          scrollEnabled={pictures.length > 1}
          onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / width))}
        />
        <View style={[styles.bar, { paddingTop: insets.top + 6 }]} pointerEvents="box-none">
          <Pressable accessibilityRole="button" accessibilityLabel={t("common:actions.close")} hitSlop={10} onPress={onClose} style={({ pressed }) => [styles.round, pressed && { opacity: 0.6 }]}>
            <Icon name="close" size={15} color="#FFFFFF" weight="semibold" />
          </Pressable>
          <T variant="footnote" color="#FFFFFF" numberOfLines={1} style={{ flex: 1, opacity: 0.85 }}>
            {current?.name}
          </T>
          {pictures.length > 1 ? (
            <T variant="footnote" color="#FFFFFF" style={styles.count}>
              {index + 1} / {pictures.length}
            </T>
          ) : null}
          {onShare ? (
            <Pressable accessibilityRole="button" accessibilityLabel={t("files:preview.share")} hitSlop={10} onPress={() => onShare(index)} style={({ pressed }) => [styles.round, pressed && { opacity: 0.6 }]}>
              <Icon name="share" size={15} color="#FFFFFF" weight="semibold" />
            </Pressable>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

/** One picture, loaded with this phone's key from each of the computer's addresses in turn. */
function Page({ picture, width, height }: { picture: ViewerPicture; width: number; height: number }) {
  const connection = useSession((s) => s.connection);
  const [attempt, setAttempt] = useState(0);
  const base = connection ? pictureBases(connection)[attempt] : undefined;
  return (
    <ScrollView
      style={{ width, height }}
      contentContainerStyle={{ flex: 1 }}
      maximumZoomScale={4}
      minimumZoomScale={1}
      centerContent
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
    >
      {base ? (
        <Image
          source={{ uri: base + picture.url, headers: { authorization: `Bearer ${connection!.token}` }, cacheKey: picture.url }}
          onError={() => setAttempt((a) => a + 1)}
          accessibilityLabel={picture.name}
          contentFit="contain"
          cachePolicy="disk"
          style={{ flex: 1 }}
        />
      ) : (
        <View style={styles.missing}>
          <Icon name="photo" size={22} color="rgba(255, 255, 255, 0.5)" />
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  viewer: {
    flex: 1,
    backgroundColor: "#000000",
  },
  bar: {
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
  round: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.16)",
  },
  count: {
    opacity: 0.85,
    fontVariant: ["tabular-nums"],
  },
  missing: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
