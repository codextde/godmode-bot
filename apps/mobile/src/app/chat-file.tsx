import { useMutation, useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { useTranslation } from "react-i18next";
import { HeaderActions } from "@/components/header-actions";
import { Markdown } from "@/components/markdown";
import { PdfPage } from "@/components/pdf-page";
import { ErrorState, T } from "@/components/ui";
import FilePreview from "./settings/files/preview";
import { forgetLocalCopies, servedCopy, shareFile } from "@/lib/agent-files";
import { errorText } from "@/lib/api";
import { fonts, space, useColors } from "@/lib/theme";

const MAX_SHOWN = 200_000;

type Kind = "image" | "markdown" | "text" | "pdf";

/** A file a chat names: from the folder of its agent in the file viewer, from elsewhere on the computer as it serves it. */
export default function ChatFile() {
  const { agent, path } = useLocalSearchParams<{ agent?: string; path?: string }>();
  return agent && path ? <FilePreview /> : <ServedFile />;
}

function ServedFile() {
  const c = useColors();
  const { t } = useTranslation("files");
  const { url, kind, name } = useLocalSearchParams<{ url: string; kind: Kind; name: string }>();
  const { width, height } = useWindowDimensions();
  const [slot] = useState(() => Math.random().toString(36).slice(2, 10));
  useEffect(() => () => forgetLocalCopies(slot), [slot]);
  const copy = useQuery({
    queryKey: ["chat-file", url, slot],
    queryFn: async () => {
      const file = await servedCopy(url, name, slot);
      return { file, text: kind === "markdown" || kind === "text" ? await file.text() : null };
    },
    retry: false,
    gcTime: 0,
  });
  const share = useMutation({
    mutationFn: () => shareFile(copy.data!.file, copy.data!.text ?? undefined),
    onError: (err) => Alert.alert(t("preview.shareFailed"), errorText(err)),
  });
  const uri = copy.data?.file.uri;
  return (
    <>
      <Stack.Screen options={{ title: name, headerLargeTitleEnabled: false }} />
      <HeaderActions actions={copy.data ? [{ icon: "share", label: t("preview.share"), onPress: () => !share.isPending && share.mutate() }] : []} />
      {copy.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : !copy.data ? (
        <View style={styles.center}>
          <ErrorState title={t("preview.loadFailed")} error={errorText(copy.error)} onRetry={() => void copy.refetch()} />
        </View>
      ) : kind === "image" ? (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          maximumZoomScale={5}
          minimumZoomScale={1}
          centerContent
          bouncesZoom
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.zoom}
        >
          <Image source={{ uri }} accessibilityLabel={name} contentFit="contain" style={{ width, height: height * 0.75 }} />
        </ScrollView>
      ) : kind === "pdf" ? (
        <PdfPage file={copy.data.file} />
      ) : (
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.text}>
          {kind === "markdown" ? (
            <Markdown text={copy.data.text!.slice(0, MAX_SHOWN)} />
          ) : (
            <T selectable style={[styles.code, { color: c.text }]}>
              {copy.data.text!.slice(0, MAX_SHOWN)}
            </T>
          )}
          {copy.data.text!.length > MAX_SHOWN ? (
            <T variant="footnote" muted style={{ textAlign: "center" }}>
              {t("preview.clipped")}
            </T>
          ) : null}
        </ScrollView>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: "center",
    padding: space.lg,
  },
  zoom: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
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
