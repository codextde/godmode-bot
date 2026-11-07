import { useMutation, useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Linking, Modal, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Artifact, ArtifactVersion } from "@godmode/shared";
import { ArtifactFrame } from "@/components/artifact-frame";
import { Glass } from "@/components/glass";
import { HeaderActions } from "@/components/header-actions";
import { Icon } from "@/components/icon";
import { Button, EmptyState, ErrorState, GlassIconButton, Hairline, Row, T, tap } from "@/components/ui";
import { ApiError, api, errorText } from "@/lib/api";
import { shortTime } from "@/lib/format";
import { useRunningChats } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

type Request = { kind: "ask"; text: string } | { kind: "refresh" };
type Sheet = "versions" | "rename" | "refresh" | null;

/** An artifact full screen: use it, and ask its agent for changes right there. */
export default function ArtifactScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t } = useTranslation(["artifacts", "common"]);
  const insets = useSafeAreaInsets();
  const keyboardOpen = useKeyboardState((s) => s.isVisible);
  // Android draws the header above the screen, not over it.
  const headerHeight = useHeaderHeight();
  const keyboardOffset = process.env.EXPO_OS === "android" ? headerHeight : 0;
  const query = useQuery({ queryKey: qk.artifact(id), queryFn: () => api.artifacts.get(id) });
  const artifact = query.data;
  const running = useRunningChats();
  const busy = !!artifact?.conversationId && running.has(artifact.conversationId);
  const agent = artifact?.agentName ?? t("theAgent");
  const [viewing, setViewing] = useState<number | null>(null);
  const old = useQuery({ queryKey: [...qk.artifact(id), "version", viewing], queryFn: () => api.artifacts.version(id, viewing!), enabled: viewing !== null });
  const [sheet, setSheet] = useState<Sheet>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const say = (text: string) => {
    setStatus(text);
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(null), 4000);
  };
  useEffect(() => () => void (statusTimer.current && clearTimeout(statusTimer.current)), []);

  const refetch = () => void queryClient.invalidateQueries({ queryKey: qk.artifacts });
  const message = useMutation({
    mutationFn: (input: { content: string; source?: "human" | "app" }) => api.artifacts.message(id, input.content, input.source),
    onSuccess: (r) => say(r.queued ? t("view.queued", { agent }) : t("view.onIt", { agent })),
    onError: (err) => Alert.alert(t("view.sendError"), errorText(err)),
  });
  const refresh = useMutation({
    mutationFn: () => api.artifacts.refresh(id),
    onSuccess: () => say(t("view.refreshing", { agent })),
    onError: (err) => Alert.alert(t("view.refreshError"), errorText(err)),
  });
  const reviewDone = useMutation({
    mutationFn: () => api.artifacts.reviewDone(id),
    onSuccess: (r) => {
      if (r.conversationId) say(t("view.reviewSent", { agent }));
    },
    onError: (err) => Alert.alert(t("view.sendError"), errorText(err)),
  });
  const update = useMutation({
    mutationFn: (input: { title?: string; pinned?: boolean; refreshPrompt?: string }) => api.artifacts.update(id, input),
    onSuccess: refetch,
    onError: (err) => Alert.alert(t("view.saveFailed"), errorText(err)),
  });
  const restore = useMutation({
    mutationFn: (version: number) => api.artifacts.restore(id, version),
    onSuccess: (a, version) => {
      setViewing(null);
      queryClient.setQueryData(qk.artifact(id), a);
      refetch();
      say(a.version === artifact?.version ? t("versions.sameVersion", { version }) : t("versions.restored", { version: a.version }));
    },
    onError: (err) => Alert.alert(t("versions.restoreError"), errorText(err)),
  });

  const ask = (request: Request) => {
    const body = request.kind === "refresh" ? t("view.appAsksRefresh", { agent }) : t("view.appWantsToSend", { agent, text: request.text });
    Alert.alert(artifact?.title ?? "", body, [
      { text: t("view.notNow"), style: "cancel" },
      {
        text: request.kind === "refresh" ? t("view.refresh") : t("view.send"),
        onPress: () => (request.kind === "refresh" ? refresh.mutate() : message.mutate({ content: request.text, source: "app" })),
      },
    ]);
  };

  const remove = () =>
    Alert.alert(t("view.deleteTitle", { title: artifact?.title ?? "" }), t("view.deleteBody"), [
      { text: t("view.keep"), style: "cancel" },
      {
        text: t("view.delete"),
        style: "destructive",
        onPress: () =>
          void api.artifacts
            .delete(id)
            .then(() => {
              refetch();
              router.back();
            })
            .catch((err) => Alert.alert(t("view.deleteError"), errorText(err))),
      },
    ]);

  if (!artifact) {
    const gone = query.error instanceof ApiError && query.error.status === 404;
    return (
      <View style={[styles.fill, { backgroundColor: c.background, justifyContent: "center", padding: space.lg }]}>
        <Stack.Screen options={{ title: "" }} />
        {query.isLoading ? (
          <ActivityIndicator color={c.textMuted} />
        ) : gone ? (
          <EmptyState icon="artifact" title={t("view.goneTitle")} body={t("view.goneBody")} />
        ) : query.error instanceof ApiError && query.error.code === "device_forbidden" ? (
          <EmptyState icon="artifact" title={t("list.unavailableTitle")} body={t("list.unavailableBody")} />
        ) : (
          <ErrorState title={t("view.loadErrorTitle")} error={errorText(query.error)} onRetry={() => void query.refetch()} />
        )}
      </View>
    );
  }

  const shown: Pick<Artifact, "html" | "data" | "files" | "filesBase" | "title"> = artifact;
  const html = viewing !== null ? old.data?.html : undefined;
  const placeholder = busy ? t("view.busyPlaceholder", { agent }) : t("view.placeholder", { agent });

  return (
    <View style={[styles.fill, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ title: artifact.title, headerTransparent: false, headerStyle: { backgroundColor: c.background } }} />
      <HeaderActions
        actions={[
          {
            icon: "refresh",
            label: artifact.refreshPrompt ? t("view.refresh") : t("view.askFresh"),
            onPress: () => {
              if (busy || refresh.isPending) say(t("view.alreadyWorking", { agent }));
              else refresh.mutate();
            },
          },
        ]}
        menu={[
          ...(artifact.conversationId ? [{ icon: "chats" as const, title: t("view.openChat"), onPress: () => router.push({ pathname: "/chat/[id]", params: { id: artifact.conversationId! } }) }] : []),
          { icon: "pin", title: artifact.pinned ? t("view.unpin") : t("view.pin"), onPress: () => update.mutate({ pinned: !artifact.pinned }) },
          { icon: "history", title: t("view.versions"), onPress: () => setSheet("versions") },
          { icon: "pencil", title: t("view.rename"), onPress: () => setSheet("rename") },
          { icon: "refresh", title: t("view.howItRefreshes"), onPress: () => setSheet("refresh") },
          { icon: "trash", title: t("view.delete"), onPress: remove, destructive: true },
        ]}
      />
      <KeyboardAvoidingView behavior="translate-with-padding" keyboardVerticalOffset={keyboardOffset} style={styles.fill}>
        {viewing !== null ? (
          <Row style={[styles.versionBar, { backgroundColor: c.sunken }]}>
            <T variant="subhead" style={{ flex: 1, fontWeight: "600" }}>
              {t("versions.viewing", { version: viewing })}
            </T>
            <Pressable hitSlop={8} onPress={() => setViewing(null)}>
              <T variant="subhead" muted>
                {t("versions.backToLatest")}
              </T>
            </Pressable>
            <Button title={t("versions.restore")} size="md" variant="primary" loading={restore.isPending} onPress={() => restore.mutate(viewing)} style={{ height: 34 }} />
          </Row>
        ) : null}
        {viewing !== null && !html ? (
          <View style={[styles.fill, { alignItems: "center", justifyContent: "center" }]}>
            <ActivityIndicator color={c.textMuted} />
          </View>
        ) : (
          <ArtifactFrame
            artifact={shown}
            html={html}
            interactive={viewing === null}
            onSetData={async (data) => {
              await api.artifacts.saveData(id, data);
              queryClient.setQueryData<Artifact>(qk.artifact(id), (a) => (a ? { ...a, data } : a));
            }}
            onAsk={(text) => ask({ kind: "ask", text })}
            onRefresh={() => (busy || refresh.isPending ? say(t("view.alreadyWorking", { agent })) : ask({ kind: "refresh" }))}
            onError={setFailure}
            onSaveError={(m) => Alert.alert(t("view.saveError"), m)}
            onReviewDone={() => reviewDone.mutate()}
            onViewFile={(name, url) => {
              const file = artifact.files.find((f) => f.name === name);
              if (!url) return;
              if (file?.kind === "image") setImage(url);
              else void Linking.openURL(url);
            }}
          />
        )}
        {failure ? (
          <Animated.View entering={FadeIn} exiting={FadeOut} style={[styles.failure, { backgroundColor: c.dangerSoft }]}>
            <T variant="footnote" color={c.danger} numberOfLines={2} style={{ flex: 1 }}>
              {t("view.somethingBroke", { failure })}
            </T>
            <Pressable
              hitSlop={8}
              onPress={() => {
                message.mutate({ content: t("view.fixPrompt", { failure }) });
                setFailure(null);
              }}
            >
              <T variant="footnote" style={{ fontWeight: "600" }}>
                {t("view.askToFix")}
              </T>
            </Pressable>
            <Pressable hitSlop={8} accessibilityLabel={t("view.dismiss")} onPress={() => setFailure(null)}>
              <Icon name="close" size={12} color={c.textMuted} />
            </Pressable>
          </Animated.View>
        ) : null}
        <ChangeBar
          placeholder={placeholder}
          status={busy ? t("view.working", { agent }) : status}
          working={busy}
          sending={message.isPending}
          onSend={(content) => message.mutateAsync({ content }).then(() => true, () => false)}
        />
        <View style={{ height: keyboardOpen ? space.sm : Math.max(insets.bottom, space.sm) }} />
      </KeyboardAvoidingView>

      <VersionsSheet
        open={sheet === "versions"}
        id={id}
        current={artifact.version}
        onClose={() => setSheet(null)}
        onPick={(v) => {
          setSheet(null);
          setViewing(v === artifact.version ? null : v);
        }}
      />
      <TextSheet
        open={sheet === "rename"}
        title={t("renameSheet.title")}
        value={artifact.title}
        maxLength={120}
        onClose={() => setSheet(null)}
        onSave={(title) => update.mutateAsync({ title }).then(() => true, () => false)}
      />
      <TextSheet
        open={sheet === "refresh"}
        title={t("refreshSheet.title")}
        value={artifact.refreshPrompt}
        placeholder={t("refreshSheet.placeholder")}
        multiline
        maxLength={4000}
        allowEmpty
        onClose={() => setSheet(null)}
        onSave={(refreshPrompt) => update.mutateAsync({ refreshPrompt }).then(() => true, () => false)}
      />
      <Modal visible={!!image} transparent animationType="fade" onRequestClose={() => setImage(null)}>
        <View style={[styles.fill, { backgroundColor: "#000" }]}>
          {image ? <Image source={{ uri: image }} style={styles.fill} contentFit="contain" transition={150} /> : null}
          <View style={{ position: "absolute", top: insets.top + space.sm, right: space.lg }}>
            <GlassIconButton icon="close" label={t("common:actions.close")} dark onPress={() => setImage(null)} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

function ChangeBar({
  placeholder,
  status,
  working,
  sending,
  onSend,
}: {
  placeholder: string;
  status: string | null;
  working: boolean;
  sending: boolean;
  onSend: (text: string) => Promise<boolean>;
}) {
  const c = useColors();
  const { t } = useTranslation("artifacts");
  const [text, setText] = useState("");
  const send = async () => {
    const content = text.trim();
    if (!content || sending) return;
    tap();
    setText("");
    if (!(await onSend(content))) setText(content);
  };
  return (
    <View style={styles.barWrap}>
      {status ? (
        <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(160)} style={styles.statusRow}>
          {working ? <ActivityIndicator size="small" color={c.textMuted} /> : <Icon name="check" size={12} color={c.textMuted} />}
          <T variant="footnote" muted numberOfLines={1}>
            {status}
          </T>
        </Animated.View>
      ) : null}
      <Glass interactive style={styles.bar}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          placeholderTextColor={c.textFaint}
          multiline
          maxLength={20_000}
          accessibilityLabel={t("view.placeholder", { agent: "" })}
          style={[styles.input, { color: c.text }]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("view.send")}
          disabled={!text.trim() || sending}
          onPress={() => void send()}
          style={[styles.send, { backgroundColor: text.trim() ? c.primary : c.sunken }]}
        >
          {sending ? <ActivityIndicator size="small" color={c.onPrimary} /> : <Icon name="send" size={15} weight="bold" color={text.trim() ? c.onPrimary : c.textFaint} />}
        </Pressable>
      </Glass>
    </View>
  );
}

function VersionsSheet({ open, id, current, onClose, onPick }: { open: boolean; id: string; current: number; onClose: () => void; onPick: (version: number) => void }) {
  const c = useColors();
  const { t } = useTranslation(["artifacts", "common"]);
  const versions = useQuery({ queryKey: qk.artifactVersions(id), queryFn: () => api.artifacts.versions(id), enabled: open });
  const list = [...(versions.data ?? [])].sort((a, b) => b.version - a.version);
  return (
    <Modal visible={open} presentationStyle="pageSheet" animationType="slide" onRequestClose={onClose}>
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        <SheetHeader title={t("versions.title")} onClose={onClose} />
        {versions.isLoading ? (
          <ActivityIndicator style={{ marginTop: space.xl }} color={c.textMuted} />
        ) : (
          <FlatList<ArtifactVersion>
            data={list}
            keyExtractor={(v) => String(v.version)}
            contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: space.xxl }}
            ItemSeparatorComponent={() => <Hairline inset={space.md} />}
            renderItem={({ item: v }) => (
              <Pressable onPress={() => onPick(v.version)} style={({ pressed }) => [styles.versionRow, pressed && { backgroundColor: c.sunken }]}>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Row style={{ gap: space.sm }}>
                    <T variant="headline" style={{ fontSize: 15 }}>
                      {t("versions.version", { version: v.version })}
                    </T>
                    {v.version === current ? (
                      <T variant="caption" color={c.brandStrong}>
                        {t("versions.latest")}
                      </T>
                    ) : null}
                  </Row>
                  <T variant="footnote" muted numberOfLines={2}>
                    {v.note || (v.version === 1 ? t("versions.first") : "")}
                  </T>
                </View>
                <T variant="caption" muted>
                  {shortTime(v.createdAt)}
                </T>
              </Pressable>
            )}
          />
        )}
      </View>
    </Modal>
  );
}

function TextSheet(props: {
  open: boolean;
  title: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  maxLength: number;
  allowEmpty?: boolean;
  onClose: () => void;
  onSave: (text: string) => Promise<boolean>;
}) {
  const c = useColors();
  return (
    <Modal visible={props.open} presentationStyle="pageSheet" animationType="slide" onRequestClose={props.onClose}>
      <View style={[styles.fill, { backgroundColor: c.background }]}>{props.open ? <TextSheetBody {...props} /> : null}</View>
    </Modal>
  );
}

/** Mounted each time the sheet opens, so it starts from the saved text. */
function TextSheetBody({ title, value, placeholder, multiline, maxLength, allowEmpty, onClose, onSave }: Parameters<typeof TextSheet>[0]) {
  const c = useColors();
  const { t } = useTranslation(["artifacts", "common"]);
  const [text, setText] = useState(value);
  const [saving, setSaving] = useState(false);
  const changed = text.trim() !== value.trim() && (allowEmpty || !!text.trim());
  return (
    <>
      <SheetHeader
        title={title}
        onClose={onClose}
        action={
          <Button
            title={t("renameSheet.save")}
            size="md"
            disabled={!changed}
            loading={saving}
            style={{ height: 34 }}
            onPress={async () => {
              setSaving(true);
              const ok = await onSave(text.trim());
              setSaving(false);
              if (ok) onClose();
            }}
          />
        }
      />
      <View style={{ paddingHorizontal: space.lg }}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          placeholderTextColor={c.textFaint}
          autoFocus
          multiline={multiline}
          maxLength={maxLength}
          style={[styles.field, { color: c.text, backgroundColor: c.surface, borderColor: c.border, minHeight: multiline ? 160 : undefined }]}
        />
      </View>
    </>
  );
}

function SheetHeader({ title, onClose, action }: { title: string; onClose: () => void; action?: React.ReactNode }) {
  const c = useColors();
  const { t } = useTranslation("common");
  return (
    <Row style={styles.sheetHeader}>
      <Pressable hitSlop={10} accessibilityRole="button" accessibilityLabel={t("actions.close")} onPress={onClose} style={[styles.close, { backgroundColor: c.sunken }]}>
        <Icon name="close" size={13} weight="semibold" color={c.textMuted} />
      </Pressable>
      <T variant="headline" numberOfLines={1} style={{ flex: 1, textAlign: "center" }}>
        {title}
      </T>
      <View style={{ minWidth: 30, alignItems: "flex-end" }}>{action}</View>
    </Row>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  barWrap: { paddingHorizontal: space.md, paddingTop: space.sm, gap: 6 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: space.sm },
  bar: { flexDirection: "row", alignItems: "flex-end", gap: space.sm, padding: 6, paddingLeft: space.lg, borderRadius: 24, borderCurve: "continuous" },
  input: { flex: 1, fontSize: 16, paddingTop: 9, paddingBottom: 9, maxHeight: 120 },
  send: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  failure: { flexDirection: "row", alignItems: "center", gap: space.md, marginHorizontal: space.md, marginTop: space.sm, padding: space.md, borderRadius: radius.lg, borderCurve: "continuous" },
  versionBar: { gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm },
  versionRow: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md, paddingHorizontal: space.md, borderRadius: radius.md },
  sheetHeader: { gap: space.md, paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.md },
  close: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  field: { fontSize: 16, padding: space.md, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, textAlignVertical: "top" },
});
