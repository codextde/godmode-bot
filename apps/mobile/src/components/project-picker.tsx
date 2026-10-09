import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { Project } from "@godmode/shared";
import { Icon } from "./icon";
import { T, tap } from "./ui";
import { radius, space, useColors } from "@/lib/theme";

/** One row of project chips: "No project" and the projects to pick from. Hidden when there are none. */
export function ProjectPicker({
  projects,
  value,
  onChange,
  inset = 0,
  label = "Project",
  hint,
  allowNone = true,
  bleed = 0,
}: {
  projects: Project[];
  value: string | null;
  onChange: (id: string | null) => void;
  inset?: number;
  label?: string;
  hint?: string;
  /** Offer "No project"; off where the agent's own project applies anyway. */
  allowNone?: boolean;
  /** Inside a padded container: the chips scroll to the screen edge instead of being cut off at the padding. */
  bleed?: number;
}) {
  if (!projects.length) return null;
  return (
    <View style={{ gap: space.sm, marginHorizontal: -bleed }}>
      <T variant="eyebrow" muted style={{ paddingHorizontal: inset + bleed }}>
        {label}
      </T>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ gap: space.sm, paddingHorizontal: inset + bleed }}
      >
        {allowNone && <Chip active={!value} label="No project" onPress={() => onChange(null)} />}
        {projects.map((p) => (
          <Chip key={p.id} active={value === p.id} label={p.name} icon={p.icon} folder onPress={() => onChange(p.id)} />
        ))}
      </ScrollView>
      {hint ? (
        <T variant="footnote" muted style={{ paddingHorizontal: inset + bleed }}>
          {hint}
        </T>
      ) : null}
    </View>
  );
}

function Chip({ active, label, icon, folder, onPress }: { active: boolean; label: string; icon?: string; folder?: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={() => {
        tap();
        onPress();
      }}
      style={[styles.chip, { backgroundColor: active ? c.primary : c.sunken }]}
    >
      {icon ? <T style={{ fontSize: 14 }}>{icon}</T> : folder ? <Icon name="folder" size={13} color={active ? c.onPrimary : c.textMuted} /> : null}
      <T variant="subhead" numberOfLines={1} color={active ? c.onPrimary : c.text} style={{ fontWeight: "600" }}>
        {label}
      </T>
    </Pressable>
  );
}

/** A project's name with its icon, small, for rows and headers. */
export function ProjectTag({ project }: { project: Pick<Project, "name" | "icon"> }) {
  const c = useColors();
  return (
    <View style={[styles.tag, { backgroundColor: c.sunken }]}>
      {project.icon ? <T style={{ fontSize: 11 }}>{project.icon}</T> : <Icon name="folder" size={10} color={c.textMuted} />}
      <T variant="caption" numberOfLines={1} style={{ fontWeight: "600", flexShrink: 1 }}>
        {project.name}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 34,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
  },
  tag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    height: 20,
    maxWidth: 140,
    paddingHorizontal: 7,
    borderRadius: 6,
    borderCurve: "continuous",
  },
});
