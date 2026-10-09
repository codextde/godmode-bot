import { router } from "expo-router";
import { Pressable, StyleSheet } from "react-native";
import { Icon } from "./icon";
import { T, tap } from "./ui";
import { useWorkspace } from "@/lib/workspace";
import { radius, useColors } from "@/lib/theme";

/** The workspace (and project) everything on the phone is scoped to; tap to switch. Hidden until the computer has workspaces. */
export function WorkspaceChip() {
  const c = useColors();
  const { workspace, project, workspaces } = useWorkspace();
  if (!workspaces.length) return null;
  const name = workspace?.name ?? "All workspaces";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${project ? `Project: ${project.name} in ${name}` : `Workspace: ${name}`}. Switch`}
      hitSlop={6}
      onPress={() => {
        tap();
        router.push("/workspaces");
      }}
      style={({ pressed }) => [styles.chip, { backgroundColor: c.sunken, opacity: pressed ? 0.7 : 1 }]}
    >
      {workspace ? <T style={{ fontSize: 14 }}>{workspace.icon || "🗂️"}</T> : <Icon name="layers" size={13} color={c.textMuted} />}
      <T variant="subhead" numberOfLines={1} style={{ fontWeight: "600", flexShrink: 1 }} muted={!!project}>
        {name}
      </T>
      {project ? (
        <>
          <Icon name="chevron" size={9} color={c.textFaint} weight="bold" />
          {project.icon ? <T style={{ fontSize: 13 }}>{project.icon}</T> : <Icon name="folder" size={12} color={c.textMuted} />}
          <T variant="subhead" numberOfLines={1} style={{ fontWeight: "600", flexShrink: 1 }}>
            {project.name}
          </T>
        </>
      ) : null}
      <Icon name="down" size={11} color={c.textMuted} weight="semibold" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    height: 32,
    maxWidth: "100%",
    paddingHorizontal: 12,
    borderRadius: radius.pill,
  },
});
