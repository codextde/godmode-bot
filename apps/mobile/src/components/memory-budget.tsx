import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { AgentMemory } from "@godmode/shared";
import { Row, T } from "./ui";
import { intlLocale } from "@/lib/i18n";
import { alpha, radius, useColors } from "@/lib/theme";

/** What the memory takes of what dreams keep it under (`target`); past `limit` chats only load its start. */
export function MemoryBudget({ chars, memory }: { chars: number; memory: Pick<AgentMemory, "target" | "limit"> }) {
  const c = useColors();
  const { t } = useTranslation("memory");
  const { target, limit } = memory;
  const cut = chars > limit;
  const over = chars > target;
  const tone = cut ? c.danger : over ? c.warning : c.dream;
  const hint = cut
    ? t("budget.cut", { limit: limit.toLocaleString(intlLocale()) })
    : over
      ? t("budget.over", { over: (chars - target).toLocaleString(intlLocale()) })
      : t("budget.full");
  return (
    <View style={{ gap: 6 }}>
      <Row style={{ justifyContent: "space-between" }}>
        <T variant="footnote" style={{ fontVariant: ["tabular-nums"] }}>
          <T variant="footnote" color={cut || over ? tone : c.text} style={{ fontWeight: "600" }}>
            {chars.toLocaleString(intlLocale())}
          </T>
          <T variant="footnote" muted>{` ${t("budget.ofTarget", { target: target.toLocaleString(intlLocale()) })}`}</T>
        </T>
      </Row>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel={t("budget.a11y")}
        accessibilityValue={{ min: 0, max: limit, now: Math.min(chars, limit) }}
        style={[styles.track, { backgroundColor: c.sunken }]}
      >
        <View style={[styles.fill, { width: `${Math.min(100, (chars / limit) * 100)}%`, backgroundColor: alpha(tone, cut || over ? 1 : 0.7) }]} />
        <View style={[styles.tick, { left: `${(target / limit) * 100}%`, backgroundColor: alpha(c.text, 0.35) }]} />
      </View>
      <T variant="caption" muted>
        {hint}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 5,
    borderRadius: radius.pill,
    overflow: "visible",
  },
  fill: {
    height: "100%",
    borderRadius: radius.pill,
  },
  tick: {
    position: "absolute",
    top: -2,
    bottom: -2,
    width: 1,
  },
});
