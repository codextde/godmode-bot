import { useMutation, useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, ScrollView, StyleSheet, useWindowDimensions, View, type ScrollViewInstance } from "react-native";
import { useTranslation } from "react-i18next";
import RNWebView, { type WebViewProps } from "react-native-webview";
import Animated, { useAnimatedProps, useSharedValue, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Artifact, ArtifactFile } from "@godmode/shared";
import { ArtifactPicture, fileIcon } from "@/components/artifact-files";
import { HeaderActions } from "@/components/header-actions";
import { Icon } from "@/components/icon";
import { PdfPage } from "@/components/pdf-page";
import { zoomImage, ZoomView } from "@/components/zoom-view";
import { Button, EmptyState, ErrorState, GlassIconButton, Hairline, Row, T, tap } from "@/components/ui";
import { forgetLocalCopies, servedCopy } from "@/lib/agent-files";
import { ApiError, api, errorText, pictureBases } from "@/lib/api";
import { artifactFilePath, saveArtifactFile } from "@/lib/artifact-files";
import { formatBytes } from "@/lib/attachments";
import { qk } from "@/lib/query";
import { useSession } from "@/lib/session";
import { radius, space, useColors } from "@/lib/theme";

/** Its class defaults its extra props to `undefined`, which TypeScript 6 turns into `never`. */
const WebView = RNWebView as unknown as ComponentType<WebViewProps>;

const STRIP_SIZE = 48;

/** A file of an artifact at full size: swipe or use the arrows to go through the others, pinch a picture to zoom. */
export default function ArtifactFileScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name: string }>();
  const c = useColors();
  const { t } = useTranslation("artifacts");
  const query = useQuery({ queryKey: qk.artifact(id), queryFn: () => api.artifacts.get(id) });
  const artifact = query.data;
  if (artifact?.files.length) return <Viewer artifact={artifact} start={name} />;
  const gone = artifact || (query.error instanceof ApiError && query.error.status === 404);
  return (
    <View style={[styles.center, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ title: "" }} />
      {query.isLoading ? (
        <ActivityIndicator color={c.textMuted} />
      ) : gone ? (
        <EmptyState icon="artifact" title={t("view.goneTitle")} body={t("view.goneBody")} />
      ) : (
        <ErrorState title={t("view.loadErrorTitle")} error={errorText(query.error)} onRetry={() => void query.refetch()} />
      )}
    </View>
  );
}

function Viewer({ artifact, start }: { artifact: Artifact; start: string }) {
  const c = useColors();
  const { t } = useTranslation("artifacts");
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const files = artifact.files;
  const pager = useRef<FlatList<ArtifactFile>>(null);
  const strip = useRef<ScrollViewInstance>(null);
  const [wanted, setWanted] = useState(() => Math.max(0, files.findIndex((f) => f.name === start)));
  const index = Math.min(wanted, files.length - 1);
  const file = files[index]!;
  const many = files.length > 1;
  const held = useSharedValue(false);
  const pagerProps = useAnimatedProps(() => ({ scrollEnabled: !held.get() }));
  const [height, setHeight] = useState(0);
  const [slot] = useState(() => Math.random().toString(36).slice(2, 10));
  useEffect(() => () => forgetLocalCopies(slot), [slot]);
  useEffect(() => strip.current?.scrollTo({ x: Math.max(0, index * (STRIP_SIZE + space.sm) - width / 2 + STRIP_SIZE / 2), animated: true }), [index, width]);

  const go = (next: number) => {
    const target = (next + files.length) % files.length;
    setWanted(target);
    pager.current?.scrollToIndex({ index: target, animated: Math.abs(target - index) === 1 });
  };
  const download = useMutation({
    mutationFn: () => saveArtifactFile(artifact, file, slot),
    onError: (err) => Alert.alert(t("files.actionError"), errorText(err)),
  });

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <Stack.Screen options={{ title: file.name, headerLargeTitleEnabled: false, headerTransparent: false, headerStyle: { backgroundColor: c.background } }} />
      <HeaderActions actions={[{ icon: "download", label: t("files.download"), onPress: () => !download.isPending && download.mutate() }]} />
      <View style={{ flex: 1 }} onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
        {height > 0 ? (
          <Animated.FlatList
            key={width}
            ref={pager}
            animatedProps={pagerProps}
            data={files}
            extraData={index}
            horizontal
            pagingEnabled
            bounces={many}
            showsHorizontalScrollIndicator={false}
            keyExtractor={(f) => f.name}
            initialScrollIndex={index}
            initialNumToRender={1}
            maxToRenderPerBatch={1}
            windowSize={3}
            getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
            onMomentumScrollEnd={(e) => setWanted(Math.round(e.nativeEvent.contentOffset.x / width))}
            renderItem={({ item, index: i }) => (
              <View style={{ width, height }}>
                <Page artifact={artifact} file={item} active={i === index} slot={slot} width={width} height={height} held={held} onSave={() => download.mutate()} saving={download.isPending} />
              </View>
            )}
          />
        ) : null}
      </View>
      <Hairline />
      <View style={{ paddingBottom: Math.max(insets.bottom, space.sm), paddingTop: space.sm, gap: space.sm }}>
        <Row style={styles.bar}>
          {many ? <GlassIconButton icon="back" size={36} label={t("files.previous")} onPress={() => go(index - 1)} /> : null}
          <T variant="footnote" muted numberOfLines={1} style={styles.count}>
            {many ? `${index + 1} / ${files.length} · ` : ""}
            {formatBytes(file.size)}
          </T>
          {many ? <GlassIconButton icon="chevron" size={36} label={t("files.next")} onPress={() => go(index + 1)} /> : null}
        </Row>
        {many ? (
          <ScrollView ref={strip} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
            {files.map((f, i) => (
              <Pressable
                key={f.name}
                accessibilityRole="button"
                accessibilityLabel={f.name}
                accessibilityState={{ selected: i === index }}
                onPress={() => {
                  tap();
                  go(i);
                }}
                style={[styles.thumb, { backgroundColor: c.sunken, borderColor: i === index ? c.brand : c.border, opacity: i === index ? 1 : 0.7 }]}
              >
                {f.kind === "image" ? <ArtifactPicture artifact={artifact} file={f} contentFit="cover" style={StyleSheet.absoluteFill} /> : <Icon name={fileIcon(f)} size={16} color={c.textMuted} />}
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
      </View>
    </View>
  );
}

/** One file. What plays or takes a while (sound, video, PDF) waits until it is the one on screen. */
function Page({
  artifact,
  file,
  active,
  slot,
  width,
  height,
  held,
  saving,
  onSave,
}: {
  artifact: Artifact;
  file: ArtifactFile;
  active: boolean;
  slot: string;
  width: number;
  height: number;
  held: SharedValue<boolean>;
  saving: boolean;
  onSave: () => void;
}) {
  const c = useColors();
  const { t } = useTranslation("artifacts");
  if (file.kind === "image") {
    return (
      <ZoomView max={5} held={held} centerContent bouncesZoom showsHorizontalScrollIndicator={false} showsVerticalScrollIndicator={false} contentContainerStyle={styles.center}>
        <ArtifactPicture artifact={artifact} file={file} style={{ width, height }} {...zoomImage} />
      </ZoomView>
    );
  }
  if (file.kind === "file") {
    return (
      <EmptyState
        icon="doc"
        title={file.name}
        body={t("files.noPreview")}
        action={<Button title={t("files.download")} icon="download" loading={saving} onPress={onSave} />}
        style={styles.center}
      />
    );
  }
  if (!active) {
    return (
      <View style={styles.center}>
        <Icon name={fileIcon(file)} size={28} color={c.textFaint} />
      </View>
    );
  }
  return file.kind === "pdf" ? <PdfFile artifact={artifact} file={file} slot={slot} /> : <Media artifact={artifact} file={file} />;
}

function PdfFile({ artifact, file, slot }: { artifact: Artifact; file: ArtifactFile; slot: string }) {
  const { t } = useTranslation("artifacts");
  const path = artifactFilePath(artifact, file.name);
  const copy = useQuery({ queryKey: ["artifact-file", path, slot], queryFn: () => servedCopy(path, file.name, slot), retry: false, gcTime: 0 });
  if (copy.data) return <PdfPage file={copy.data} />;
  return <View style={styles.center}>{copy.isError ? <ErrorState title={t("view.loadErrorTitle")} error={errorText(copy.error)} onRetry={() => void copy.refetch()} /> : <ActivityIndicator />}</View>;
}

const attribute = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Video and sound with the system's own controls; the page runs no scripts. */
function Media({ artifact, file }: { artifact: Artifact; file: ArtifactFile }) {
  const c = useColors();
  const connection = useSession((s) => s.connection);
  const base = connection ? pictureBases(connection)[0] : undefined;
  const url = base ? base + artifactFilePath(artifact, file.name) : null;
  const html = useMemo(() => {
    const tag = file.kind === "video" ? "video" : "audio";
    const page = `html,body{margin:0;height:100%;background:${c.background}}body{display:flex;align-items:center;justify-content:center}video{max-width:100%;max-height:100%}audio{width:88%}`;
    return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${page}</style><${tag} src="${attribute(url ?? "")}" controls autoplay playsinline></${tag}>`;
  }, [c.background, file.kind, url]);
  if (!url) return null;
  return (
    <WebView
      source={{ html }}
      originWhitelist={["*"]}
      javaScriptEnabled={false}
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      style={{ flex: 1, backgroundColor: c.background }}
    />
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  bar: {
    gap: space.md,
    paddingHorizontal: space.lg,
  },
  count: {
    flex: 1,
    textAlign: "center",
    fontVariant: ["tabular-nums"],
  },
  strip: {
    gap: space.sm,
    paddingHorizontal: space.lg,
  },
  thumb: {
    width: STRIP_SIZE,
    height: STRIP_SIZE,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderRadius: radius.sm,
    borderCurve: "continuous",
    borderWidth: 1.5,
  },
});
