import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type Ref } from "react";
import { ActivityIndicator, Linking, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useTranslation } from "react-i18next";
import RNWebView, { type WebViewMessageEvent, type WebViewProps } from "react-native-webview";
import { webViewDocument, type Artifact } from "@godmode/shared";
import { Button, T } from "./ui";
import { pictureBases } from "@/lib/api";
import { useSession } from "@/lib/session";
import { space, useColors, useIsDark } from "@/lib/theme";

export interface ArtifactFrameHandlers {
  /** The page saved data (`godmode.setData`); reject when it wasn't saved. */
  onSetData?: (data: unknown) => Promise<void>;
  onAsk?: (text: string) => void;
  onRefresh?: () => void;
  onError?: (message: string) => void;
  onSaveError?: (message: string) => void;
  /** A review gallery's Send, once what the page saved is saved. */
  onReviewDone?: () => void;
  onViewFile?: (name: string, url: string | null) => void;
}

type WebViewHandle = { injectJavaScript: (script: string) => void };
/** Its class defaults its extra props to `undefined`, which TypeScript 6 turns into `never`. */
const WebView = RNWebView as unknown as ComponentType<WebViewProps & { ref?: Ref<WebViewHandle> }>;

const SAVE_DELAY_MS = 300;
const SAVE_RETRY_MS = 1000;
const STUCK_MS = 8000;

const randomToken = () => Array.from({ length: 24 }, () => Math.floor(Math.random() * 16).toString(16)).join("");

function hashOf(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Where the page loads the artifact's files: the computer's address the phone uses, with the files' secret path. */
export function useFilesBase(filesBase: string | null | undefined): string | null {
  const connection = useSession((s) => s.connection);
  if (!filesBase || !connection) return null;
  const base = pictureBases(connection)[0];
  return base ? base + filesBase : null;
}

type Outbound = { type?: string; id?: number; data?: unknown; text?: string; message?: string; url?: string; name?: string };

/**
 * Runs an artifact's HTML in a WebView of its own: no address of the computer, no key, only the CDN libraries and its
 * files. `window.godmode` talks to the app through the WebView's message channel; every save, question and refresh goes
 * through the app, which calls Godmode itself.
 */
export function ArtifactFrame({
  artifact,
  html: htmlOverride,
  interactive = true,
  style,
  ...handlers
}: { artifact: Pick<Artifact, "html" | "data" | "files" | "filesBase" | "title">; html?: string; interactive?: boolean; style?: StyleProp<ViewStyle> } & ArtifactFrameHandlers) {
  const c = useColors();
  const { t } = useTranslation("artifacts");
  const dark = useIsDark();
  const ref = useRef<WebViewHandle>(null);
  const html = htmlOverride ?? artifact.html;
  const base = useFilesBase(artifact.filesBase);
  const [attempt, setAttempt] = useState(0);
  const filesKey = `${base}|${artifact.files.map((f) => `${f.name}:${f.updatedAt}`).join("|")}`;
  const key = useMemo(() => `${hashOf(html)}-${hashOf(filesKey)}-${attempt}`, [html, filesKey, attempt]);
  const [phase, setPhase] = useState<{ key: string; value: "loading" | "shown" | "stuck" }>({ key, value: "loading" });
  const shown = phase.key === key ? phase.value : "loading";

  const handlersRef = useRef(handlers);
  // One token per frame: only the document it loaded can talk to the app.
  const [token] = useState(randomToken);
  const session = useRef({ lastData: "", pending: 0, saves: 0, queued: null as { data: unknown; ids: number[]; timer: ReturnType<typeof setTimeout> } | null });
  useLayoutEffect(() => {
    handlersRef.current = handlers;
  });
  useLayoutEffect(() => {
    session.current = { lastData: JSON.stringify(artifact.data ?? null), pending: 0, saves: 0, queued: null };
    return () => {
      if (session.current.queued) clearTimeout(session.current.queued.timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  // The document is built once per key: newer data and the theme go in as messages, without a reload.
  const doc = useMemo(
    () => webViewDocument(html, token, artifact.data, dark ? "dark" : "light", base ? { base, list: artifact.files } : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  const post = (message: Record<string, unknown>) => {
    const json = JSON.stringify({ ...message, __gm: token }).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, "");
    ref.current?.injectJavaScript(`window.postMessage(${json},"*");true;`);
  };

  useEffect(() => {
    const s = session.current;
    const text = JSON.stringify(artifact.data ?? null);
    if (shown === "loading" || s.pending > 0 || text === s.lastData) return;
    s.lastData = text;
    post({ type: "data", data: artifact.data ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact.data]);

  useEffect(() => {
    if (shown !== "loading") post({ type: "theme", theme: dark ? "dark" : "light" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark]);

  useEffect(() => {
    const stuck = setTimeout(() => setPhase((p) => (p.key === key && p.value === "loading" ? { key, value: "stuck" } : p)), STUCK_MS);
    return () => clearTimeout(stuck);
  }, [key]);

  const reply = (id: number | undefined, ok: boolean, error?: string) => post({ type: "reply", id, ok, error });

  const onMessage = (e: WebViewMessageEvent) => {
    let m: Outbound & { __gm?: string };
    try {
      m = JSON.parse(e.nativeEvent.data) as Outbound & { __gm?: string };
    } catch {
      return;
    }
    const s = session.current;
    if (!m || m.__gm !== token) return;
    const h = handlersRef.current;
    if (m.type === "ready") return setPhase({ key, value: "shown" });
    if (m.type === "setData") {
      if (!interactive || !h.onSetData) return reply(m.id, false, "This view can't save");
      s.lastData = JSON.stringify(m.data ?? null);
      s.pending++;
      const saveNumber = ++s.saves;
      if (s.queued) clearTimeout(s.queued.timer);
      const ids = [...(s.queued?.ids ?? []), m.id ?? 0];
      const timer = setTimeout(() => {
        const batch = s.queued!;
        s.queued = null;
        const done = (ok: boolean, error?: string) => {
          s.pending -= batch.ids.length;
          for (const id of batch.ids) reply(id, ok, error);
        };
        const save = () => (handlersRef.current.onSetData ?? (() => Promise.reject(new Error("This view can't save"))))(batch.data);
        save()
          .catch(
            () =>
              new Promise<void>((resolve, reject) =>
                setTimeout(() => {
                  if (s.saves !== saveNumber) resolve();
                  else save().then(resolve, reject);
                }, SAVE_RETRY_MS),
              ),
          )
          .then(
            () => done(true),
            (err: unknown) => {
              const message = err instanceof Error ? err.message : "Not saved";
              handlersRef.current.onSaveError?.(message);
              done(false, message);
            },
          );
      }, SAVE_DELAY_MS);
      s.queued = { data: m.data ?? null, ids, timer };
      return;
    }
    if (!interactive) return;
    if (m.type === "ask" && m.text?.trim()) h.onAsk?.(m.text.trim().slice(0, 500));
    else if (m.type === "refresh") h.onRefresh?.();
    else if (m.type === "error" && m.message) h.onError?.(m.message.slice(0, 300));
    else if (m.type === "reviewDone") {
      const whenSaved = () => (s.pending > 0 ? void setTimeout(whenSaved, 100) : handlersRef.current.onReviewDone?.());
      whenSaved();
    } else if (m.type === "viewFile" && typeof m.name === "string") {
      const file = artifact.files.find((f) => f.name === m.name);
      h.onViewFile?.(m.name, file && base ? base + encodeURIComponent(file.name) : null);
    } else if (m.type === "open" && m.url && /^(https?:\/\/|mailto:|tel:)/i.test(m.url)) void Linking.openURL(m.url);
  };

  return (
    <View style={[styles.wrap, style]}>
      <WebView
        key={key}
        ref={ref}
        source={{ html: doc }}
        originWhitelist={["*"]}
        onMessage={onMessage}
        javaScriptEnabled
        domStorageEnabled={false}
        incognito
        sharedCookiesEnabled={false}
        thirdPartyCookiesEnabled={false}
        allowFileAccess={false}
        allowsLinkPreview={false}
        setSupportMultipleWindows={false}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        scrollEnabled={interactive}
        pointerEvents={interactive ? "auto" : "none"}
        // Links leave through the bridge; the page itself never goes anywhere else.
        onShouldStartLoadWithRequest={(r) => {
          if (r.url === "about:blank" || r.url.startsWith("about:") || r.url.startsWith("data:") || r.url.startsWith("blob:")) return true;
          if (r.isTopFrame === false) return /^https:/i.test(r.url);
          if (r.navigationType === "click" && /^(https?:\/\/|mailto:|tel:)/i.test(r.url)) void Linking.openURL(r.url);
          return false;
        }}
        onContentProcessDidTerminate={() => setAttempt((n) => n + 1)}
        style={{ backgroundColor: "transparent" }}
        containerStyle={{ backgroundColor: c.background }}
      />
      {shown === "loading" && (
        <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: c.background }]}>
          <ActivityIndicator color={c.textMuted} />
        </View>
      )}
      {shown === "stuck" && (
        <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: c.background, padding: space.xl, gap: space.md }]}>
          <T variant="headline">{t("frame.stuckTitle")}</T>
          <T variant="footnote" muted style={{ textAlign: "center" }}>
            {t("frame.stuckBody")}
          </T>
          <Button title={t("frame.retry")} variant="secondary" icon="refresh" onPress={() => setAttempt((n) => n + 1)} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, overflow: "hidden" },
  center: { alignItems: "center", justifyContent: "center" },
});
