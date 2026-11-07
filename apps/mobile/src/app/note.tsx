import { useMutation, useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams, useNavigation } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { useEffect, useState } from "react";
import { Alert, RefreshControl, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { NOTES_DIR, failureText, nameOf } from "@/components/agent-actions";
import { NeedsFullAccessScreen } from "@/components/full-access";
import { HeaderActions } from "@/components/header-actions";
import { useRevealLocked } from "@/components/this-phone-access";
import { Markdown } from "@/components/markdown";
import { Card, ErrorState, LoadingState, T } from "@/components/ui";
import { api } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { qk, queryClient } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { fonts, radius, space, useColors } from "@/lib/theme";

const inNotes = (path: string | undefined): path is string => !!path && path.startsWith(`${NOTES_DIR}/`) && !path.split("/").includes("..");

/** "Client call notes" → "client-call-notes.md"; a name with its own extension keeps it. */
function fileName(name: string): string {
  const base = name
    .trim()
    .replace(/[\\/:*?"<>|\0]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^\.+/, "");
  return /\.[a-z0-9]{1,8}$/i.test(base) ? base : `${base}.md`;
}

/** One note under memory/: read as Markdown, edited as text. With `dir` instead of `path` a new note is written there. */
export default function Note() {
  const { t } = useTranslation(["agents", "common"]);
  const params = useLocalSearchParams<{ agentId: string; path?: string; dir?: string }>();
  const agentId = params.agentId;
  const locked = useRevealLocked(useAgents().byId.get(agentId));
  if (inNotes(params.path)) return <ExistingNote agentId={agentId} path={params.path} locked={locked} />;
  const dir = params.dir === NOTES_DIR || inNotes(params.dir) ? params.dir : NOTES_DIR;
  if (!params.path) {
    return locked ? (
      <>
        <Stack.Title>{t("notes.new")}</Stack.Title>
        <NeedsFullAccessScreen />
      </>
    ) : (
      <NewNote agentId={agentId} dir={dir} />
    );
  }
  return (
    <View style={{ flex: 1, justifyContent: "center" }}>
      <Stack.Title>{t("notes.note")}</Stack.Title>
      <ErrorState title={t("notes.openFailed")} error={t("notes.onlyNotes")} />
    </View>
  );
}

function ExistingNote({ agentId, path, locked }: { agentId: string; path: string; locked: boolean }) {
  const c = useColors();
  const { t } = useTranslation(["agents", "common"]);
  const { t: tc } = useTranslation("components");
  const navigation = useNavigation();
  const note = useQuery({ queryKey: qk.agentNote(agentId, path), queryFn: () => api.agents.note(agentId, path), refetchOnMount: "always" });
  const pull = usePullRefresh(note.refetch);
  /** The edit, and the text it started from. */
  const [draft, setDraft] = useState<{ text: string; base: string } | null>(null);
  const dirty = !!draft && draft.text !== draft.base;
  const markdown = /\.(md|markdown)$/i.test(path);

  const save = useMutation({
    mutationFn: (text: string) => api.agents.saveNote(agentId, path, text),
    onSuccess: (_, text) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      queryClient.setQueryData(qk.agentNote(agentId, path), { path, content: text });
      void queryClient.invalidateQueries({ queryKey: ["agents", agentId, "notes"] });
      void queryClient.invalidateQueries({ queryKey: qk.agentCommits(agentId) });
      setDraft(null);
    },
    onError: (err) => Alert.alert(t("notes.saveFailed"), failureText(err)),
  });

  usePreventRemove(dirty, ({ data }) => {
    Alert.alert(t("notes.discardTitle"), undefined, [
      { text: t("notes.keepEditing"), style: "cancel" },
      { text: t("notes.discard"), style: "destructive", onPress: () => navigation.dispatch(data.action) },
    ]);
  });

  const discard = () => {
    if (!dirty) return setDraft(null);
    Alert.alert(t("notes.discardTitle"), undefined, [
      { text: t("notes.keepEditing"), style: "cancel" },
      { text: t("notes.discard"), style: "destructive", onPress: () => setDraft(null) },
    ]);
  };

  if (!note.data) {
    return (
      <View style={{ flex: 1, justifyContent: "center" }}>
        <Stack.Screen options={{ title: nameOf(path), headerLargeTitleEnabled: false }} />
        {note.isError ? (
          <ErrorState title={t("notes.openFailed")} error={failureText(note.error)} onRetry={() => void note.refetch()} />
        ) : (
          <LoadingState />
        )}
      </View>
    );
  }
  const content = note.data.content;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      refreshControl={draft ? undefined : <RefreshControl {...pull} />}
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title: nameOf(path), headerLargeTitleEnabled: false }} />
      {draft ? (
        <HeaderActions
          actions={[{ icon: "check", label: t("common:actions.save"), prominent: true, onPress: () => !save.isPending && save.mutate(draft.text) }]}
          menu={[{ icon: "close", title: dirty ? t("notes.discardChanges") : t("notes.stopEditing"), onPress: discard, destructive: dirty }]}
        />
      ) : locked ? null : (
        <HeaderActions actions={[{ icon: "pencil", label: t("common:actions.edit"), onPress: () => setDraft({ text: content, base: content }) }]} />
      )}
      <T variant="footnote" muted numberOfLines={1} style={{ fontFamily: fonts.mono }}>
        {path}
      </T>
      {locked ? (
        <T variant="footnote" muted>
          {tc("fullAccess.title")}
        </T>
      ) : null}
      {draft ? (
        <View style={[styles.editor, { backgroundColor: c.surface, borderColor: c.borderStrong }]}>
          <TextInput
            accessibilityLabel={t("notes.editorLabel", { name: nameOf(path) })}
            value={draft.text}
            onChangeText={(text) => setDraft((d) => (d ? { ...d, text } : d))}
            multiline
            scrollEnabled={false}
            autoFocus
            editable={!save.isPending}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            style={[styles.input, { color: c.text }]}
          />
        </View>
      ) : !content.trim() ? (
        <T variant="subhead" muted style={{ paddingVertical: space.lg }}>
          {t("notes.emptyNote")}
        </T>
      ) : (
        <Card style={styles.reader}>{markdown ? <Markdown text={content} /> : <T style={styles.plain}>{content}</T>}</Card>
      )}
    </ScrollView>
  );
}

function NewNote({ agentId, dir }: { agentId: string; dir: string }) {
  const c = useColors();
  const { t } = useTranslation(["agents", "common"]);
  const navigation = useNavigation();
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const path = name.trim() ? `${dir}/${fileName(name)}` : null;
  const create = useMutation({
    mutationFn: (to: string) => api.agents.saveNote(agentId, to, text, true),
    onSuccess: (_, to) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void queryClient.invalidateQueries({ queryKey: ["agents", agentId, "notes"] });
      setSaved(to);
    },
    onError: (err) => Alert.alert(t("notes.saveFailed"), failureText(err)),
  });
  const dirty = !saved && (!!name.trim() || !!text.trim());
  // Once the guard is down: the new note opens in place of this screen.
  useEffect(() => {
    if (saved) router.replace({ pathname: "/note", params: { agentId, path: saved } });
  }, [saved, agentId]);

  usePreventRemove(dirty, ({ data }) => {
    Alert.alert(t("notes.discardTitle"), undefined, [
      { text: t("notes.keepEditing"), style: "cancel" },
      { text: t("notes.discard"), style: "destructive", onPress: () => navigation.dispatch(data.action) },
    ]);
  });

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title: t("notes.new"), headerLargeTitleEnabled: false }} />
      <HeaderActions actions={[{ icon: "check", label: t("common:actions.save"), prominent: true, onPress: () => path && !create.isPending && create.mutate(path) }]} />
      <View style={[styles.editor, { backgroundColor: c.surface, borderColor: c.border }]}>
        <TextInput
          accessibilityLabel={t("notes.name")}
          value={name}
          onChangeText={setName}
          placeholder={t("notes.namePlaceholder")}
          placeholderTextColor={c.textFaint}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={120}
          returnKeyType="next"
          style={[styles.name, { color: c.text }]}
        />
        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border }} />
        <TextInput
          accessibilityLabel={t("notes.editorLabel", { name: name || t("notes.new") })}
          value={text}
          onChangeText={setText}
          placeholder={t("notes.textPlaceholder")}
          placeholderTextColor={c.textFaint}
          multiline
          scrollEnabled={false}
          autoCapitalize="sentences"
          style={[styles.input, { color: c.text }]}
        />
      </View>
      {path ? (
        <T variant="footnote" muted numberOfLines={1} style={{ fontFamily: fonts.mono, paddingHorizontal: 4 }}>
          {path}
        </T>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 80,
    gap: space.md,
  },
  editor: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  name: {
    fontSize: 17,
    fontWeight: "600",
    paddingHorizontal: space.md,
    paddingVertical: 14,
  },
  input: {
    minHeight: 320,
    padding: space.md,
    fontFamily: fonts.mono,
    fontSize: 13,
    lineHeight: 20,
    textAlignVertical: "top",
  },
  reader: {
    padding: space.lg,
    gap: space.md,
  },
  plain: {
    fontFamily: fonts.mono,
    fontSize: 13,
    lineHeight: 20,
  },
});
