import { Link, router } from "expo-router";
import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Agent } from "@godmode/shared";
import { useFullAccess } from "./full-access";
import { MenuSheet, type HeaderMenuItem } from "./header-actions";
import { sfSymbol } from "./icon";
import { useAgents } from "@/lib/hooks";
import { moveAgent, teamOf } from "@/lib/manage";
import { useWorkspace } from "@/lib/workspace";

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
  const [sheet, setSheet] = useState<"root" | "lead" | "workspace" | null>(null);
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
    const items: HeaderMenuItem[] =
      sheet === "lead"
        ? [...(builtin ? [{ icon: "agents" as const, title: builtin.name, onPress: () => reportTo(null) }] : []), ...leads.map((a) => ({ icon: "person" as const, title: a.name, onPress: () => reportTo(a) }))]
        : sheet === "workspace"
          ? [{ icon: "globe" as const, title: t("agent.global"), onPress: () => moveTo(null) }, ...workspaces.filter((w) => !w.archivedAt).map((w) => ({ icon: "layers" as const, title: w.name, onPress: () => moveTo(w.id) }))]
          : [
              { icon: "orgChart", title: t("move.reportsTo"), onPress: () => setTimeout(() => setSheet("lead"), 250) },
              { icon: "layers", title: t("move.moveTo"), onPress: () => setTimeout(() => setSheet("workspace"), 250) },
            ];
    return (
      <>
        {children(() => setSheet("root"))}
        <MenuSheet items={items} open={!!sheet} onClose={() => setSheet(null)} />
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
              {`${w.icon ? `${w.icon} ` : ""}${w.name}`}
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
