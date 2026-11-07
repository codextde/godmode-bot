import { router, type Href } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Icon, type IconName } from "./icon";
import { T, tap } from "./ui";
import { firstLine, useSettings } from "@/lib/setup";
import { space, useColors } from "@/lib/theme";
import { useWorkspace } from "@/lib/workspace";

interface Layer {
  key: string;
  label: string;
  hint: string;
  text: string;
  icon: IconName;
  href: Href;
}

/** What else an agent in this workspace gets on every run, most general first; only layers with text. */
export function InheritedInstructions({ workspaceId, projectId }: { workspaceId: string | null; projectId?: string | null }) {
  const c = useColors();
  const { t } = useTranslation("manage");
  const global = useSettings().data?.runner.appendSystemPrompt?.trim() ?? "";
  const { workspaces } = useWorkspace();
  const workspace = workspaceId ? workspaces.find((w) => w.id === workspaceId) : undefined;
  const project = projectId ? workspace?.projects.find((p) => p.id === projectId) : undefined;
  const layers: Layer[] = [
    ...(global ? [{ key: "global", label: t("agent.layerGlobalTitle"), hint: t("agent.layerGlobal"), text: global, icon: "globe" as const, href: "/settings/instructions" as const }] : []),
    ...(workspace?.instructions.trim()
      ? [{ key: "workspace", label: workspace.name, hint: t("agent.layerWorkspace"), text: workspace.instructions, icon: "layers" as const, href: { pathname: "/settings/workspace/[id]", params: { id: workspace.id } } as const }]
      : []),
    ...(project?.instructions.trim()
      ? [{ key: "project", label: project.name, hint: t("agent.layerProject"), text: project.instructions, icon: "layers" as const, href: { pathname: "/settings/project/[id]", params: { id: project.id } } as const }]
      : []),
  ];
  if (!layers.length) return null;
  return (
    <View style={styles.wrap}>
      <T variant="footnote" muted>
        {t("agent.inherited")}
      </T>
      {layers.map((l) => (
        <Pressable
          key={l.key}
          accessibilityRole="link"
          onPress={() => {
            tap();
            router.push(l.href);
          }}
          style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
        >
          <Icon name={l.icon} size={14} color={c.textMuted} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T variant="footnote" numberOfLines={1} style={{ fontWeight: "600" }}>
              {l.label} <T variant="caption" muted>{l.hint}</T>
            </T>
            <T variant="footnote" muted numberOfLines={1}>
              {firstLine(l.text)}
            </T>
          </View>
          <Icon name="chevron" size={10} weight="semibold" color={c.textFaint} />
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm, paddingTop: space.md, paddingHorizontal: space.xs },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 36 },
});
