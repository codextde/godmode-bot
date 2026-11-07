import { router, useLocalSearchParams } from "expo-router";
import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { FolderBrowser } from "@/components/folder-browser";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { EmptyState, LoadingState } from "@/components/ui";
import { useAgents } from "@/lib/hooks";
import { patchAgentSetup } from "@/lib/manage";
import { space, useColors } from "@/lib/theme";

/** An agent's working folder on the computer (the desktop's folder picker): browse from home or its folder, then use one. */
export default function FolderPick() {
  const c = useColors();
  const { t } = useTranslation(["manage", "common"]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const { byId, isPending } = useAgents();
  const { fullAccess } = useFullAccess();
  const agent = byId.get(id);

  const take = (folder: string | null) => {
    router.back();
    if (agent && folder !== agent.workingDirectory) void patchAgentSetup(agent.id, { workingDirectory: folder });
  };

  if (fullAccess === false || (!agent && !isPending)) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        {fullAccess === false ? <NeedsFullAccess /> : <EmptyState icon="agents" title={t("agent.gone")} />}
      </View>
    );
  }
  if (!agent) return <LoadingState />;
  return (
    <FolderBrowser
      title={t("folder.title")}
      action={t("folder.use")}
      start={agent.workingDirectory ?? undefined}
      enabled={fullAccess === true}
      clear={agent.workingDirectory ? { title: t("folder.own"), onPress: () => take(null) } : undefined}
      onUse={take}
    />
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: "center", padding: space.lg },
});
