import { router } from "expo-router";
import { useState, type ReactNode } from "react";
import { LayoutAnimation, Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { Workspace } from "@godmode/shared";
import { Icon } from "@/components/icon";
import { Card, Hairline, Skeleton, T, tap } from "@/components/ui";
import { useWorkspace } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

/** Pick the workspace, or one of its projects, the phone works in: chats, tasks and agents follow it, and new ones start in it. */
export default function Workspaces() {
  const c = useColors();
  const { id, projectId, workspaces, loading, select } = useWorkspace();
  const [open, setOpen] = useState<Set<string>>(() => new Set(id ? [id] : []));

  const pick = (next: string | null, project: string | null = null) => {
    tap();
    select(next, project);
    router.back();
  };
  const toggle = (wsId: string) => {
    tap();
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(wsId)) n.delete(wsId);
      else n.add(wsId);
      return n;
    });
  };

  return (
    <ScrollView contentContainerStyle={styles.content} style={{ backgroundColor: c.background }}>
      <View style={{ gap: 4 }}>
        <T variant="title">Workspace</T>
        <T variant="subhead" muted>
          Chats and tasks you start from this phone go into the workspace or project you pick.
        </T>
      </View>
      <Card style={{ paddingVertical: 4 }}>
        <Choice
          selected={!id}
          onPress={() => pick(null)}
          icon={<Icon name="layers" size={17} color={c.textMuted} />}
          title="All workspaces"
          body="Everything, from every workspace"
        />
        {loading
          ? [0, 1, 2].map((i) => (
              <View key={i}>
                <Hairline inset={64} />
                <View style={styles.choice}>
                  <Skeleton width={36} height={36} radius={11} />
                  <View style={{ flex: 1, gap: 6 }}>
                    <Skeleton width="45%" height={14} />
                    <Skeleton width="70%" height={11} />
                  </View>
                </View>
              </View>
            ))
          : workspaces.map((w) => (
              <WorkspaceChoice
                key={w.id}
                workspace={w}
                selected={w.id === id && !projectId}
                selectedProject={w.id === id ? projectId : null}
                expanded={open.has(w.id)}
                onToggle={() => toggle(w.id)}
                onPick={(project) => pick(w.id, project)}
              />
            ))}
      </Card>
      <T variant="caption" muted style={{ paddingHorizontal: 4 }}>
        Create and set up workspaces and projects in Godmode on your computer.
      </T>
    </ScrollView>
  );
}

function WorkspaceChoice({
  workspace,
  selected,
  selectedProject,
  expanded,
  onToggle,
  onPick,
}: {
  workspace: Workspace;
  selected: boolean;
  selectedProject: string | null;
  expanded: boolean;
  onToggle: () => void;
  onPick: (project: string | null) => void;
}) {
  const c = useColors();
  const projects = workspace.projects ?? [];
  const count = projects.length;
  return (
    <View>
      <Hairline inset={64} />
      <Choice
        selected={selected}
        onPress={() => onPick(null)}
        icon={<T style={{ fontSize: 19 }}>{workspace.icon || "🗂️"}</T>}
        title={workspace.name}
        body={workspace.description || (count ? (count === 1 ? "1 project" : `${count} projects`) : undefined)}
        trailing={
          count ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={expanded ? `Hide projects of ${workspace.name}` : `Show projects of ${workspace.name}`}
              accessibilityState={{ expanded }}
              hitSlop={10}
              onPress={onToggle}
              style={({ pressed }) => [styles.fold, { backgroundColor: selectedProject ? c.brandSoft : c.sunken, opacity: pressed ? 0.6 : 1 }]}
            >
              <T variant="caption" color={selectedProject ? c.brandStrong : c.textMuted} style={{ fontWeight: "600", fontVariant: ["tabular-nums"] }}>
                {count}
              </T>
              <Icon name="down" size={10} color={selectedProject ? c.brandStrong : c.textMuted} weight="bold" style={{ transform: [{ rotate: expanded ? "180deg" : "0deg" }] }} />
            </Pressable>
          ) : null
        }
      />
      {expanded &&
        projects.map((p) => (
          <Choice
            key={p.id}
            nested
            selected={selectedProject === p.id}
            onPress={() => onPick(p.id)}
            icon={p.icon ? <T style={{ fontSize: 15 }}>{p.icon}</T> : <Icon name="folder" size={14} color={c.textMuted} />}
            title={p.name}
            body={p.description}
          />
        ))}
    </View>
  );
}

function Choice({
  selected,
  onPress,
  icon,
  title,
  body,
  trailing,
  nested,
}: {
  selected: boolean;
  onPress: () => void;
  icon: ReactNode;
  title: string;
  body?: string;
  trailing?: ReactNode;
  nested?: boolean;
}) {
  const c = useColors();
  return (
    <View style={styles.line}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onPress={onPress}
        style={({ pressed }) => [styles.choice, nested && styles.nested, { flex: 1 }, pressed && { backgroundColor: c.sunken }]}
      >
        {nested && <View style={[styles.guide, { backgroundColor: c.border }]} />}
        <View style={[styles.tile, nested && styles.tileSmall, { backgroundColor: c.sunken }]}>{icon}</View>
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <T variant="headline" numberOfLines={1} style={{ fontSize: nested ? 15 : 16 }}>
            {title}
          </T>
          {body ? (
            <T variant="footnote" muted numberOfLines={1}>
              {body}
            </T>
          ) : null}
        </View>
        {selected && <Icon name="check" size={16} color={c.brandStrong} weight="bold" />}
      </Pressable>
      {trailing ? <View style={{ paddingRight: space.lg }}>{trailing}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  line: {
    flexDirection: "row",
    alignItems: "center",
  },
  content: {
    paddingTop: 28,
    paddingHorizontal: space.xl,
    paddingBottom: 40,
    gap: space.lg,
  },
  choice: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  nested: {
    paddingLeft: 52,
    paddingVertical: 10,
  },
  guide: {
    position: "absolute",
    left: 33,
    top: 0,
    bottom: 0,
    width: StyleSheet.hairlineWidth * 2,
  },
  tile: {
    width: 36,
    height: 36,
    borderRadius: 11,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  tileSmall: {
    width: 28,
    height: 28,
    borderRadius: 9,
  },
  fold: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    height: 26,
    paddingHorizontal: 9,
    borderRadius: radius.pill,
  },
});
