import { useMutation, useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { Icon } from "@/components/icon";
import { FieldCard, SheetHeader } from "@/components/secret-parts";
import { LoadingState, T } from "@/components/ui";
import { errorText } from "@/lib/api";
import { fileChanged, filesApi, fk, joinPath, nameOf, nameProblem, noteFile, parentOf, pinsAmong, refreshFiles, type NameKind } from "@/lib/agent-files";
import { fonts, radius, space, useColors } from "@/lib/theme";

/** A new note or folder in a folder of an agent, or a new name for a file or folder; nothing already there is overwritten. */
export default function NameSheet() {
  const c = useColors();
  const { fullAccess } = useFullAccess();
  const { agent, mode, path, dir } = useLocalSearchParams<{ agent: string; mode: NameKind; path?: string; dir?: string }>();
  const folder = mode === "rename" ? parentOf(path ?? "") : (dir ?? "");
  if (fullAccess === false) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        <NeedsFullAccess />
      </View>
    );
  }
  if (fullAccess === undefined) return <LoadingState />;
  return <NameForm agent={agent} mode={mode === "rename" || mode === "folder" ? mode : "note"} path={path ?? ""} dir={folder} />;
}

function NameForm({ agent, mode, path, dir }: { agent: string; mode: NameKind; path: string; dir: string }) {
  const c = useColors();
  const { t } = useTranslation(["files", "common"]);
  const current = mode === "rename" ? nameOf(path) : undefined;
  const [name, setName] = useState(() => current ?? (mode === "note" ? t("name.defaultNote") : t("name.defaultFolder")));
  // Like the desktop: the name starts selected up to its extension, so typing replaces just the name.
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>(() => {
    const dot = name.lastIndexOf(".");
    return { start: 0, end: mode !== "folder" && dot > 0 ? dot : name.length };
  });
  const listing = useQuery({ queryKey: fk.list(agent, dir), queryFn: () => filesApi.list(agent, dir) });
  const info = useQuery({ queryKey: fk.inspect(agent, [path]), queryFn: () => filesApi.inspect(agent, [path]), enabled: mode === "rename", gcTime: 0, staleTime: 0 });
  const taken = useMemo(() => new Set((listing.data ?? []).map((e) => nameOf(e.path).toLowerCase())), [listing.data]);
  const problem = nameProblem(name, taken, mode, current);
  const pins = pinsAmong(info.data?.[0]?.namedBy ?? []);

  const submit = useMutation({
    mutationFn: async () => {
      const n = name.trim();
      if (mode === "rename") {
        const moved = await filesApi.move(agent, path, joinPath(dir, n));
        return { kind: "rename" as const, to: moved.path, rewritten: moved.rewritten };
      }
      if (mode === "folder") {
        const made = await filesApi.createFolder(agent, joinPath(dir, n));
        return { kind: "folder" as const, to: made.path, rewritten: [] };
      }
      const file = noteFile(n);
      const to = joinPath(dir, file);
      const title = file.replace(/\.(md|markdown|txt)$/i, "").replace(/[-_]+/g, " ");
      // Create-only: if something took the name meanwhile, the computer says so instead of overwriting it.
      await filesApi.write(agent, to, /\.txt$/i.test(file) ? "" : `# ${title.charAt(0).toUpperCase()}${title.slice(1)}\n\n`, true);
      return { kind: "note" as const, to, rewritten: [] };
    },
    onSuccess: ({ kind, to, rewritten }) => {
      refreshFiles(agent);
      router.back();
      if (kind === "rename") {
        fileChanged({ agentId: agent, moves: [{ from: path, to }] });
        if (rewritten.length) Alert.alert(t("move.renamedTo", { name: nameOf(to) }), t("move.pathUpdated", { files: rewritten.join(", ") }));
      } else fileChanged({ agentId: agent, created: to, kind });
    },
    onError: (err) => Alert.alert(mode === "rename" ? t("name.renameFailed") : t("name.createFailed"), errorText(err)),
  });

  const unchanged = mode === "rename" && name.trim() === current;
  const ready = !problem && !listing.isLoading && !unchanged;
  const title = mode === "rename" ? t("name.titleRename", { name: current }) : mode === "note" ? t("name.titleNote") : t("name.titleFolder");

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <SheetHeader
        title={title}
        action={mode === "rename" ? t("common:actions.rename") : t("common:actions.create")}
        ready={ready}
        busy={submit.isPending}
        onAction={() => submit.mutate()}
      />
      <View style={{ gap: space.sm }}>
        <FieldCard>
          <TextInput
            accessibilityLabel={t("common:words.name")}
            value={name}
            onChangeText={setName}
            selection={selection}
            onSelectionChange={(e) => {
              const now = e.nativeEvent.selection;
              if (selection && (now.start !== selection.start || now.end !== selection.end)) setSelection(undefined);
            }}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            maxLength={200}
            returnKeyType="done"
            submitBehavior="blurAndSubmit"
            onSubmitEditing={() => ready && !submit.isPending && submit.mutate()}
            style={[styles.input, { color: c.text }]}
          />
        </FieldCard>
        {problem && name ? (
          <T variant="footnote" color={c.danger} style={styles.note}>
            {problem}
          </T>
        ) : null}
        <T variant="footnote" muted numberOfLines={2} style={[styles.note, { fontFamily: fonts.mono }]}>
          {t("name.in", { dir: dir || t("name.theRepository") })}
        </T>
        {pins.length ? (
          <View style={[styles.note, { flexDirection: "row", gap: space.sm }]}>
            <Icon name="warning" size={13} color={c.warning} />
            <T variant="footnote" muted style={{ flex: 1 }}>
              {t("name.pinned", { names: pins.slice(0, 2).join(", ") })}
            </T>
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: "center" },
  content: { padding: space.xl, paddingBottom: 48, gap: space.lg },
  note: { paddingHorizontal: space.xs },
  input: { fontFamily: fonts.mono, fontSize: 15, paddingHorizontal: space.lg, paddingVertical: 13, borderRadius: radius.lg },
});
