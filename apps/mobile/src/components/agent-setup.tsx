import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { Alert } from "react-native";
import { useTranslation } from "react-i18next";
import type { Agent } from "@godmode/shared";
import { Group, LinkRow, SegmentRow, SwitchRow } from "./form";
import { useFullAccess } from "./full-access";
import { api } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { ik, integrationsApi } from "@/lib/integrations";
import { folderName, patchAgentSetup } from "@/lib/manage";
import { qk } from "@/lib/query";
import { useSettings } from "@/lib/setup";
import { useWorkspace } from "@/lib/workspace";

/** What the sheet `agent-field` picks for an agent. */
export type AgentField = "workspace" | "lead" | "browserProfile" | "display" | "vm" | "ssh" | "android" | "mcp";

type Window = "default" | "visible" | "headless";

const lockedAlert = (title: string) => Alert.alert(title);

/** The field's picker, or the lock state for a phone without full access. */
function useOpen(agent: Agent) {
  const { t } = useTranslation("components");
  const locked = useFullAccess().fullAccess !== true;
  const open = (field: AgentField) =>
    locked ? lockedAlert(t("fullAccess.title")) : router.push({ pathname: "/agent-field", params: { id: agent.id, field } });
  return { locked, open, lockedAlert: () => lockedAlert(t("fullAccess.title")) };
}

/** The desktop form's team section: its workspace and its lead (the built-in agent leads everyone without one). */
export function AgentTeam({ agent }: { agent: Agent }) {
  const { t } = useTranslation("manage");
  const { data: agents = [], byId } = useAgents();
  const { workspaces } = useWorkspace();
  const { open } = useOpen(agent);
  if (agent.isDefault) return null;
  const builtin = agents.find((a) => a.isDefault);
  const lead = agent.reportsTo ? byId.get(agent.reportsTo) : builtin;
  const workspace = workspaces.find((w) => w.id === agent.workspaceId);
  return (
    <Group title={t("agent.team")}>
      <LinkRow
        icon="layers"
        title={t("agent.workspace")}
        value={agent.workspaceId ? (workspace ? `${workspace.icon ? `${workspace.icon} ` : ""}${workspace.name}` : "…") : t("agent.global")}
        onPress={() => open("workspace")}
      />
      <LinkRow
        icon="orgChart"
        title={t("agent.reportsTo")}
        value={lead?.name ?? "Godmode"}
        onPress={() => open("lead")}
      />
    </Group>
  );
}

/**
 * The desktop form's advanced sections: working folder, browser, computer, VM, SSH servers, Android phones and tools.
 * Features switched off on the computer leave their rows out, like on the desktop.
 */
export function AgentAccess({ agent }: { agent: Agent }) {
  const { t } = useTranslation("manage");
  const settings = useSettings().data;
  const { workspaces } = useWorkspace();
  const { locked, open, lockedAlert: refuse } = useOpen(agent);
  const vmOn = !!settings?.vm.enabled;
  const sshOn = !!settings?.ssh.enabled;
  const androidOn = !!settings?.android.enabled;
  const toolsOn = !!settings?.integrations.enabled;
  const profiles = useQuery({ queryKey: qk.browserProfiles, queryFn: api.browser.profiles });
  // An older or VM-less computer answers with an error: then there is no VM row, like the desktop without Tart.
  const vms = useQuery({ queryKey: qk.vms, queryFn: api.vms.list, retry: false, enabled: vmOn });
  const ssh = useQuery({ queryKey: ik.sshServers, queryFn: integrationsApi.sshServers, enabled: sshOn });
  const mcp = useQuery({ queryKey: ik.mcpServers, queryFn: integrationsApi.mcpServers, enabled: toolsOn });
  const tools = useQuery({ queryKey: ik.apiTools, queryFn: integrationsApi.apiTools, enabled: toolsOn });

  const save = (patch: Parameters<typeof patchAgentSetup>[1]) => (locked ? refuse() : void patchAgentSetup(agent.id, patch));
  const count = (ids: string[], known: { id: string }[] | undefined) => {
    const n = known ? ids.filter((id) => known.some((k) => k.id === id)).length : ids.length;
    return n ? String(n) : t("agent.none");
  };

  const profile = agent.browser.profileId ? profiles.data?.find((p) => p.id === agent.browser.profileId)?.name : null;
  const target = agent.computer.target;
  const screen = target?.kind === "display" ? target.name || target.displayId : t("agent.entireDesktop");
  const workspaceVm = vms.data?.find((v) => v.id === workspaces.find((w) => w.id === agent.workspaceId)?.vmId);
  const vm = agent.vmId ? (vms.data?.find((v) => v.id === agent.vmId)?.name ?? agent.vmId) : workspaceVm ? t("agent.vmWorkspaceNamed", { vm: workspaceVm.name }) : t("agent.vmNone");
  const window: Window = agent.browser.headless === null ? "default" : agent.browser.headless ? "headless" : "visible";
  const ownTools = (tools.data ?? []).filter(
    (x) => x.enabled && (x.agentId ? x.agentId === agent.id : agent.inheritMcp && (x.workspaceId === null || x.workspaceId === agent.workspaceId)),
  );

  return (
    <>
      <Group>
        <LinkRow
          icon="folder"
          title={t("agent.folder")}
          value={agent.workingDirectory ? folderName(agent.workingDirectory) : t("agent.ownFolder")}
          onPress={() => (locked ? refuse() : router.push({ pathname: "/folder-pick", params: { id: agent.id } }))}
        />
        {vmOn && vms.data ? <LinkRow icon="vm" title={t("agent.vm")} value={vm} onPress={() => open("vm")} /> : null}
        {sshOn ? <LinkRow icon="server" title={t("agent.ssh")} value={count(agent.sshServerIds, ssh.data)} onPress={() => open("ssh")} /> : null}
        {androidOn ? <LinkRow icon="phone" title={t("agent.android")} value={count(agent.androidDeviceIds, undefined)} onPress={() => open("android")} /> : null}
      </Group>

      <Group title={t("agent.browser")}>
        <SwitchRow icon="globe" title={t("agent.browserAccess")} value={agent.browser.enabled} disabled={locked} onChange={(enabled) => save({ browser: { ...agent.browser, enabled } })} />
        {agent.browser.enabled ? (
          <LinkRow icon="personCircle" title={t("agent.profile")} value={profile ?? t("agent.defaultProfile")} onPress={() => open("browserProfile")} />
        ) : null}
        {agent.browser.enabled ? (
          <SegmentRow<Window>
            title={t("agent.window")}
            value={window}
            options={[
              { value: "default", label: t("agent.default") },
              { value: "visible", label: t("agent.visible") },
              { value: "headless", label: t("agent.headless") },
            ]}
            onChange={(next) => save({ browser: { ...agent.browser, headless: next === "default" ? null : next === "headless" } })}
          />
        ) : null}
      </Group>

      <Group title={t("agent.computer")}>
        <SwitchRow icon="display" title={t("agent.unattended")} value={agent.computer.enabled} disabled={locked} onChange={(enabled) => save({ computer: { ...agent.computer, enabled } })} />
        {agent.computer.enabled ? <LinkRow icon="expand" title={t("agent.screen")} value={screen} onPress={() => open("display")} /> : null}
      </Group>

      {toolsOn ? (
        <Group title={t("agent.tools")}>
          <SwitchRow icon="layers" title={t("agent.inherit")} value={agent.inheritMcp} disabled={locked} onChange={(inheritMcp) => save({ inheritMcp })} />
          <LinkRow icon="plug" title={t("agent.mcp")} value={count(agent.mcpServerIds, mcp.data)} onPress={() => open("mcp")} />
        </Group>
      ) : null}

      {toolsOn ? (
        <Group title={t("agent.apiTools")} footer={tools.data && !ownTools.length ? (agent.inheritMcp ? t("agent.toolsEmptyInherit") : t("agent.toolsEmptyOwn")) : undefined}>
          {ownTools.map((x) => (
            <LinkRow key={x.id} icon="wrench" title={x.name} detail={x.description || undefined} value={x.agentId ? t("agent.toolOwn") : undefined} onPress={() => router.push({ pathname: "/settings/api-tool", params: { id: x.id } })} />
          ))}
          <LinkRow
            icon="plus"
            title={t("agent.addOwnTool")}
            tone="brand"
            chevron={false}
            onPress={() => (locked ? refuse() : router.push({ pathname: "/settings/api-tool", params: { agentId: agent.id, ...(agent.workspaceId ? { workspaceId: agent.workspaceId } : {}) } }))}
          />
          <LinkRow icon="slider" title={t("agent.manageTools")} onPress={() => router.push("/settings/integrations")} />
        </Group>
      ) : null}
    </>
  );
}
