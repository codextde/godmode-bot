import { router, Stack } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { MAX_INSTRUCTIONS_LENGTH } from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow, TextEditor, Tile } from "@/components/form";
import { Icon, type IconName } from "@/components/icon";
import { SectionTitle, T } from "@/components/ui";
import { useAgents } from "@/lib/hooks";
import { t } from "@/lib/i18n";
import { firstLine, lineCount, patchSettings, useSettings } from "@/lib/setup";
import { radius, space, useColors } from "@/lib/theme";
import { useWorkspace } from "@/lib/workspace";

const LAYERS = [
  { icon: "globe", labelKey: "instructions.layers.everyone" },
  { icon: "layers", labelKey: "instructions.layers.workspace" },
  { icon: "folder", labelKey: "instructions.layers.project" },
  { icon: "personCircle", labelKey: "instructions.layers.agent" },
  { icon: "chats", labelKey: "instructions.layers.chat" },
] as const satisfies readonly { icon: IconName; labelKey: string }[];

function summary(text: string, empty: string): string {
  if (!text.trim()) return empty;
  const n = lineCount(text);
  return `${firstLine(text)}${n > 1 ? ` · ${t("settings:instructions.lines", { count: n })}` : ""}`;
}

export default function Instructions() {
  const c = useColors();
  const { t } = useTranslation(["settings", "common"]);
  const settings = useSettings();
  const { workspaces } = useWorkspace();
  const { data: agents } = useAgents();

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title: t("overview.links.instructions") }} />
      <CloseButton />

      <View style={{ gap: space.md }}>
        <T variant="subhead" muted>
          {t("instructions.intro")}
        </T>
        <View style={styles.layers}>
          {LAYERS.map((l, i) => (
            <View key={l.labelKey} style={styles.layerWrap}>
              <View style={[styles.layer, { backgroundColor: c.surface, borderColor: c.border }]}>
                <Icon name={l.icon} size={13} color={c.textMuted} />
                <T variant="caption" style={{ fontWeight: "600" }}>
                  {t(l.labelKey)}
                </T>
              </View>
              {i < LAYERS.length - 1 ? <Icon name="chevron" size={9} color={c.textFaint} weight="bold" /> : null}
            </View>
          ))}
        </View>
        <T variant="footnote" muted>
          {t("instructions.precedence")}
        </T>
      </View>

      <View>
        <SectionTitle title={t("instructions.everyAgent")} />
        {settings.data ? (
          <TextEditor
            label={t("instructions.everyAgentLabel")}
            value={settings.data.runner.appendSystemPrompt}
            placeholder={t("instructions.example")}
            maxLength={MAX_INSTRUCTIONS_LENGTH}
            minHeight={180}
            onSave={(appendSystemPrompt) => patchSettings({ runner: { appendSystemPrompt } }, { quiet: true })}
          />
        ) : (
          <View style={[styles.placeholder, { backgroundColor: c.surface, borderColor: c.border }]}>
            <T variant="subhead" muted>
              {settings.isError ? t("instructions.loadError") : t("common:status.loading")}
            </T>
          </View>
        )}
      </View>

      {workspaces.length ? (
        <Group title={t("instructions.workspaces.title")} footer={t("instructions.workspaces.footer")}>
          {workspaces.flatMap((w) => [
            <LinkRow
              key={w.id}
              emoji={w.icon || "🗂️"}
              title={w.name}
              detail={summary(w.instructions, t("instructions.workspaces.noContext"))}
              onPress={() => router.push({ pathname: "/settings/workspace/[id]", params: { id: w.id } })}
            />,
            ...w.projects.map((p) => (
              <LinkRow
                key={p.id}
                lead={
                  <View style={styles.nested}>
                    <Tile emoji={p.icon || "📁"} size={24} />
                  </View>
                }
                title={p.name}
                detail={summary(p.instructions, t("instructions.workspaces.noProjectContext"))}
                onPress={() => router.push({ pathname: "/settings/project/[id]", params: { id: p.id } })}
              />
            )),
          ])}
        </Group>
      ) : (
        <Group title={t("instructions.workspaces.title")}>
          <LinkRow icon="plus" title={t("workspaces.create")} detail={t("instructions.workspaces.createDetail")} tone="brand" onPress={() => router.push({ pathname: "/settings/new", params: { kind: "workspace" } })} />
        </Group>
      )}

      {agents?.length ? (
        <Group title={t("common:words.agents")} footer={t("instructions.agents.footer")}>
          {agents.map((a) => (
            <LinkRow
              key={a.id}
              lead={<CharacterAvatar agent={a} size={30} />}
              title={a.name}
              detail={summary(a.instructions, t("instructions.agents.none"))}
              onPress={() => router.push({ pathname: "/settings/agent/[id]", params: { id: a.id } })}
            />
          ))}
        </Group>
      ) : null}

      <View style={[styles.tip, { borderColor: c.borderStrong }]}>
        <Icon name="chats" size={15} color={c.textMuted} />
        <T variant="footnote" muted style={{ flex: 1 }}>
          {t("instructions.tip")}
        </T>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  layers: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    rowGap: space.sm,
  },
  layerWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginRight: 4,
  },
  layer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 28,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  placeholder: {
    padding: space.lg,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  nested: {
    width: 30,
    paddingLeft: 10,
  },
  tip: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: 1,
    borderStyle: "dashed",
  },
});
