import { usePreventRemove } from "expo-router/react-navigation";
import { Stack, useLocalSearchParams, useNavigation } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { MAX_MOD_FILES, MOD_HOOKS_PATH, MOD_MANIFEST_PATH, modPathProblem, type Mod, type ModCheck } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { NeedsFullAccessScreen } from "@/components/full-access";
import { FullAccessGate, isRefused } from "@/components/admin";
import { Group, PickerRow } from "@/components/form";
import { HeaderActions, type HeaderMenuItem } from "@/components/header-actions";
import { Icon } from "@/components/icon";
import { CopyButton } from "@/components/secret-parts";
import { TextPrompt } from "@/components/text-prompt";
import { Button, ErrorState, LoadingState, Row, T, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { usePlugins } from "@/lib/integrations";
import { pluginsAdmin, putPlugin, tooLarge } from "@/lib/plugins-admin";
import { copyPlain } from "@/lib/secrets";
import { fonts, radius, space, useColors } from "@/lib/theme";

type Files = Record<string, string>;

/** Always there: they can't be renamed or deleted. */
const FIXED = new Set([MOD_MANIFEST_PATH, MOD_HOOKS_PATH]);

function sameFiles(a: Files, b: Files): boolean {
  if (a === b) return true;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/** The manifest first, then the hooks, then the rest by path. */
function sortedPaths(files: Files): string[] {
  const rank = (p: string) => (p === MOD_MANIFEST_PATH ? 0 : p === MOD_HOOKS_PATH ? 1 : 2);
  return Object.keys(files).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** The code of a small plugin (the ones Godmode keeps itself), read and changed like the desktop's code tab; saving checks it again. */
export default function PluginCode() {
  const { t } = useTranslation("tools");
  const { id } = useLocalSearchParams<{ id: string }>();
  const list = usePlugins();
  const mod = list.data?.find((m) => m.id === id);
  return (
    <>
      <Stack.Screen options={{ title: t("pluginAdmin.codeTitle"), headerLargeTitleEnabled: false }} />
      <CloseButton />
      <FullAccessGate locked={<NeedsFullAccessScreen />}>
        {mod && !mod.source ? (
          <CodeEditor key={mod.id} mod={mod} />
        ) : list.isLoading ? (
          <LoadingState />
        ) : (
          <ErrorState title={list.isError ? t("pluginAdmin.loadFailed") : t("pluginAdmin.notFound")} error={list.isError ? errorText(list.error) : t("pluginAdmin.maybeDeleted")} onRetry={() => void list.refetch()} />
        )}
      </FullAccessGate>
    </>
  );
}

function CodeEditor({ mod }: { mod: Mod }) {
  const c = useColors();
  const { t } = useTranslation(["tools", "components", "common"]);
  const { byId } = useAgents();
  const [base, setBase] = useState<Files>(mod.files);
  const [files, setFiles] = useState<Files>(mod.files);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ check: ModCheck | null; revision: number } | null>(null);
  const [busy, setBusy] = useState<"save" | "check" | null>(null);
  const paths = useMemo(() => sortedPaths(files), [files]);
  const [picked, setPicked] = useState<string | null>(null);
  const path = picked && picked in files ? picked : (paths.find((p) => p.endsWith(".ts") || p.endsWith(".js")) ?? paths[0] ?? null);
  const dirty = !sameFiles(files, base);
  // Follows the saved files while nothing is edited (an agent or another window may change them), keeps the edits once there are some.
  if (base !== mod.files && !dirty) {
    setBase(mod.files);
    setFiles(mod.files);
  }
  const stale = dirty && !sameFiles(base, mod.files);
  const [naming, setNaming] = useState<{ from: string | null } | null>(null);
  const navigation = useNavigation();
  usePreventRemove(dirty, ({ data }) => {
    Alert.alert(t("pluginAdmin.codeFiles.discardTitle"), t("pluginAdmin.codeFiles.discardDescription", { title: mod.title }), [
      { text: t("pluginAdmin.codeFiles.keepEditing"), style: "cancel" },
      { text: t("pluginAdmin.codeFiles.discard"), style: "destructive", onPress: () => navigation.dispatch(data.action) },
    ]);
  });
  const edit = (next: (f: Files) => Files) => {
    setFiles(next);
    setRevision((r) => r + 1);
  };
  const nameProblem = (next: string, renaming: string | null) => {
    if (!next) return t("pluginAdmin.codeFiles.enterPath");
    const refused = modPathProblem(next);
    if (refused) return refused;
    if (next !== renaming && next in files) return t("pluginAdmin.codeFiles.pathExists");
    if (!renaming && paths.length >= MAX_MOD_FILES) return t("pluginAdmin.codeFiles.maxFiles", { max: MAX_MOD_FILES });
    return null;
  };
  const named = (next: string) => {
    const from = naming?.from ?? null;
    setNaming(null);
    if (from === next) return;
    if (from === null) edit((f) => ({ ...f, [next]: "" }));
    else edit((f) => Object.fromEntries(Object.entries(f).map(([p, content]) => [p === from ? next : p, content])));
    setPicked(next);
  };
  const removeFile = (target: string) =>
    Alert.alert(t("pluginAdmin.codeFiles.deleteTitle", { path: target }), t("pluginAdmin.codeFiles.deleteDescription"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      { text: t("pluginAdmin.codeFiles.deleteFile"), style: "destructive", onPress: () => edit((f) => Object.fromEntries(Object.entries(f).filter(([p]) => p !== target))) },
    ]);
  const fileMenu: HeaderMenuItem[] = [
    { icon: "plus", title: t("pluginAdmin.codeFiles.newFile"), onPress: () => setNaming({ from: null }) },
    ...(path && !FIXED.has(path)
      ? [
          { icon: "pencil" as const, title: t("pluginAdmin.codeFiles.renameFile"), onPress: () => setNaming({ from: path }) },
          { icon: "trash" as const, title: t("pluginAdmin.codeFiles.deleteFile"), destructive: true, onPress: () => removeFile(path) },
        ]
      : []),
  ];
  const author = mod.createdBy.startsWith("agent:") ? (byId.get(mod.createdBy.slice(6))?.name ?? t("pluginAdmin.anAgent")) : null;

  const guard = () => {
    const problem = tooLarge(files);
    if (problem) Alert.alert(t("pluginAdmin.code.tooLarge"), problem);
    return !problem;
  };
  const fail = (title: string, err: unknown) => Alert.alert(isRefused(err) ? t("components:fullAccess.title") : title, isRefused(err) ? undefined : errorText(err));

  const save = async () => {
    if (busy || !dirty || !guard()) return;
    setBusy("save");
    try {
      const next = await pluginsAdmin.update(mod.id, { files });
      putPlugin(next);
      setBase(next.files);
      setFiles(next.files);
      setResult(null);
      tap();
      if (!next.check) Alert.alert(t("pluginAdmin.code.saved"), t("pluginAdmin.code.savedUnchecked"));
      else if (!next.check.ok) Alert.alert(t("pluginAdmin.code.savedFailed"), t("pluginAdmin.code.savedFailedDescription"));
    } catch (err) {
      fail(t("pluginAdmin.code.saveFailed"), err);
    } finally {
      setBusy(null);
    }
  };
  const check = async () => {
    if (busy || !guard()) return;
    setBusy("check");
    const at = revision;
    try {
      const res = await pluginsAdmin.checkFiles(files);
      setResult({ check: res.check, revision: at });
    } catch (err) {
      fail(t("pluginAdmin.code.checkFailed"), err);
    } finally {
      setBusy(null);
    }
  };

  const shown = result ? result.check : mod.check;
  const note = result ? (result.revision !== revision ? t("pluginAdmin.code.noteBeforeEdit") : dirty ? t("pluginAdmin.code.noteDraft") : t("pluginAdmin.code.noteSaved")) : dirty ? t("pluginAdmin.code.noteSavedUnchecked") : t("pluginAdmin.code.noteSaved");
  const text = path ? (files[path] ?? "") : "";

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets>
      <HeaderActions
        actions={[
          ...(busy ? [] : [{ icon: "shield" as const, label: t("pluginAdmin.code.check"), onPress: () => void check() }]),
          ...(dirty && !busy ? [{ icon: "check" as const, label: t("pluginAdmin.code.save"), prominent: true, onPress: () => void save() }] : []),
        ]}
        menu={busy ? [] : fileMenu}
      />
      <TextPrompt
        open={!!naming}
        title={naming?.from ? t("pluginAdmin.codeFiles.newPathFor", { path: naming.from }) : t("pluginAdmin.codeFiles.newFilePath")}
        initial={naming?.from ?? ""}
        placeholder="hooks/helper.ts"
        mono
        validate={(next) => nameProblem(next, naming?.from ?? null)}
        onSubmit={named}
        onClose={() => setNaming(null)}
      />
      {stale ? (
        <View style={[styles.notice, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Icon name="warning" size={14} color={c.textMuted} />
          <View style={{ flex: 1, gap: space.sm }}>
            <T variant="footnote" style={{ fontWeight: "600" }}>
              {t("pluginAdmin.codeFiles.staleTitle")}
            </T>
            <T variant="footnote" muted>
              {t("pluginAdmin.codeFiles.staleHint")}
            </T>
            <Button
              title={t("pluginAdmin.codeFiles.loadSaved")}
              variant="secondary"
              onPress={() => {
                setBase(mod.files);
                setFiles(mod.files);
              }}
            />
          </View>
        </View>
      ) : null}
      {mod.needsReview && author ? (
        <View style={[styles.notice, { backgroundColor: c.warningSoft, borderColor: c.warning }]}>
          <Icon name="warning" size={14} color={c.warning} />
          <View style={{ flex: 1, gap: 2 }}>
            <T variant="footnote" style={{ fontWeight: "600" }}>
              {t("pluginAdmin.code.authorWrote", { author })}
            </T>
            <T variant="footnote" muted>
              {t("pluginAdmin.code.reviewHint")}
            </T>
          </View>
        </View>
      ) : null}

      {path === null ? (
        <T variant="subhead" muted>
          {t("pluginAdmin.code.noFiles")}
        </T>
      ) : (
        <View style={{ gap: space.sm }}>
          {paths.length > 1 ? (
            <Group>
              <PickerRow icon="doc" title={t("pluginAdmin.code.file")} value={path} options={paths.map((p) => ({ value: p, label: p.split("/").pop() ?? p, detail: p }))} onChange={setPicked} />
            </Group>
          ) : null}
          <View style={[styles.editor, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Row style={[styles.editorHead, { borderBottomColor: c.border }]}>
              <T variant="caption" style={{ flex: 1, fontFamily: fonts.mono }} numberOfLines={1}>
                {path}
              </T>
              {files[path] !== base[path] ? <View style={[styles.dot, { backgroundColor: c.textMuted }]} /> : null}
              <T variant="caption" muted>
                {t("pluginAdmin.code.lines", { count: text.split("\n").length })}
              </T>
              <CopyButton label={t("pluginAdmin.code.copyFile")} copy={() => copyPlain(text)} />
            </Row>
            <TextInput
              accessibilityLabel={t("pluginAdmin.code.editorLabel", { path })}
              value={text}
              onChangeText={(next) => {
                setFiles((f) => ({ ...f, [path]: next }));
                setRevision((r) => r + 1);
              }}
              multiline
              editable={busy !== "save"}
              scrollEnabled={false}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              smartInsertDelete={false}
              textContentType="none"
              keyboardType="ascii-capable"
              style={[styles.code, { color: c.text }]}
            />
          </View>
        </View>
      )}

      <Group title={t("pluginAdmin.checkTitle")} footer={note}>
        <Row style={styles.row}>
          <Icon name={!shown ? "question" : shown.ok ? "checkCircle" : "warning"} size={16} color={!shown ? c.textMuted : shown.ok ? c.success : c.danger} />
          <T variant="callout" style={{ flex: 1, fontWeight: "500" }}>
            {busy === "check" ? t("pluginAdmin.code.checking") : !shown ? t("pluginAdmin.notCheckedYet") : shown.ok ? t("pluginAdmin.checkPassed") : t("pluginAdmin.checkFailedState")}
          </T>
        </Row>
        {shown
          ? [...shown.errors.map((p) => ({ p, error: true })), ...shown.warnings.map((p) => ({ p, error: false }))].map(({ p, error }, i) => (
              <Row key={i} style={[styles.row, { alignItems: "flex-start" }]}>
                <Icon name="warning" size={14} color={error ? c.danger : c.warning} />
                <View style={{ flex: 1, gap: 2 }}>
                  <T variant="caption" muted style={{ fontWeight: "600" }}>
                    {p.where}
                  </T>
                  <T variant="footnote" selectable>
                    {p.message}
                  </T>
                </View>
              </Row>
            ))
          : null}
      </Group>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 80,
    gap: space.xl,
  },
  notice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  editor: {
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  editorHead: {
    gap: space.sm,
    paddingLeft: space.md,
    paddingRight: space.sm,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  code: {
    fontFamily: fonts.mono,
    fontSize: 12.5,
    lineHeight: 18,
    minHeight: 280,
    paddingHorizontal: space.md,
    paddingTop: space.md,
    paddingBottom: space.md,
    textAlignVertical: "top",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 48,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
});
