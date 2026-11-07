import { router, useLocalSearchParams } from "expo-router";
import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { FolderBrowser } from "@/components/folder-browser";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { useNewChatOptions } from "@/lib/chat-options";
import { space, useColors } from "@/lib/theme";

/** The folder on the computer a new chat works in (instead of its agent's), browsed like the agent's working folder. */
export default function ChatFolder() {
  const c = useColors();
  const { t } = useTranslation(["chat", "common"]);
  const { fullAccess } = useFullAccess();
  const { path: start } = useLocalSearchParams<{ path?: string }>();
  const picked = useNewChatOptions((s) => s.options.workingDirectory);

  const take = (folder: string | null) => {
    useNewChatOptions.getState().set({ workingDirectory: folder });
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
