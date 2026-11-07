import { Link, router } from "expo-router";
import type { ReactNode } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Agent } from "@godmode/shared";
import { useFullAccess } from "./full-access";
import { useMenuSheet, type HeaderMenuItem } from "./header-actions";
import { sfSymbol } from "./icon";
import { tap } from "./ui";
import { useAgents } from "@/lib/hooks";
import { moveAgent, teamOf } from "@/lib/manage";
import { useWorkspace, scopeLabel } from "@/lib/workspace";

/**
 * The org chart's long-press menu, like dragging on the desktop: report to another agent (it moves into that agent's
 * workspace) or move to another workspace, its team along. The system's menu on iOS, sheets on Android: there `children`
 * gets what a long press does.
 */
export function AgentMoveMenu({ agent, children }: { agent: Agent; children: (onLongPress?: () => void) => ReactNode }) {
  const { t } = useTranslation("manage");
  const { data: all = [] } = useAgents();
  const { workspaces } = useWorkspace();
  const fullAccess = useFullAccess().fullAccess === true;
  const menu = useMenuSheet();
  if (agent.isDefault || !fullAccess) return <>{children()}</>;

  const team = new Set(teamOf(agent, all).map((a) => a.id));
  const builtin = all.find((a) => a.isDefault);
  const leads = all.filter((a) => !a.isDefault && a.id !== agent.id && !a.archived && !team.has(a.id));
  const wsName = (id: string | null) => (id ? (workspaces.find((w) => w.id === id)?.name ?? "") : t("agent.global"));

  const reportTo = (lead: Agent | null) => {
    if ((lead?.id ?? null) === agent.reportsTo && (!lead?.workspaceId || lead.workspaceId === agent.workspaceId)) return;
    const ws = lead?.workspaceId ?? agent.workspaceId;
    void moveAgent(
      agent,
      ws !== agent.workspaceId ? { workspaceId: ws, reportsTo: lead?.id ?? null } : { reportsTo: lead?.id ?? null },
      t("move.nowReportsTo", { agent: agent.name, lead: (lead ?? builtin)?.name ?? "Godmode" }),
    );
  };
  const moveTo = (workspaceId: string | null) => {
    if (workspaceId !== agent.workspaceId) void moveAgent(agent, { workspaceId }, t("move.moved", { agent: agent.name, workspace: wsName(workspaceId) }));
  };

  if (process.env.EXPO_OS !== "ios") {
    const lead: HeaderMenuItem[] = [
      ...(builtin ? [{ icon: "agents" as const, title: builtin.name, detail: t("agent.builtIn"), selected: !agent.reportsTo, onPress: () => reportTo(null) }] : []),
      ...leads.map((a) => ({
        icon: "person" as const,
        title: a.name,
        detail: [a.role, a.workspaceId !== agent.workspaceId ? wsName(a.workspaceId) : ""].filter(Boolean).join(" · ") || undefined,
        selected: agent.reportsTo === a.id,
        onPress: () => reportTo(a),
      })),
    ];
    const workspace: HeaderMenuItem[] = [
      { icon: "globe", title: t("agent.global"), selected: !agent.workspaceId, onPress: () => moveTo(null) },
      ...workspaces.filter((w) => !w.archivedAt).map((w) => ({ icon: "layers" as const, title: scopeLabel(w), selected: agent.workspaceId === w.id, onPress: () => moveTo(w.id) })),
    ];
    const root: HeaderMenuItem[] = [
      { icon: "orgChart", title: t("move.reportsTo"), onPress: () => setTimeout(() => menu.show(lead, t("move.reportsTo")), 250) },
      { icon: "layers", title: t("move.moveTo"), onPress: () => setTimeout(() => menu.show(workspace, t("move.moveTo")), 250) },
      { icon: "settings", title: t("move.settings"), onPress: () => router.push({ pathname: "/settings/agent/[id]", params: { id: agent.id } }) },
    ];
    return (
      <>
        {children(() => {
          tap();
          menu.show(root, agent.name);
        })}
        {menu.sheet}
      </>
    );
  }

  return (
    <Link href={{ pathname: "/agent/[id]", params: { id: agent.id } }} asChild>
      <Link.Trigger>
        <View>{children()}</View>
      </Link.Trigger>
      <Link.Menu>
        <Link.Menu title={t("move.reportsTo")} icon={sfSymbol("orgChart")}>
          {builtin ? (
            <Link.MenuAction subtitle={t("agent.builtIn")} isOn={!agent.reportsTo} onPress={() => reportTo(null)}>
              {builtin.name}
            </Link.MenuAction>
          ) : null}
          {leads.map((a) => (
            <Link.MenuAction key={a.id} subtitle={[a.role, a.workspaceId !== agent.workspaceId ? wsName(a.workspaceId) : ""].filter(Boolean).join(" · ") || undefined} isOn={agent.reportsTo === a.id} onPress={() => reportTo(a)}>
              {a.name}
            </Link.MenuAction>
          ))}
        </Link.Menu>
        <Link.Menu title={t("move.moveTo")} icon={sfSymbol("layers")}>
          <Link.MenuAction icon={sfSymbol("globe")} isOn={!agent.workspaceId} onPress={() => moveTo(null)}>
            {t("agent.global")}
          </Link.MenuAction>
          {workspaces.map((w) => (
            <Link.MenuAction key={w.id} isOn={agent.workspaceId === w.id} onPress={() => moveTo(w.id)}>
              {scopeLabel(w)}
            </Link.MenuAction>
          ))}
        </Link.Menu>
        <Link.MenuAction icon={sfSymbol("settings")} onPress={() => router.push({ pathname: "/settings/agent/[id]", params: { id: agent.id } })}>
          {t("move.settings")}
        </Link.MenuAction>
      </Link.Menu>
    </Link>
  );
}
