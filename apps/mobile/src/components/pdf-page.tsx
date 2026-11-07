import { useMutation } from "@tanstack/react-query";
import type { File } from "expo-file-system";
import { useState, type ComponentType } from "react";
import { Alert } from "react-native";
import { useTranslation } from "react-i18next";
import RNWebView, { type WebViewProps } from "react-native-webview";
import { PdfViewer, type PdfFailure } from "./pdf-viewer";
import { Button, EmptyState } from "@/components/ui";
import { errorText } from "@/lib/api";
import { saveOrShareFile } from "@/lib/save-file";
import { useColors } from "@/lib/theme";

/** Its class defaults its extra props to `undefined`, which TypeScript 6 turns into `never`. */
const WebView = RNWebView as unknown as ComponentType<WebViewProps>;

/** A PDF in the app's cache: the system's PDF view on iOS (no scripts), pdf.js on Android, whose web view shows none. */
export function PdfPage({ file }: { file: File }) {
  const c = useColors();
  const { t } = useTranslation(["files", "common"]);
  const [failure, setFailure] = useState<PdfFailure | null>(null);
  const save = useMutation({
    mutationFn: () => saveOrShareFile(file, "application/pdf"),
    onError: (err) => Alert.alert(t("preview.shareFailed"), errorText(err)),
  });
  if (process.env.EXPO_OS === "android") {
    if (!failure) return <PdfViewer key={file.uri} file={file} onFailed={setFailure} />;
    return (
      <EmptyState
        icon="doc"
        title={file.name}
        body={t(failure === "password" ? "preview.pdfLocked" : "preview.pdfFailed")}
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
