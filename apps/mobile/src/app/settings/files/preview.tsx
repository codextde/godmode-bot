import { useMutation, useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { Stack, useLocalSearchParams, useNavigation } from "expo-router";
import { useHeaderHeight, usePreventRemove } from "expo-router/react-navigation";
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, TextInput, useWindowDimensions, View, type TextInputInstance } from "react-native";
import RNWebView, { type WebViewProps } from "react-native-webview";
import { useTranslation } from "react-i18next";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { entryActions, useDreamingNow } from "@/components/file-actions";
import { useFullAccess } from "@/components/full-access";
import { HeaderActions, type HeaderMenuItem } from "@/components/header-actions";
import { Icon } from "@/components/icon";
import { Markdown } from "@/components/markdown";
import { EmptyState, ErrorState, T } from "@/components/ui";
import { ApiError, errorText, pictureBases } from "@/lib/api";
import {
  fileKind,
  filesApi,
  fk,
  forgetLocalCopies,
  isMemoryPath,
  localCopy,
  localTextCopy,
  movedPath,
  nameOf,
  onFileChange,
  rawPath,
  readOnlyReason,
  refreshFiles,
  shareFile,
  viewable,
  wasDeleted,
  type FileKind,
} from "@/lib/agent-files";
import { useAgents } from "@/lib/hooks";
import { queryClient } from "@/lib/query";
import { useSession } from "@/lib/session";
import { fonts, space, useColors } from "@/lib/theme";

/** Its class defaults its extra props to `undefined`, which TypeScript 6 turns into `never`. */
const WebView = RNWebView as unknown as ComponentType<WebViewProps>;

/** Long files show their beginning: a phone screen doesn't need two megabytes of log. */
const MAX_SHOWN = 200_000;

/** The file changed on the computer since the edit started: saving would overwrite someone else's change. */
class StaleDraftError extends Error {}

/**
 * A file of an agent's folder: text, Markdown and code as text, pictures and PDFs as they are, shared from here. With
 * full access a text file is edited in place (as plain text, like the desktop's source view), renamed, moved or deleted.
 */
export default function FilePreview() {
  const c = useColors();
  const { t } = useTranslation(["files", "common"]);
  const navigation = useNavigation();
  const headerHeight = useHeaderHeight();
  const { agent, path, edit } = useLocalSearchParams<{ agent: string; path: string; edit?: string }>();
  const kind = fileKind({ path, type: "file" });
  const agentName = useAgents().byId.get(agent)?.name ?? t("folder.theAgent");
  const { fullAccess } = useFullAccess();
  const frozen = useDreamingNow(agent);
  // This screen's own folder in the cache: what it fetched to show or share leaves the phone with it.
  const [slot] = useState(() => Math.random().toString(36).slice(2, 10));
  useEffect(() => () => forgetLocalCopies(slot), [slot]);
  const text = useQuery({ queryKey: fk.file(agent, path), queryFn: () => filesApi.read(agent, path), enabled: !viewable(kind), retry: false, gcTime: 0 });
  /** The edit, and the file's content it started from (a rewrite underneath isn't silently overwritten). */
  const [draft, setDraft] = useState<{ text: string; base: string } | null>(null);
  const dirty = !!draft && draft.text !== draft.base;
  const content = text.data?.content;
  const fixed = content === undefined ? null : readOnlyReason(path, content.length);
  const dreamLock = frozen && isMemoryPath(path);
  const canEdit = fullAccess === true && content !== undefined && !fixed && !dreamLock;
  // Opened right after "New note": straight into the editor.
  const [startEditing, setStartEditing] = useState(edit === "1");
  if (startEditing && canEdit && content !== undefined) {
    setStartEditing(false);
    setDraft({ text: content, base: content });
  }

  // Renamed or moved from its menu: the screen follows it; deleted: back to the folder.
  useEffect(
    () =>
      onFileChange((change) => {
        if (change.agentId !== agent) return;
        // This screen's own navigation: the sheet that changed it may still be the focused route.
        if ("moves" in change) {
          const to = movedPath(path, change.moves);
          if (to) navigation.setParams({ path: to } as never);
        } else if ("deleted" in change && wasDeleted(path, change.deleted) && navigation.canGoBack()) navigation.goBack();
      }),
    [agent, path, navigation],
  );

  // After the screen settled: focusing during its way in scrolls the first lines under the header.
  const input = useRef<TextInputInstance>(null);
  const editing = !!draft;
  useEffect(() => {
    if (!editing) return;
    const timer = setTimeout(() => input.current?.focus(), 350);
    return () => clearTimeout(timer);
  }, [editing]);

  const share = useMutation({
    mutationFn: async () => {
      if (text.data) return shareFile(localTextCopy(slot, path, text.data.content), text.data.content);
      return shareFile(await localCopy(agent, path, slot));
    },
    onError: (err) => Alert.alert(t("preview.shareFailed"), errorText(err)),
  });
  const canShare = viewable(kind) || !!text.data;

  const save = useMutation({
    mutationFn: async ({ value, base }: { value: string; base: string | null }) => {
      // Not every writer announces itself (a run may rewrite the file): it must still be what the edit started from.
      if (base !== null) {
        const fresh = await filesApi.read(agent, path).catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 404) return { path, content: "" };
          throw err;
        });
        if (fresh.content !== base) {
          queryClient.setQueryData(fk.file(agent, path), fresh);
          throw new StaleDraftError();
        }
      }
      await filesApi.write(agent, path, value);
      return value;
    },
    onSuccess: (value) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      queryClient.setQueryData(fk.file(agent, path), { path, content: value });
      refreshFiles(agent);
      setDraft(null);
    },
    onError: (err) => {
      if (err instanceof StaleDraftError) {
        Alert.alert(t("editor.conflictTitle", { name: nameOf(path) }), t("editor.conflictBody", { agent: agentName }), [
          { text: t("common:actions.cancel"), style: "cancel" },
          { text: t("editor.reload"), onPress: () => setDraft(null) },
          { text: t("editor.overwrite"), style: "destructive", onPress: () => draft && save.mutate({ value: draft.text, base: null }) },
        ]);
        return;
      }
      Alert.alert(t("editor.saveFailed", { name: nameOf(path) }), errorText(err));
    },
  });

  usePreventRemove(dirty, ({ data }) => {
    Alert.alert(t("editor.discardTitle"), undefined, [
      { text: t("editor.keepEditing"), style: "cancel" },
      { text: t("editor.discard"), style: "destructive", onPress: () => navigation.dispatch(data.action) },
    ]);
  });

  const stopEditing = () => {
    if (!dirty) return setDraft(null);
    Alert.alert(t("editor.discardTitle"), undefined, [
      { text: t("editor.keepEditing"), style: "cancel" },
      { text: t("editor.discard"), style: "destructive", onPress: () => setDraft(null) },
    ]);
  };

  const menu: HeaderMenuItem[] = draft
    ? [{ icon: "close", title: dirty ? t("editor.discardChanges") : t("editor.stopEditing"), destructive: dirty, onPress: stopEditing }]
    : [
        ...(canShare ? [{ icon: "share" as const, title: t("preview.share"), onPress: () => !share.isPending && share.mutate() }] : []),
        ...(fullAccess ? entryActions(agent, path, frozen) : []),
      ];

  return (
    <>
      <Stack.Screen options={{ title: nameOf(path), headerLargeTitleEnabled: false }} />
      {draft ? (
        <HeaderActions
          actions={[{ icon: "check", label: t("common:actions.save"), prominent: true, onPress: () => dirty && !save.isPending && save.mutate({ value: draft.text, base: draft.base }) }]}
          menu={menu}
        />
      ) : (
        <HeaderActions actions={canEdit ? [{ icon: "pencil", label: t("common:actions.edit"), onPress: () => setDraft({ text: content!, base: content! }) }] : []} menu={menu} />
      )}
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
      ) : draft ? (
        // The text view scrolls itself: a long file stays smooth, and the caret never slides under the header.
        <KeyboardAvoidingView behavior="padding" style={[styles.editor, { paddingTop: process.env.EXPO_OS === "ios" ? headerHeight : 0 }]}>
          <TextInput
            ref={input}
            accessibilityLabel={t("editor.editorLabel", { path })}
            value={draft.text}
            onChangeText={(next) => setDraft((d) => (d ? { ...d, text: next } : d))}
            multiline
            editable={!save.isPending}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={kind === "markdown"}
            style={[styles.input, { color: c.text }]}
          />
        </KeyboardAvoidingView>
      ) : text.data ? (
        <TextView kind={kind} content={text.data.content} note={fullAccess && (fixed ?? (dreamLock ? t("editor.dreaming", { name: agentName }) : null))} />
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

function TextView({ kind, content, note }: { kind: FileKind; content: string; note?: string | null | false }) {
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
      {note ? (
        <View style={styles.note}>
          <Icon name="lock" size={12} color={c.textMuted} />
          <T variant="footnote" muted style={{ flex: 1 }}>
            {note}
          </T>
        </View>
      ) : null}
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
  note: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  editor: {
    flex: 1,
  },
  input: {
    flex: 1,
    padding: space.lg,
    paddingTop: space.md,
    fontFamily: fonts.mono,
    fontSize: 13,
    lineHeight: 20,
    textAlignVertical: "top",
  },
});
