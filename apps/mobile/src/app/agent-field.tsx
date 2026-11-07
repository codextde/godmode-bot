import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { leadProblem, type Agent } from "@godmode/shared";
import type { AgentField } from "@/components/agent-setup";
import { CharacterAvatar } from "@/components/character";
import { Group } from "@/components/form";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { PickRow, PickSheet } from "@/components/pick-sheet";
import { Button, EmptyState, ErrorState, LoadingState, SkeletonRows } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { ik, integrationsApi } from "@/lib/integrations";
import { manageApi, mk, moveAgent, patchAgentSetup } from "@/lib/manage";
import { qk } from "@/lib/query";
import { sshAddress } from "@/lib/ssh-admin";
import { useWorkspace } from "@/lib/workspace";

const TITLES: Record<AgentField, string> = {
  workspace: "agent.workspace",
  lead: "agent.reportsTo",
  browserProfile: "agent.profile",
  display: "agent.screen",
  vm: "agent.vm",
  ssh: "agent.ssh",
  android: "agent.android",
  mcp: "agent.mcp",
};

/** One of an agent's places or tools, picked like in the desktop's agent form; single choices close the sheet. */
export default function AgentFieldSheet() {
  const { t } = useTranslation("manage");
  const { id, field } = useLocalSearchParams<{ id: string; field: AgentField }>();
  const { byId, isPending } = useAgents();
  const { fullAccess } = useFullAccess();
  const agent = byId.get(id);
  const title = t((TITLES[field] ?? "agent.workspace") as "agent.workspace");

  if (fullAccess === false) {
    return (
      <PickSheet title={title}>
        <NeedsFullAccess />
      </PickSheet>
    );
  }
  if (!agent) {
    return (
      <PickSheet title={title}>
        {isPending ? <LoadingState /> : <EmptyState icon="agents" title={t("agent.gone")} />}
      </PickSheet>
    );
  }
  return (
    <PickSheet title={title}>
      {field === "workspace" ? <WorkspacePick agent={agent} /> : null}
      {field === "lead" ? <LeadPick agent={agent} /> : null}
      {field === "browserProfile" ? <ProfilePick agent={agent} /> : null}
      {field === "display" ? <DisplayPick agent={agent} /> : null}
      {field === "vm" ? <VmPick agent={agent} /> : null}
      {field === "ssh" ? <SshPick agent={agent} /> : null}
      {field === "android" ? <AndroidPick agent={agent} /> : null}
      {field === "mcp" ? <McpPick agent={agent} /> : null}
    </PickSheet>
  );
}

interface ListState<T> {
  data: T[] | undefined;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

/** A list's loading, error and empty states around its rows. */
function Choices<T>({ query, empty, children }: { query: ListState<T>; empty?: ReactNode; children: (list: T[]) => ReactNode }) {
  const { t } = useTranslation("manage");
  if (query.data) return query.data.length || !empty ? <Group>{children(query.data)}</Group> : <>{empty}</>;
  if (query.isError) return <ErrorState title={t("agent.loadFailed")} error={errorText(query.error)} onRetry={() => void query.refetch()} />;
  return (
    <Group>
      <SkeletonRows count={3} avatar={30} />
    </Group>
  );
}

const toggled = (ids: string[], id: string) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);

function WorkspacePick({ agent }: { agent: Agent }) {
  const { t } = useTranslation("manage");
  const { workspaces } = useWorkspace();
  const pick = (workspaceId: string | null, name: string) => {
    router.back();
    if (workspaceId !== agent.workspaceId) void moveAgent(agent, { workspaceId }, t("move.moved", { agent: agent.name, workspace: name }));
  };
  return (
    <Group>
      <PickRow icon="globe" title={t("agent.global")} detail={t("agent.globalDetail")} selected={!agent.workspaceId} onPress={() => pick(null, t("agent.global"))} />
      {workspaces.map((w) => (
        <PickRow key={w.id} emoji={w.icon || "🗂️"} title={w.name} detail={w.description || undefined} selected={agent.workspaceId === w.id} onPress={() => pick(w.id, w.name)} />
      ))}
    </Group>
  );
}

/** Like the desktop's "Reports to": the built-in agent, or an agent of its workspace or a global one that doesn't report to it. */
function LeadPick({ agent }: { agent: Agent }) {
  const { t } = useTranslation("manage");
  const { data: agents = [] } = useAgents();
  const builtin = agents.find((a) => a.isDefault);
  const leads = agents.filter((a) => !a.isDefault && a.id !== agent.id && !a.archived && !leadProblem(agent, a, agents));
  const pick = (lead: Agent | null) => {
    router.back();
    if ((lead?.id ?? null) !== agent.reportsTo) void moveAgent(agent, { reportsTo: lead?.id ?? null }, t("move.nowReportsTo", { agent: agent.name, lead: (lead ?? builtin)?.name ?? "Godmode" }));
  };
  return (
    <Group>
      {builtin ? (
        <PickRow lead={<CharacterAvatar agent={builtin} size={30} />} title={builtin.name} detail={t("agent.builtIn")} selected={!agent.reportsTo} onPress={() => pick(null)} />
      ) : null}
      {leads.map((a) => (
        <PickRow
          key={a.id}
          lead={<CharacterAvatar agent={a} size={30} />}
          title={a.name}
          detail={[a.role, a.enabled ? "" : t("agent.switchedOff")].filter(Boolean).join(" · ") || undefined}
          selected={agent.reportsTo === a.id}
          onPress={() => pick(a)}
        />
      ))}
    </Group>
  );
}

function ProfilePick({ agent }: { agent: Agent }) {
  const { t } = useTranslation("manage");
  const profiles = useQuery({ queryKey: qk.browserProfiles, queryFn: api.browser.profiles });
  const pick = (profileId: string | null) => {
    router.back();
    if (profileId !== agent.browser.profileId) void patchAgentSetup(agent.id, { browser: { ...agent.browser, profileId } });
  };
  const usable = (profiles.data ?? []).filter((p) => !p.workspaceId || p.workspaceId === agent.workspaceId || p.id === agent.browser.profileId);
  const fallback = usable.find((p) => p.workspaceId && p.workspaceId === agent.workspaceId && p.isDefault) ?? usable.find((p) => !p.workspaceId && p.isDefault);
  return (
    <Choices query={profiles}>
      {() => (
        <>
          <PickRow icon="globe" title={t("agent.defaultProfile")} detail={fallback?.name} selected={!agent.browser.profileId} onPress={() => pick(null)} />
          {usable.map((p) => (
            <PickRow
              key={p.id}
              icon="personCircle"
              title={p.name}
              detail={[p.id === fallback?.id ? t("agent.defaultTag") : "", p.cookieCount ? t("agent.cookies", { count: p.cookieCount }) : ""].filter(Boolean).join(" · ") || undefined}
              selected={agent.browser.profileId === p.id}
              onPress={() => pick(p.id)}
            />
          ))}
        </>
      )}
    </Choices>
  );
}

function DisplayPick({ agent }: { agent: Agent }) {
  const { t } = useTranslation("manage");
  const sources = useQuery({ queryKey: mk.computerSources, queryFn: manageApi.computerSources, staleTime: 30_000, retry: false });
  const target = agent.computer.target;
  const current = target?.kind === "display" ? target.displayId : null;
  const pick = (display: { id: string; name: string } | null) => {
    router.back();
    if ((display?.id ?? null) !== current)
      void patchAgentSetup(agent.id, { computer: { ...agent.computer, target: display ? { kind: "display", displayId: display.id, name: display.name } : null } });
  };
  const displays = sources.data?.displays ?? [];
  const known = !current || displays.some((d) => d.id === current);
  return (
    <Choices query={{ ...sources, data: sources.data?.displays }}>
      {() => (
        <>
          <PickRow icon="display" title={t("agent.entireDesktop")} selected={!current} onPress={() => pick(null)} />
          {displays.map((d) => (
            <PickRow key={d.id} icon="display" title={d.primary ? t("agent.primary", { name: d.name }) : d.name} detail={`${d.width} × ${d.height}`} selected={current === d.id} onPress={() => pick(d)} />
          ))}
          {!known && current ? <PickRow icon="warning" title={t("agent.disconnected", { id: current })} selected onPress={() => router.back()} /> : null}
        </>
      )}
    </Choices>
  );
}

function VmPick({ agent }: { agent: Agent }) {
  const { t } = useTranslation("manage");
  const { workspaces } = useWorkspace();
  const vms = useQuery({ queryKey: qk.vms, queryFn: api.vms.list, retry: false });
  const workspaceVm = vms.data?.find((v) => v.id === workspaces.find((w) => w.id === agent.workspaceId)?.vmId);
  const pick = (vmId: string | null) => {
    router.back();
    if (vmId !== agent.vmId) void patchAgentSetup(agent.id, { vmId });
  };
  return (
    <Choices query={vms}>
      {(list) => (
        <>
          <PickRow icon="layers" title={workspaceVm ? t("agent.vmWorkspaceNamed", { vm: workspaceVm.name }) : t("agent.vmNone")} selected={!agent.vmId} onPress={() => pick(null)} />
          {list.map((v) => (
            <PickRow key={v.id} icon="vm" title={v.name} selected={agent.vmId === v.id} onPress={() => pick(v.id)} />
          ))}
        </>
      )}
    </Choices>
  );
}

function SshPick({ agent }: { agent: Agent }) {
  const { t } = useTranslation("manage");
  const servers = useQuery({ queryKey: ik.sshServers, queryFn: integrationsApi.sshServers });
  return (
    <Choices
      query={servers}
      empty={
        <EmptyState
          icon="server"
          title={t("agent.sshEmpty")}
          action={<Button title={t("agent.sshAdd")} icon="plus" variant="secondary" onPress={() => router.replace("/settings/ssh-server")} />}
        />
      }
    >
      {(list) =>
        list.map((s) => (
          <PickRow
            key={s.id}
            multi
            icon="server"
            title={s.name}
            detail={sshAddress(s)}
            selected={agent.sshServerIds.includes(s.id)}
            onPress={() => void patchAgentSetup(agent.id, { sshServerIds: toggled(agent.sshServerIds, s.id) })}
          />
        ))
      }
    </Choices>
  );
}

function AndroidPick({ agent }: { agent: Agent }) {
  const { t } = useTranslation("manage");
  const devices = useQuery({ queryKey: qk.androidDevices, queryFn: api.android.devices, retry: false });
  return (
    <Choices query={devices} empty={<EmptyState icon="phone" title={t("agent.androidEmpty")} />}>
      {(list) =>
        list.map((d) => (
          <PickRow
            key={d.id}
            multi
            icon="phone"
            title={d.name}
            detail={[d.manufacturer, d.model, d.androidVersion ? `Android ${d.androidVersion}` : null].filter(Boolean).join(" · ") || undefined}
            selected={agent.androidDeviceIds.includes(d.id)}
            onPress={() => void patchAgentSetup(agent.id, { androidDeviceIds: toggled(agent.androidDeviceIds, d.id) })}
          />
        ))
      }
    </Choices>
  );
}

/** Servers of every scope, except those another agent keeps for itself (like the desktop's list). */
function McpPick({ agent }: { agent: Agent }) {
  const { t } = useTranslation("manage");
  const servers = useQuery({ queryKey: ik.mcpServers, queryFn: integrationsApi.mcpServers });
  return (
    <Choices
      query={{ ...servers, data: servers.data?.filter((s) => !s.agentId || s.agentId === agent.id) }}
      empty={<EmptyState icon="plug" title={t("agent.mcpEmpty")} />}
    >
      {(list) =>
        list.map((s) => (
          <PickRow
            key={s.id}
            multi
            icon="plug"
            title={s.name}
            detail={s.source === "composio" ? "Composio" : s.transport}
            selected={agent.mcpServerIds.includes(s.id)}
            onPress={() => void patchAgentSetup(agent.id, { mcpServerIds: toggled(agent.mcpServerIds, s.id) })}
          />
        ))
      }
    </Choices>
  );
}

