import { router, Stack } from "expo-router";
import { memo, useMemo } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { leadOf, teamTree, type Agent, type TeamNode, type Workspace } from "@godmode/shared";
import { AgentMoveMenu } from "@/components/agent-move-menu";
import { CharacterAvatar, moodOf, presenceText, useAgentPresence } from "@/components/character";
import { Icon } from "@/components/icon";
import { Badge, Button, Card, EmptyState, ErrorState, LiveDot, SkeletonRows, T, tap } from "@/components/ui";
import { WorkspaceChip } from "@/components/workspace-chip";
import { errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { useRunCounts } from "@/lib/live";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { agentsFor, useWorkspace } from "@/lib/workspace";
import { alpha, radius, space, useColors } from "@/lib/theme";

interface Panel {
  key: string;
  title: string;
  workspace?: Workspace;
  lead?: Agent;
  roots: TeamNode<Agent>[];
}

const NONE = { running: 0, queued: 0 };

function openAgent(id: string) {
  tap();
  router.push({ pathname: "/agent/[id]", params: { id } });
}

const size = (n: TeamNode<Agent>): number => 1 + n.reports.reduce((s, r) => s + size(r), 0);

/**
 * Who reports to whom, like the desktop's chart: the built-in agent on top, then a card per workspace (all workspaces)
 * or per team (one workspace) with everyone under their lead. A long press moves an agent to another lead or workspace.
 */
export default function OrgChart() {
  const { t } = useTranslation(["agents", "common"]);
  const agents = useAgents();
  const { id: scope, workspaces } = useWorkspace();
  const pull = usePullRefresh(agents.refetch);
  const all = useMemo(() => agents.data ?? [], [agents.data]);
  const shown = useMemo(() => agentsFor(all, scope), [all, scope]);
  const byWorkspace = !scope && shown.some((a) => a.workspaceId);

  const { hub, panels } = useMemo(() => {
    const groups = teamTree(shown, all, { byWorkspace });
    let hub: TeamNode<Agent> | null = null;
    for (const g of groups) {
      const i = g.roots.findIndex((n) => n.agent.isDefault);
      if (i < 0) continue;
      hub = g.roots[i]!;
      g.roots = [...hub.reports, ...g.roots.filter((_, j) => j !== i)];
    }
    const panels: Panel[] = [];
    if (byWorkspace) {
      const order = new Map(workspaces.map((w, i) => [w.id, i]));
      for (const g of groups) {
        if (!g.roots.length) continue;
        const workspace = workspaces.find((w) => w.id === g.workspaceId);
        panels.push({ key: g.workspaceId ?? "global", title: workspace?.name ?? t("org.global"), workspace, roots: g.roots });
      }
      panels.sort((a, b) => (a.key === "global" ? -1 : (order.get(a.key) ?? 1e9)) - (b.key === "global" ? -1 : (order.get(b.key) ?? 1e9)));
    } else {
      const roots = groups.flatMap((g) => g.roots);
      const direct = new Set(hub?.reports.map((n) => n.agent.id));
      const loose = roots.filter((n) => !n.reports.length && direct.has(n.agent.id));
      const others = roots.filter((n) => !n.reports.length && !direct.has(n.agent.id));
      if (loose.length && hub) panels.push({ key: "direct", title: t("org.reportsTo", { name: hub.agent.name }), lead: hub.agent, roots: loose });
      for (const team of roots.filter((n) => n.reports.length)) panels.push({ key: `team-${team.agent.id}`, title: t("org.teamOf", { name: team.agent.name }), lead: team.agent, roots: [team] });
      if (others.length) panels.push({ key: "others", title: hub ? t("org.others") : t("common:words.agents"), roots: others });
    }
    return { hub, panels };
  }, [shown, all, byWorkspace, workspaces, t]);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Title>{t("org.title")}</Stack.Title>
      <View style={{ alignItems: "flex-start" }}>
        <WorkspaceChip />
      </View>
      {agents.isLoading && !all.length ? (
        <Card>
          <SkeletonRows count={6} avatar={34} />
        </Card>
      ) : agents.isError && !all.length ? (
        <ErrorState title={t("org.loadFailed")} error={errorText(agents.error)} onRetry={() => void agents.refetch()} />
      ) : !shown.length ? (
        <EmptyState icon="orgChart" title={t("org.emptyTitle")} />
      ) : (
        <>
          {hub ? <Hub agent={hub.agent} reports={shown.filter((a) => !a.isDefault && leadOf(a, all)?.id === hub.agent.id).length} /> : null}
          {panels.map((p) => (
            <View key={p.key}>
              <View style={styles.panelHead}>
                <PanelIcon panel={p} />
                <T variant="eyebrow" muted style={{ flex: 1 }} numberOfLines={1}>
                  {p.title}
                </T>
                <T variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
                  {p.roots.reduce((n, r) => n + size(r), 0)}
                </T>
              </View>
              <Card style={styles.panel}>
                {p.roots.map((n) => (
                  <Branch key={n.agent.id} node={n} />
                ))}
              </Card>
            </View>
          ))}
          {all.length === 1 && hub ? (
            <EmptyState
              icon="agents"
              title={t("org.hireFirst")}
              body={t("org.hireFirstBody", { name: hub.agent.name })}
              action={<Button title={t("org.newAgent")} icon="plus" variant="secondary" onPress={() => router.push({ pathname: "/settings/new", params: { kind: "agent", workspaceId: scope ?? "" } })} />}
            />
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

function PanelIcon({ panel }: { panel: Panel }) {
  const c = useColors();
  if (panel.workspace) return <T style={{ fontSize: 14 }}>{panel.workspace.icon || "🗂️"}</T>;
  if (panel.lead) return <CharacterAvatar agent={panel.lead} size={20} />;
  return <Icon name={panel.key === "global" ? "globe" : "agents"} size={14} color={c.textMuted} />;
}

/** The built-in agent: everyone without a lead of their own reports to it. */
function Hub({ agent, reports }: { agent: Agent; reports: number }) {
  const colors = useColors();
  const { t } = useTranslation("agents");
  const counts = useRunCounts().get(agent.id) ?? NONE;
  const presence = useAgentPresence(agent, counts);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => openAgent(agent.id)}
      style={({ pressed }) => [styles.hub, { backgroundColor: pressed ? colors.sunken : colors.surface, borderColor: presence.state === "working" ? alpha(colors.brand, 0.5) : colors.border }]}
    >
      <CharacterAvatar agent={agent} size={52} mood={moodOf(presence)} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <T variant="headline" numberOfLines={1} style={{ flexShrink: 1 }}>
            {agent.name}
          </T>
          <Badge label={t("org.builtIn")} dot={false} />
        </View>
        <T variant="footnote" muted numberOfLines={1}>
          {presenceText(presence)}
        </T>
        <T variant="footnote" muted numberOfLines={2}>
          {t("org.leadsDirectly", { count: reports })}
        </T>
      </View>
      <Icon name="chevron" size={12} color={colors.textFaint} weight="semibold" />
    </Pressable>
  );
}

function Branch({ node }: { node: TeamNode<Agent> }) {
  const c = useColors();
  return (
    <View>
      <Node agent={node.agent} reports={node.reports.length} leadElsewhere={node.leadElsewhere} />
      {node.reports.length ? (
        <View style={[styles.reports, { borderLeftColor: c.border }]}>
          {node.reports.map((r) => (
            <Branch key={r.agent.id} node={r} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const Node = memo(function Node({ agent, reports, leadElsewhere }: { agent: Agent; reports: number; leadElsewhere: Agent | null }) {
  const c = useColors();
  const { t } = useTranslation("agents");
  const counts = useRunCounts().get(agent.id) ?? NONE;
  const presence = useAgentPresence(agent, counts);
  const { state } = presence;
  const dot = state === "idle" ? c.success : state === "waiting" || state === "paused" ? c.warning : state === "failed" ? c.danger : alpha(c.textMuted, 0.5);
  const detail = [agent.role || null, leadElsewhere ? t("org.reportsTo", { name: leadElsewhere.name }) : null].filter(Boolean).join(" · ");
  return (
    <AgentMoveMenu agent={agent}>
      {(onLongPress) => <Pressable
        accessibilityRole="button"
        accessibilityLabel={[agent.name, detail, presenceText(presence)].filter(Boolean).join(", ")}
        onPress={() => openAgent(agent.id)}
        onLongPress={onLongPress}
        style={({ pressed }) => [styles.node, pressed && { backgroundColor: c.sunken }]}
      >
        <CharacterAvatar agent={agent} size={34} mood={moodOf(presence)} running={state === "working"} />
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {state === "working" ? <LiveDot size={6} /> : <View style={[styles.dot, { backgroundColor: dot }]} />}
            <T variant="callout" numberOfLines={1} style={{ flexShrink: 1, fontWeight: "500" }}>
              {agent.name}
            </T>
          </View>
          <T variant="footnote" muted numberOfLines={1}>
            {detail || presenceText(presence)}
          </T>
        </View>
        {reports ? (
          <View style={[styles.count, { backgroundColor: c.sunken }]}>
            <Icon name="orgChart" size={10} color={c.textMuted} />
            <T variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
              {reports}
            </T>
          </View>
        ) : null}
      </Pressable>}
    </AgentMoveMenu>
  );
});

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: space.lg,
    paddingBottom: 140,
    gap: space.lg,
  },
  hub: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  panelHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: 4,
    paddingBottom: space.sm,
  },
  panel: {
    padding: space.xs,
  },
  node: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: 8,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  reports: {
    marginLeft: space.sm + 16,
    paddingLeft: space.sm,
    borderLeftWidth: StyleSheet.hairlineWidth * 2,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  count: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
});
