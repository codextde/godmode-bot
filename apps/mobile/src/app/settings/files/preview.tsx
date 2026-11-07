import { useMutation, useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { Stack, useLocalSearchParams, useNavigation } from "expo-router";
import { useHeaderHeight, usePreventRemove } from "expo-router/react-navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput, useWindowDimensions, View, type TextInputInstance } from "react-native";
import { useTranslation } from "react-i18next";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { entryActions, revealItem, useCanShowOnComputer, useDreamingNow } from "@/components/file-actions";
import { useFullAccess } from "@/components/full-access";
import { HeaderActions, MenuSheet, type HeaderMenuItem } from "@/components/header-actions";
import { Icon } from "@/components/icon";
import { Markdown } from "@/components/markdown";
import { MemoryBudget } from "@/components/memory-budget";
import { PdfPage } from "@/components/pdf-page";
import { EmptyState, ErrorState, T } from "@/components/ui";
import { api, ApiError, errorText, pictureBases } from "@/lib/api";
import {
  fileKind,
  filesApi,
  fk,
  brokenMemoryLinks,
  forgetLocalCopies,
  isMemoryPath,
  localCopy,
  localTextCopy,
  memorySections,
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
import { intlLocale } from "@/lib/i18n";
import { qk, queryClient } from "@/lib/query";
import { FILES_SAVE_TO_FOLDER } from "@/lib/save-file";
import { useSession } from "@/lib/session";
import { fonts, space, useColors } from "@/lib/theme";

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
  const insets = useSafeAreaInsets();
  const keyboardOpen = useKeyboardState((s) => s.isVisible);
  const { agent, path = "", edit } = useLocalSearchParams<{ agent: string; path?: string; edit?: string }>();
  const kind = fileKind({ path, type: "file" });
  const owner = useAgents().byId.get(agent);
  const agentName = owner?.name ?? t("folder.theAgent");
  const { fullAccess } = useFullAccess();
  const canShow = useCanShowOnComputer();
  const frozen = useDreamingNow(agent);
  // This screen's own folder in the cache: what it fetched to show or share leaves the phone with it.
  const [slot] = useState(() => Math.random().toString(36).slice(2, 10));
  useEffect(() => () => forgetLocalCopies(slot), [slot]);
  const text = useQuery({ queryKey: fk.file(agent, path), queryFn: () => filesApi.read(agent, path), enabled: !viewable(kind), retry: false, gcTime: 0 });
  /** The edit, and the file's content it started from (a rewrite underneath isn't silently overwritten). */
  const [draft, setDraft] = useState<{ text: string; base: string } | null>(null);
  const dirty = !!draft && draft.text !== draft.base;
  /** Markdown being written: how it reads, in place of the desktop's split view. */
  const [reading, setReading] = useState(false);
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const isMemory = path === "MEMORY.md";
  const memory = useQuery({ queryKey: qk.agentMemory(agent), queryFn: () => api.agents.memory(agent), enabled: isMemory && !!draft });
  const sections = kind === "markdown" && draft ? memorySections(draft.text) : [];
  const broken = isMemory && draft && memory.data ? brokenMemoryLinks(draft.text, memory.data.topics) : [];
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
  const canSave = canShare && FILES_SAVE_TO_FOLDER && !text.data;

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
      setReading(false);
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

  const jumpTo = (line: number) => {
    if (!draft) return;
    const offset = draft.text.split("\n").slice(0, line).reduce((n, l) => n + l.length + 1, 0);
    setReading(false);
    // The caret takes the view there; it needs the text view back first when the preview was up.
    setTimeout(() => {
      input.current?.focus();
      input.current?.setSelection(offset, offset);
    }, 60);
  };

  const stopEditing = () => {
    setReading(false);
    if (!dirty) return setDraft(null);
    Alert.alert(t("editor.discardTitle"), undefined, [
      { text: t("editor.keepEditing"), style: "cancel" },
      { text: t("editor.discard"), style: "destructive", onPress: () => setDraft(null) },
    ]);
  };

  const menu: HeaderMenuItem[] = draft
    ? [
        ...(sections.length > 1 ? [{ icon: "list" as const, title: t("editor.sections"), onPress: () => setSectionsOpen(true) }] : []),
        { icon: "close", title: dirty ? t("editor.discardChanges") : t("editor.stopEditing"), destructive: dirty, onPress: stopEditing },
      ]
    : [
        ...(canShare && !canSave ? [{ icon: "share" as const, title: t("preview.share"), onPress: () => !share.isPending && share.mutate() }] : []),
        ...(canShow && owner && path ? [revealItem(`${owner.repoPath}/${path}`)] : []),
        ...(fullAccess && path ? entryActions(agent, path, frozen) : []),
      ];

  return (
    <>
      <Stack.Screen options={{ title: nameOf(path), headerLargeTitleEnabled: false }} />
      {draft ? (
        <HeaderActions
          actions={[
            ...(kind === "markdown" ? [{ icon: reading ? ("pencil" as const) : ("eye" as const), label: reading ? t("common:actions.edit") : t("editor.preview"), onPress: () => setReading((v) => !v) }] : []),
            { icon: "check", label: t("common:actions.save"), prominent: true, onPress: () => dirty && !save.isPending && save.mutate({ value: draft.text, base: draft.base }) },
          ]}
          menu={menu}
        />
      ) : (
        <HeaderActions
          actions={[
            ...(canEdit ? [{ icon: "pencil" as const, label: t("common:actions.edit"), onPress: () => setDraft({ text: content!, base: content! }) }] : []),
            ...(canSave ? [{ icon: "download" as const, label: t("common:actions.save"), onPress: () => !share.isPending && share.mutate() }] : []),
          ]}
          menu={menu}
        />
      )}
      {kind === "image" ? (
        <ImageView agent={agent} path={path} />
      ) : kind === "pdf" ? (
        <PdfView agent={agent} path={path} slot={slot} />
      ) : draft && reading ? (
        <TextView kind={kind} content={draft.text} />
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
          <EditorStatus text={draft.text} words={kind === "markdown"} broken={broken} />
          {isMemory && memory.data ? (
            <View style={styles.budget}>
              <MemoryBudget chars={draft.text.length} memory={memory.data} />
            </View>
          ) : null}
          <View style={{ height: keyboardOpen ? 0 : insets.bottom }} />
        </KeyboardAvoidingView>
      ) : text.isLoading ? (
        <Centered>
          <ActivityIndicator />
        </Centered>
      ) : text.isError ? (
        <Centered>
          <TextError error={text.error} onRetry={() => void text.refetch()} />
        </Centered>
      ) : text.data ? (
        <TextView kind={kind} content={text.data.content} note={fullAccess && (fixed ?? (dreamLock ? t("editor.dreaming", { name: agentName }) : null))} />
      ) : null}
      <MenuSheet items={sections.slice(0, 12).map((s) => ({ icon: "doc" as const, title: s.title, onPress: () => jumpTo(s.line) }))} open={sectionsOpen} onClose={() => setSectionsOpen(false)} />
    </>
  );
}

/** Under the editor: how long it is and, in MEMORY.md, links to notes that don't exist. */
function EditorStatus({ text, words, broken }: { text: string; words: boolean; broken: string[] }) {
  const c = useColors();
  const { t } = useTranslation("files");
  const lines = text ? text.split("\n").length : 0;
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
  return (
    <View style={[styles.status, { borderTopColor: c.border }]}>
      <T variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
        {[t("editor.lines", { count: lines, n: lines.toLocaleString(intlLocale()) }), words ? t("editor.words", { count: wordCount, n: wordCount.toLocaleString(intlLocale()) }) : null].filter(Boolean).join(" · ")}
      </T>
      {broken.length ? (
        <Pressable accessibilityRole="button" hitSlop={8} onPress={() => Alert.alert(t("editor.missingNotes"), broken.join("\n"))} style={styles.broken}>
          <Icon name="warning" size={12} color={c.warning} />
          <T variant="caption" color={c.warning}>
            {t("editor.brokenLinks", { count: broken.length })}
          </T>
        </Pressable>
      ) : null}
    </View>
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

/** A PDF fetched into the app's cache. */
function PdfView({ agent, path, slot }: { agent: string; path: string; slot: string }) {
  const { t } = useTranslation("files");
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
  return <PdfPage file={file.data} />;
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
  status: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  broken: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  budget: {
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
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
