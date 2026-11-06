import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Group, LinkRow } from "./form";

/** Settings' way to the vault, the agents' files, integrations, plugins, messaging and SSH servers (read on the phone). */
export function ToolsLinks() {
  const { t } = useTranslation(["integrations", "vault", "files"]);
  return (
    <Group title={t("links.group")}>
      <LinkRow icon="key" title={t("vault:index.title")} onPress={() => router.push("/settings/vault")} />
      <LinkRow icon="files" title={t("files:index.title")} onPress={() => router.push("/settings/files")} />
      <LinkRow icon="plug" title={t("title")} onPress={() => router.push("/settings/integrations")} />
      <LinkRow icon="puzzle" title={t("plugins.title")} onPress={() => router.push("/settings/plugins")} />
      <LinkRow icon="chats" title={t("messaging.title")} onPress={() => router.push("/settings/messaging")} />
      <LinkRow icon="server" title={t("ssh.title")} onPress={() => router.push("/settings/ssh")} />
    </Group>
  );
}
