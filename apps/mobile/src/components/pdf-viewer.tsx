import type { File } from "expo-file-system";
import { useEffect, useMemo, useRef, useState, type ComponentType, type Ref } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import RNWebView, { type WebViewMessageEvent, type WebViewProps } from "react-native-webview";
import { Glass } from "./glass";
import { SMOKE, T } from "./ui";
import { PDF_VIEWER_ORIGIN, pdfViewerPage } from "@/lib/pdf-viewer-page";
import { PDFJS_PARTS } from "@/lib/pdfjs-code";
import { radius, space, useColors } from "@/lib/theme";

type WebViewHandle = { injectJavaScript: (script: string) => void };
/** Its class defaults its extra props to `undefined`, which TypeScript 6 turns into `never`. */
const WebView = RNWebView as unknown as ComponentType<WebViewProps & { ref?: Ref<WebViewHandle> }>;

export type PdfFailure = "password" | "broken";

/** Base64 characters per message, a multiple of 4 so each one decodes on its own. */
const CHUNK = 512 * 1024;
const MAX_BYTES = 64 * 1024 * 1024;
const STUCK_MS = 45_000;
const PAGE_LABEL_MS = 1500;
const WHITE = "#FFFFFF";

const randomToken = () => Array.from({ length: 24 }, () => Math.floor(Math.random() * 16).toString(16)).join("");

function* messages(parts: [string, string][]) {
  for (const [name, text] of parts) {
    for (let at = 0; at < text.length; at += CHUNK) yield `window.__pdf.add(${JSON.stringify(name)},"${text.slice(at, at + CHUNK)}");true;`;
  }
  yield "window.__pdf.open();true;";
}

type ViewerMessage = { type: "hello" | "next" } | { type: "shown"; pages: number } | { type: "page"; page: number; pages: number } | { type: "failed"; reason: PdfFailure };

/** A PDF drawn by pdf.js in a web view with no way out: pages scroll, fingers zoom. `onFailed` when it can't be shown. */
export function PdfViewer({ file, onFailed }: { file: File; onFailed: (reason: PdfFailure) => void }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const frame = useRef<WebViewHandle>(null);
  const feed = useRef<Generator<string> | null>(null);
  const [shown, setShown] = useState(false);
  const [label, setLabel] = useState<string | null>(null);
  const [nonce] = useState(randomToken);
  const html = useMemo(() => pdfViewerPage({ nonce, background: c.background, surface: c.surface, bottom: insets.bottom }), [nonce, c.background, c.surface, insets.bottom]);

  useEffect(() => {
    if (file.size > MAX_BYTES) return onFailed("broken");
    if (shown) return;
    const stuck = setTimeout(() => onFailed("broken"), STUCK_MS);
    return () => clearTimeout(stuck);
  }, [file, shown, onFailed]);

  useEffect(() => {
    if (!label) return;
    const hide = setTimeout(() => setLabel(null), PAGE_LABEL_MS);
    return () => clearTimeout(hide);
  }, [label]);

  const sendNext = () => {
    const next = feed.current?.next();
    if (next && !next.done) frame.current?.injectJavaScript(next.value);
  };

  const onMessage = (e: WebViewMessageEvent) => {
    const message = JSON.parse(e.nativeEvent.data) as ViewerMessage;
    if (message.type === "hello") {
      file
        .base64()
        .then((pdf) => {
          feed.current = messages([...Object.entries(PDFJS_PARTS), ["pdf", pdf]]);
          sendNext();
        })
        .catch(() => onFailed("broken"));
    } else if (message.type === "next") {
      sendNext();
    } else if (message.type === "shown") {
      setShown(true);
      if (message.pages > 1) setLabel(`1 / ${message.pages}`);
    } else if (message.type === "page") {
      setLabel(`${message.page} / ${message.pages}`);
    } else if (message.type === "failed") {
      onFailed(message.reason);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <WebView
        ref={frame}
        source={{ html, baseUrl: PDF_VIEWER_ORIGIN }}
        originWhitelist={["*"]}
        onMessage={onMessage}
        onError={() => onFailed("broken")}
        onRenderProcessGone={() => onFailed("broken")}
        onShouldStartLoadWithRequest={(r) => r.url === PDF_VIEWER_ORIGIN || r.url.startsWith("about:")}
        javaScriptEnabled
        domStorageEnabled={false}
        cacheEnabled={false}
        incognito
        thirdPartyCookiesEnabled={false}
        allowFileAccess={false}
        setSupportMultipleWindows={false}
        overScrollMode="never"
        style={{ backgroundColor: c.background }}
      />
      {!shown && (
        <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: c.background }]}>
          <ActivityIndicator color={c.textMuted} />
        </View>
      )}
      {label && (
        <Animated.View entering={FadeIn} exiting={FadeOut} style={[styles.label, { bottom: insets.bottom + space.lg, pointerEvents: "none" }]}>
          <Glass scheme="dark" fallback={SMOKE} style={styles.pill}>
            <T variant="caption" color={WHITE} style={{ fontWeight: "600" }}>
              {label}
            </T>
          </Glass>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
  },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
  },
});
