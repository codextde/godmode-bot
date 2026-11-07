import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { LinkRow } from "./form";
import { MCP_PRESETS } from "@/lib/mcp-presets";

/** Quick add as rows of a Group: the desktop's popular servers, each opening the form filled in, or an empty form. */
export function useMcpPresetRows({ replace = false } = {}) {
  const { t } = useTranslation("tools");
  const open = (preset: string) => (replace ? router.replace : router.push)({ pathname: "/settings/mcp-server", params: { preset } });
  return [
    ...MCP_PRESETS.map((p) => <LinkRow key={p.id} icon={p.icon} title={p.name} detail={t(p.description)} onPress={() => open(p.id)} />),
    <LinkRow key="custom" icon="wrench" title={t("mcp.customServer")} onPress={() => open("custom")} />,
  ];
}
