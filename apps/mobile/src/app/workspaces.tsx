import { router } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Icon } from "@/components/icon";
import { Card, Hairline, T, tap } from "@/components/ui";
import { useWorkspace } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

/** Pick the workspace the phone works in: chats, tasks and agents follow it, and new ones start in it. */
export default function Workspaces() {
  const c = useColors();
  const { id, workspaces, select } = useWorkspace();

  const pick = (next: string | null) => {
    tap();
    select(next);
    router.back();
  };

  return (
    <ScrollView contentContainerStyle={styles.content} style={{ backgroundColor: c.background }}>
      <View style={{ gap: 4 }}>
        <T variant="title">Workspace</T>
        <T variant="subhead" muted>
          Chats and tasks you start from this phone go into the workspace you pick.
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
        {workspaces.map((w) => (
          <View key={w.id}>
            <Hairline inset={64} />
            <Choice
              selected={w.id === id}
              onPress={() => pick(w.id)}
              icon={<T style={{ fontSize: 19 }}>{w.icon || "🗂️"}</T>}
              title={w.name}
              body={w.description}
            />
          </View>
        ))}
      </Card>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          tap();
          router.replace("/settings/workspaces");
        }}
        style={({ pressed }) => [styles.manage, { backgroundColor: c.sunken, opacity: pressed ? 0.7 : 1 }]}
      >
        <Icon name="slider" size={15} color={c.text} />
        <T variant="subhead" style={{ fontWeight: "600" }}>
          Manage workspaces
        </T>
      </Pressable>
    </ScrollView>
  );
}

function Choice({ selected, onPress, icon, title, body }: { selected: boolean; onPress: () => void; icon: ReactNode; title: string; body?: string }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.choice, pressed && { backgroundColor: c.sunken }]}
    >
      <View style={[styles.tile, { backgroundColor: c.sunken }]}>{icon}</View>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <T variant="headline" numberOfLines={1} style={{ fontSize: 16 }}>
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
  );
}

const styles = StyleSheet.create({
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
  manage: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    height: 44,
    borderRadius: radius.pill,
  },
  tile: {
    width: 36,
    height: 36,
    borderRadius: 11,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
});
