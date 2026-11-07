import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Group, LinkRow } from "./form";
import { usePluginsWaiting } from "@/lib/integrations";
import { useSettings } from "@/lib/setup";

/** What else agents reach, above the servers and tools of Settings → Integrations. */
export function ToolsLinks() {
  const { t } = useTranslation(["integrations", "machines", "settings"]);
  const s = useSettings().data;
  const waiting = usePluginsWaiting();
  return (
    <Group>
      <LinkRow icon="puzzle" title={t("plugins.title")} value={waiting ? String(waiting) : undefined} onPress={() => router.push("/settings/plugins")} />
      <LinkRow icon="chats" title={t("messaging.title")} onPress={() => router.push("/settings/messaging")} />
      <LinkRow icon="server" title={t("ssh.title")} onPress={() => router.push("/settings/ssh")} />
      <LinkRow icon="vm" title={t("machines:vms.title")} onPress={() => router.push("/settings/vms")} />
      <LinkRow icon="phone" title={t("machines:android.title")} onPress={() => router.push("/settings/android")} />
      {s?.phone.enabled ? <LinkRow icon="call" title={t("settings:overview.links.calls")} value={s.phone.callerName || undefined} onPress={() => router.push("/settings/calls")} /> : null}
    </Group>
  );
}
