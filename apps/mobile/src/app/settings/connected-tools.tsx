import { useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { RefreshControl, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { ConnectorTool } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { Group } from "@/components/form";
import { SettingsScroll } from "@/components/settings-scroll";
import { QueryState } from "@/components/settings-state";
import { Badge, Row, T } from "@/components/ui";
import { settingsApi, sq } from "@/lib/settings-api";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { fonts, space } from "@/lib/theme";

/** The tools by what they are about, in the words of the app's own pages (the desktop's Claude Code & MCP section). */
const GROUPS = [
  { id: "agents", match: (name: string) => name.startsWith("agent") },
  { id: "automations", match: (name: string) => name.startsWith("routine") || name.startsWith("automation") },
  { id: "tasks", match: (name: string) => name.startsWith("task") },
  { id: "vms", match: (name: string) => name.startsWith("vm") },
  { id: "activity", match: () => true },
] as const;

const firstSentence = (text: string) => /^.*?\.(?=\s|$)/.exec(text)?.[0] ?? text;

function grouped(tools: ConnectorTool[]) {
  const rest = [...tools];
  return GROUPS.map((g) => {
    const own = rest.filter((tool) => g.match(tool.name));
    for (const tool of own) rest.splice(rest.indexOf(tool), 1);
    return { id: g.id, tools: own };
  }).filter((g) => g.tools.length);
}

/** Settings → Connected apps → What a connected app can do. */
export default function ConnectedTools() {
  const { t } = useTranslation("settings");
  const status = useQuery({ queryKey: sq.connectors, queryFn: settingsApi.connectors.status });
  const pull = usePullRefresh(status.refetch);
  return (
    <SettingsScroll contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Screen options={{ title: t("connected.tools.title"), headerLargeTitleEnabled: false }} />
      <CloseButton />
      <QueryState query={status} icon="plug" errorTitle={t("connected.loadFailed")}>
        {(s) => (
          <>
            <T variant="footnote" muted style={styles.note}>
              {t("connected.tools.description", { count: s.tools.length })}
            </T>
            {grouped(s.tools).map((g) => (
              <Group key={g.id} title={t(`connected.tools.${g.id}`)} footer={t(`connected.tools.${g.id}About`)}>
                {g.tools.map((tool) => (
                  <ToolRow key={tool.name} tool={tool} />
                ))}
              </Group>
            ))}
          </>
        )}
      </QueryState>
    </SettingsScroll>
  );
}

function ToolRow({ tool }: { tool: ConnectorTool }) {
  const { t } = useTranslation("settings");
  return (
    <View style={styles.row}>
      <Row style={{ gap: space.sm }}>
        <T variant="subhead" numberOfLines={1} style={styles.name}>
          {tool.name}
        </T>
        {tool.access === "read" ? <Badge label={t("connected.tools.onlyReads")} dot={false} /> : null}
      </Row>
      <T variant="footnote" muted numberOfLines={3}>
        {firstSentence(tool.description)}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  note: {
    paddingHorizontal: 4,
  },
  row: {
    gap: 2,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
  name: {
    flexShrink: 1,
    fontFamily: fonts.mono,
  },
});
