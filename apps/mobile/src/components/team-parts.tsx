import { SymbolView, type AndroidSymbol, type SFSymbol } from "expo-symbols";
import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { AgentTemplate, OrgTemplateNode, TeamTemplate } from "@godmode/shared";
import { Character } from "./character";
import { T, tap } from "./ui";
import { teamText } from "@/lib/templates";
import { radius, space, useColors } from "@/lib/theme";

/** The desktop draws these lucide icons; the same meaning in SF Symbols and Material Symbols. */
const SYMBOLS: Record<string, [SFSymbol, AndroidSymbol]> = {
  rocket: ["paperplane.fill", "rocket_launch"],
  briefcase: ["briefcase.fill", "work"],
  "shopping-bag": ["bag.fill", "shopping_bag"],
  building: ["building.2.fill", "apartment"],
  "user-round": ["person.crop.circle", "account_circle"],
  archive: ["archivebox.fill", "inventory_2"],
  megaphone: ["megaphone.fill", "campaign"],
  handshake: ["person.2.fill", "handshake"],
  code: ["chevron.left.forwardslash.chevron.right", "code"],
  flask: ["testtube.2", "science"],
  layers: ["square.3.layers.3d", "layers"],
  landmark: ["building.columns.fill", "account_balance"],
  cpu: ["cpu", "memory"],
  compass: ["safari", "explore"],
  scale: ["scalemass.fill", "balance"],
  "heart-handshake": ["heart.fill", "volunteer_activism"],
  "trending-up": ["chart.line.uptrend.xyaxis", "trending_up"],
  palette: ["paintpalette.fill", "palette"],
  "life-buoy": ["lifepreserver", "support"],
  "shopping-cart": ["cart.fill", "shopping_cart"],
  shield: ["shield.fill", "shield"],
  "bar-chart": ["chart.bar.fill", "bar_chart"],
  factory: ["gearshape.2.fill", "factory"],
};

export function TeamIcon({ icon, size = 36 }: { icon: string; size?: number }) {
  const c = useColors();
  const [ios, android] = SYMBOLS[icon] ?? (["person.3.fill", "groups"] as [SFSymbol, AndroidSymbol]);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.icon, { width: size, height: size, borderRadius: size * 0.28, backgroundColor: c.sunken }]}
    >
      <SymbolView name={{ ios, android }} size={size * 0.46} tintColor={c.text} weight="medium" style={{ width: size * 0.46, height: size * 0.46 }} />
    </View>
  );
}

/** One place in a team template: its role, where it sits ("0", "0.2" = the top's third report) and who reports to it. */
export interface Seat {
  path: string;
  depth: number;
  template: AgentTemplate;
  reports: Seat[];
}

export function seatTree(node: OrgTemplateNode, byId: Map<string, AgentTemplate>, path = "0", depth = 0): Seat | null {
  const template = byId.get(node.template);
  if (!template) return null;
  const reports = (node.reports ?? []).map((r, i) => seatTree(r, byId, `${path}.${i}`, depth + 1)).filter((s): s is Seat => !!s);
  return { path, depth, template, reports };
}

export const flatSeats = (s: Seat): Seat[] => [s, ...s.reports.flatMap(flatSeats)];

/** Reports drawn under the top before the rest become a count. */
const MINI_REPORTS = 5;

/** The chart in miniature: the top, a line down, its reports in a row. */
function MiniChart({ root }: { root: Seat }) {
  const c = useColors();
  const shown = root.reports.length > MINI_REPORTS ? root.reports.slice(0, MINI_REPORTS - 1) : root.reports;
  const rest = root.reports.slice(shown.length).reduce((n, r) => n + flatSeats(r).length, 0);
  const columns = shown.length + (rest ? 1 : 0);
  return (
    <View style={styles.mini} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Character character={root.template.character} color={root.template.color} size={34} seed={root.template.id} />
      <View style={[styles.stem, { backgroundColor: c.border }]} />
      <View style={{ flexDirection: "row", gap: 6 }}>
        {columns > 1 ? <View style={[styles.rail, { backgroundColor: c.border }]} /> : null}
        {shown.map((r) => (
          <View key={r.path} style={styles.column}>
            <View style={[styles.drop, { backgroundColor: c.border }]} />
            <Character character={r.template.character} color={r.template.color} size={24} seed={r.template.id} />
          </View>
        ))}
        {rest ? (
          <View style={styles.column}>
            <View style={[styles.drop, { backgroundColor: c.border }]} />
            <View style={[styles.more, { backgroundColor: c.sunken }]}>
              <T variant="caption" muted style={{ fontSize: 10, fontWeight: "600" }}>{`+${rest}`}</T>
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** A team or company to install: what it is, how many it brings, and its chart in miniature. */
export function TeamCard({ team, root }: { team: TeamTemplate; root: Seat }) {
  const c = useColors();
  const { t } = useTranslation("agents");
  const text = teamText(team);
  const total = flatSeats(root).length;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${text.name}, ${t("team.agentCount", { count: total })}`}
      onPress={() => {
        tap();
        router.push({ pathname: "/settings/team/[id]", params: { id: team.id } });
      }}
      style={({ pressed }) => [styles.card, { backgroundColor: pressed ? c.sunken : c.surface, borderColor: c.border }]}
    >
      <View style={{ flexDirection: "row", gap: space.md, alignItems: "center" }}>
        <TeamIcon icon={team.icon} size={32} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant="subhead" numberOfLines={1} style={{ fontWeight: "600" }}>
            {text.name}
          </T>
          <T variant="caption" muted>
            {t("team.agentCount", { count: total })}
          </T>
        </View>
      </View>
      <T variant="footnote" muted numberOfLines={2} style={{ minHeight: 34 }}>
        {text.description}
      </T>
      <MiniChart root={root} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  icon: {
    alignItems: "center",
    justifyContent: "center",
    borderCurve: "continuous",
  },
  card: {
    width: 232,
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  mini: {
    alignItems: "center",
    paddingTop: space.xs,
  },
  stem: {
    width: StyleSheet.hairlineWidth * 2,
    height: 8,
  },
  rail: {
    position: "absolute",
    top: 0,
    left: 13,
    right: 13,
    height: StyleSheet.hairlineWidth * 2,
  },
  column: {
    width: 26,
    alignItems: "center",
  },
  drop: {
    width: StyleSheet.hairlineWidth * 2,
    height: 6,
  },
  more: {
    width: 24,
    height: 24,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
});
