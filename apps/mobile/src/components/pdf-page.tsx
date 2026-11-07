import { useMutation } from "@tanstack/react-query";
import type { File } from "expo-file-system";
import type { ComponentType } from "react";
import { Alert } from "react-native";
import { useTranslation } from "react-i18next";
import RNWebView, { type WebViewProps } from "react-native-webview";
import { Button, EmptyState } from "@/components/ui";
import { errorText } from "@/lib/api";
import { saveOrShareFile } from "@/lib/save-file";
import { useColors } from "@/lib/theme";

/** Its class defaults its extra props to `undefined`, which TypeScript 6 turns into `never`. */
const WebView = RNWebView as unknown as ComponentType<WebViewProps>;

/** A PDF in the app's cache, in the system's PDF view (no scripts). Android's web view shows none, so there it can be saved. */
export function PdfPage({ file }: { file: File }) {
  const c = useColors();
  const { t } = useTranslation(["files", "common"]);
  const save = useMutation({
    mutationFn: () => saveOrShareFile(file, "application/pdf"),
    onError: (err) => Alert.alert(t("preview.shareFailed"), errorText(err)),
  });
  if (process.env.EXPO_OS === "android") {
    return (
      <EmptyState
        icon="doc"
        title={file.name}
        body={t("preview.pdfElsewhere")}
        action={<Button title={t("common:actions.save")} icon="download" loading={save.isPending} onPress={() => save.mutate()} />}
        style={{ flex: 1, justifyContent: "center" }}
      />
    );
  }
  return (
    <WebView
      source={{ uri: file.uri }}
      originWhitelist={["file://*"]}
      allowingReadAccessToURL={file.uri.slice(0, file.uri.lastIndexOf("/") + 1)}
      allowFileAccess
      javaScriptEnabled={false}
      style={{ flex: 1, backgroundColor: c.background }}
      contentInsetAdjustmentBehavior="automatic"
    />
  );
}
