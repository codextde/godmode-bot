import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { formatBytes } from "@godmode/shared";
import { Group, SwitchRow } from "@/components/form";
import { NeedsFullAccess, needsFullAccess, useFullAccess } from "@/components/full-access";
import { Button, T } from "@/components/ui";
import { tempCopy } from "@/lib/agent-files";
import { errorText } from "@/lib/api";
import { chatExtrasApi } from "@/lib/chat-extras";
import { fetchConversation } from "@/lib/chat-cache";
import { qk } from "@/lib/query";
import { saveOrShareFile } from "@/lib/save-file";
import { copyPlain } from "@/lib/secrets";
import { space, useColors } from "@/lib/theme";

/** Past this a share code is too long for a chat message: it goes as a file. */
const MESSAGE_CHARS = 40_000;

/**
 * Share a chat, like the desktop: one code a colleague pastes into Godmode, or the same as a `.godmode-chat` file, with
 * the agent's context, screenshots and attached files as picked. Passwords and tokens are masked by the computer.
 */
export default function ChatShare() {
  const c = useColors();
  const { t } = useTranslation(["chat", "common"]);
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const { fullAccess } = useFullAccess();
  const conversation = useQuery({ queryKey: qk.conversation(conversationId), queryFn: () => fetchConversation(conversationId), staleTime: Infinity });
  const remote = !!conversation.data?.runnerId;
  const [context, setContext] = useState(true);
  const [screenshots, setScreenshots] = useState(false);
  const [files, setFiles] = useState(false);
  const opts = { context: context && !remote, files: files && !remote, screenshots };
  const share = useQuery({
    queryKey: ["chat-share", conversationId, opts],
    queryFn: () => chatExtrasApi.share(conversationId, opts),
    enabled: fullAccess === true,
    gcTime: 0,
    staleTime: 0,
    placeholderData: keepPreviousData,
  });
  const result = share.isPlaceholderData ? undefined : share.data;
  const long = !!result && result.bytes > MESSAGE_CHARS;
  const [busy, setBusy] = useState(false);

  if (fullAccess === false || needsFullAccess(share.error)) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        <NeedsFullAccess />
      </View>
    );
  }

  const shareFile = async () => {
    if (!result) return;
    setBusy(true);
    try {
      const file = tempCopy("chat-share", result.fileName);
      if (file.exists) file.delete();
      file.create();
      file.write(result.code);
      try {
        await saveOrShareFile(file, "text/plain");
      } finally {
        if (file.exists) file.delete();
      }
    } catch (err) {
      Alert.alert(t("share.error"), errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content}>
      <View style={{ gap: space.xs }}>
        <T variant="title">{t("share.title")}</T>
        <T variant="subhead" muted>
          {t("share.description")}
        </T>
      </View>
      <Group footer={t("share.privacy")}>
        <SwitchRow title={t("share.context")} detail={remote ? t("share.contextRemote") : t("share.contextHint")} value={opts.context} disabled={remote} onChange={setContext} />
        <SwitchRow title={t("share.screenshots")} detail={t("share.screenshotsHint")} value={screenshots} onChange={setScreenshots} />
        <SwitchRow title={t("share.files")} detail={remote ? t("share.contextRemote") : t("share.filesHint")} value={opts.files} disabled={remote} onChange={setFiles} />
      </Group>
      <View style={styles.size}>
        {share.isFetching || !result ? (
          <ActivityIndicator size="small" color={c.textMuted} />
        ) : (
          <T variant="footnote" color={long ? c.warning : c.textMuted} style={{ fontVariant: ["tabular-nums"] }}>
            {long ? `${formatBytes(result.bytes)} · ${t("share.long")}` : formatBytes(result.bytes)}
          </T>
        )}
      </View>
      {share.isError ? (
        <T variant="footnote" color={c.danger}>
          {errorText(share.error)}
        </T>
      ) : null}
      <View style={{ gap: space.sm }}>
        <Button title={t("share.shareFile")} icon="share" variant={long ? "primary" : "outline"} loading={busy} disabled={!result} onPress={() => void shareFile()} />
        <Button
          title={t("share.copyCode")}
          icon="copy"
          variant={long ? "outline" : "primary"}
          disabled={!result}
          onPress={() => result && void copyPlain(result.code).then(() => Alert.alert(t("share.copied"), t("share.copiedHint")))}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: "center" },
  content: { padding: space.xl, paddingBottom: 48, gap: space.lg },
  size: { minHeight: 20, alignItems: "center" },
});
