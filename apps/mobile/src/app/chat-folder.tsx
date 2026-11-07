import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { Alert, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { FolderBrowser } from "@/components/folder-browser";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { errorText } from "@/lib/api";
import { fetchConversation } from "@/lib/chat-cache";
import { changeChatWork } from "@/lib/chat-extras";
import { useNewChatOptions } from "@/lib/chat-options";
import { qk } from "@/lib/query";
import { space, useColors } from "@/lib/theme";

/** The folder on the computer a chat works in (instead of its agent's), browsed like the agent's working folder. */
export default function ChatFolder() {
  const c = useColors();
  const { t } = useTranslation(["chat", "common"]);
  const { fullAccess } = useFullAccess();
  const { path: start, conversationId } = useLocalSearchParams<{ path?: string; conversationId?: string }>();
  const newChatFolder = useNewChatOptions((s) => s.options.workingDirectory);
  const chat = useQuery({ queryKey: qk.conversation(conversationId ?? ""), queryFn: () => fetchConversation(conversationId!), enabled: !!conversationId, staleTime: Infinity });
  const picked = conversationId ? (chat.data?.workingDirectory ?? null) : newChatFolder;

  const take = (folder: string | null) => {
    if (conversationId) void changeChatWork(conversationId, { workingDirectory: folder }).catch((err: unknown) => Alert.alert(t("options.changeFailed"), errorText(err)));
    else useNewChatOptions.getState().set({ workingDirectory: folder });
    router.back();
  };

  if (fullAccess === false) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        <NeedsFullAccess />
      </View>
    );
  }
  return (
    <FolderBrowser
      title={t("place.folder")}
      action={t("place.useFolder")}
      start={start || undefined}
      enabled={fullAccess === true}
      clear={picked ? { title: t("place.agentFolder"), onPress: () => take(null) } : undefined}
      onUse={take}
    />
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: "center", padding: space.lg },
});
