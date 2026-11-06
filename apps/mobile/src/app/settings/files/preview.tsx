import { useMutation, useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import RNWebView, { type WebViewProps } from "react-native-webview";
import { useTranslation } from "react-i18next";
import { HeaderActions } from "@/components/header-actions";
import { Markdown } from "@/components/markdown";
import { EmptyState, ErrorState, T } from "@/components/ui";
import { ApiError, errorText, pictureBases } from "@/lib/api";
import { fileKind, filesApi, fk, forgetLocalCopies, localCopy, localTextCopy, nameOf, rawPath, shareFile, viewable, type FileKind } from "@/lib/agent-files";
import { useSession } from "@/lib/session";
import { fonts, space, useColors } from "@/lib/theme";

/** Its class defaults its extra props to `undefined`, which TypeScript 6 turns into `never`. */
const WebView = RNWebView as unknown as ComponentType<WebViewProps>;

/** Long files show their beginning: a phone screen doesn't need two megabytes of log. */
const MAX_SHOWN = 200_000;

/** A file of an agent's folder: text, Markdown and code as text, pictures and PDFs as they are. Shared, never changed. */
export default function FilePreview() {
  const { t } = useTranslation("files");
  const { agent, path } = useLocalSearchParams<{ agent: string; path: string }>();
  const kind = fileKind({ path, type: "file" });
  // This screen's own folder in the cache: what it fetched to show or share leaves the phone with it.
  const [slot] = useState(() => Math.random().toString(36).slice(2, 10));
  useEffect(() => () => forgetLocalCopies(slot), [slot]);
  const text = useQuery({ queryKey: fk.file(agent, path), queryFn: () => filesApi.read(agent, path), enabled: !viewable(kind), retry: false, gcTime: 0 });

  const share = useMutation({
    mutationFn: async () => {
      if (text.data) return shareFile(localTextCopy(slot, path, text.data.content), text.data.content);
      return shareFile(await localCopy(agent, path, slot));
    },
    onError: (err) => Alert.alert(t("preview.shareFailed"), errorText(err)),
  });
  const canShare = viewable(kind) || !!text.data;

  return (
    <>
      <Stack.Screen options={{ title: nameOf(path), headerLargeTitleEnabled: false }} />
      {canShare ? <HeaderActions actions={[{ icon: "share", label: t("preview.share"), onPress: () => !share.isPending && share.mutate() }]} /> : null}
      {kind === "image" ? (
        <ImageView agent={agent} path={path} />
      ) : kind === "pdf" ? (
        <PdfView agent={agent} path={path} slot={slot} />
      ) : text.isLoading ? (
        <Centered>
          <ActivityIndicator />
        </Centered>
      ) : text.isError ? (
        <Centered>
          <TextError error={text.error} onRetry={() => void text.refetch()} />
        </Centered>
      ) : text.data ? (
        <TextView kind={kind} content={text.data.content} />
      ) : null}
    </>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <View style={styles.center}>{children}</View>;
}

function TextError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation("files");
  const code = error instanceof ApiError ? error.code : undefined;
  if (code === "binary_file") return <EmptyState icon="doc" title={t("preview.binaryTitle")} body={t("preview.binaryBody")} />;
  if (code === "too_large") return <EmptyState icon="doc" title={t("preview.tooLargeTitle")} body={t("preview.tooLargeBody")} />;
  if (code === "device_forbidden") return <EmptyState icon="lock" title={t("preview.refusedTitle")} body={errorText(error)} />;
  return <ErrorState title={t("preview.loadFailed")} error={errorText(error)} onRetry={onRetry} />;
}

function TextView({ kind, content }: { kind: FileKind; content: string }) {
  const c = useColors();
  const { t } = useTranslation("files");
  const clipped = content.length > MAX_SHOWN;
  const shown = clipped ? content.slice(0, MAX_SHOWN) : content;
  if (!content.trim()) {
    return (
      <Centered>
        <EmptyState icon="doc" title={t("preview.empty")} />
      </Centered>
    );
  }
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.text}>
      {kind === "markdown" ? (
        <Markdown text={shown} />
      ) : (
        <T selectable style={[styles.code, { color: c.text }]}>
          {shown}
        </T>
      )}
      {clipped ? (
        <T variant="footnote" muted style={{ textAlign: "center" }}>
          {t("preview.clipped")}
        </T>
      ) : null}
    </ScrollView>
  );
}

/** A picture loaded with this phone's key from each of the computer's addresses in turn; pinch to zoom. */
function ImageView({ agent, path }: { agent: string; path: string }) {
  const c = useColors();
  const { t } = useTranslation("files");
  const { width, height } = useWindowDimensions();
  const connection = useSession((s) => s.connection);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const bases = connection ? pictureBases(connection) : [];
  if (!connection || attempt >= bases.length) {
    return (
      <Centered>
        <ErrorState title={t("preview.imageFailed")} error={t("preview.imageFailedBody")} onRetry={() => setAttempt(0)} />
      </Centered>
    );
  }
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      maximumZoomScale={5}
      minimumZoomScale={1}
      centerContent
      bouncesZoom
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }}
    >
      <Image
        source={{ uri: bases[attempt] + rawPath(agent, path), headers: { authorization: `Bearer ${connection.token}` } }}
        onLoad={() => setLoaded(true)}
        onError={() => setAttempt((a) => a + 1)}
        accessibilityLabel={nameOf(path)}
        contentFit="contain"
        cachePolicy="memory"
        transition={150}
        style={{ width, height: height * 0.75, backgroundColor: loaded ? undefined : c.sunken }}
      />
    </ScrollView>
  );
}

/** A PDF fetched into the app's cache and shown by the system's PDF view (no scripts). */
function PdfView({ agent, path, slot }: { agent: string; path: string; slot: string }) {
  const { t } = useTranslation("files");
  const c = useColors();
  const file = useQuery({ queryKey: ["agent-files", agent, "pdf", path, slot], queryFn: () => localCopy(agent, path, slot), retry: false, gcTime: 0 });
  if (file.isLoading) {
    return (
      <Centered>
        <ActivityIndicator />
      </Centered>
    );
  }
  if (file.isError || !file.data) {
    return (
      <Centered>
        <ErrorState title={t("preview.loadFailed")} error={errorText(file.error)} onRetry={() => void file.refetch()} />
      </Centered>
    );
  }
  const uri = file.data.uri;
  return (
    <WebView
      source={{ uri }}
      originWhitelist={["file://*"]}
      allowingReadAccessToURL={uri.slice(0, uri.lastIndexOf("/") + 1)}
      allowFileAccess
      javaScriptEnabled={false}
      style={{ flex: 1, backgroundColor: c.background }}
      contentInsetAdjustmentBehavior="automatic"
    />
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: "center",
    padding: space.lg,
  },
  text: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.lg,
  },
  code: {
    fontFamily: fonts.mono,
    fontSize: 13,
    lineHeight: 19,
  },
});
