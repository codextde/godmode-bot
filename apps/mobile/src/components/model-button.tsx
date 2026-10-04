import { router } from "expo-router";
import { Pressable, StyleSheet, View, type ColorValue } from "react-native";
import { EFFORT_LABELS, type Agent } from "@godmode/shared";
import { Icon } from "./icon";
import { T, tap } from "./ui";
import { useEffectiveModel, type ModelChoice } from "@/lib/composer";
import { radius, useColors } from "@/lib/theme";

export function EffortGlyph({ level, count, color }: { level: number; count: number; color: ColorValue }) {
  return (
    <View style={styles.glyph} accessible={false}>
      {Array.from({ length: count }, (_, i) => (
        <View
          key={i}
          style={{ width: 2.5, borderRadius: 2, backgroundColor: color, opacity: i <= level ? 0.9 : 0.25, height: 4 + (8 * i) / Math.max(1, count - 1) }}
        />
      ))}
    </View>
  );
}

/** The model and effort a chat runs with, in the composer's toolbar; opens the picker. */
export function ModelButton({ agent, choice, conversationId }: { agent?: Agent; choice: ModelChoice; conversationId?: string }) {
  const c = useColors();
  const { current, effort, ultracode } = useEffectiveModel(agent, choice);
  const summary = [current.label, effort && `${EFFORT_LABELS[effort]} effort`, ultracode && "Ultracode"].filter(Boolean).join(", ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Model: ${summary}`}
      accessibilityHint="Choose the model and effort"
      hitSlop={4}
      onPress={() => {
        tap();
        router.push({ pathname: "/model", params: conversationId ? { conversationId } : { agentId: agent?.id ?? "" } });
      }}
      style={({ pressed }) => [styles.button, { opacity: pressed ? 0.6 : 1 }]}
    >
      <T variant="footnote" muted numberOfLines={1} style={{ fontWeight: "600", flexShrink: 1 }}>
        {current.label}
      </T>
      {effort ? <EffortGlyph level={current.efforts.indexOf(effort)} count={current.efforts.length} color={c.textMuted} /> : null}
      {ultracode ? <Icon name="workflow" size={12} color={c.textMuted} /> : null}
      <Icon name="down" size={10} weight="bold" color={c.textFaint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 36,
    maxWidth: 170,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
  },
  glyph: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 2,
    height: 12,
  },
});
