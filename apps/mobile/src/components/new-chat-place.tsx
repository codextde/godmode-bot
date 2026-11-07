import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { computerTargetLabel, type Agent, type ConversationWithMessages } from "@godmode/shared";
import { Group, LinkRow, PickerRow, SwitchRow } from "./form";
import { api } from "@/lib/api";
import { useChatIsHere, usePlaces } from "@/lib/chat-extras";
import { useNewChatOptions } from "@/lib/chat-options";
import { currentLanguage } from "@/lib/i18n";
import { useSshServers } from "@/lib/integrations";
import { qk } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";

const OWN = "__own";
const DEFAULT_PLACE = "__default";
const PRIMARY = "__primary";

const lastPart = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

interface Work {
  workingDirectory: string | null;
  vmId: string | null;
  sshServerIds: string[];
  androidDeviceIds: string[];
}

/**
 * The rows of where a chat works. `onComputer` false: it works on another computer of the group, where this computer's
 * folders, VMs and phones mean nothing.
 */
function WorkRows({
  agent,
  work,
  set,
  onFolder,
  onComputer = true,
  first,
  last,
}: {
  agent: Agent;
  work: Work;
  set: (patch: Partial<Work>) => void;
  onFolder: () => void;
  onComputer?: boolean;
  first?: ReactNode;
  last?: ReactNode;
}) {
  const { t } = useTranslation("chat");
  const vms = useQuery({ queryKey: qk.vms, queryFn: api.vms.list });
  const servers = useSshServers();
  const phones = useQuery({ queryKey: qk.androidDevices, queryFn: api.android.devices });
  const extraServers = (servers.data ?? []).filter((s) => !agent.sshServerIds.includes(s.id));
  const extraPhones = (phones.data ?? []).filter((d) => !agent.androidDeviceIds.includes(d.id));
  const agentVm = agent.vmId ? vms.data?.find((v) => v.id === agent.vmId) : undefined;
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((x) => x !== id));

  return (
    <>
      <Group title={t("place.title")}>
        {first}
        {onComputer ? (
          <LinkRow
            icon="folder"
            title={t("place.folder")}
            value={work.workingDirectory ? lastPart(work.workingDirectory) : agent.workingDirectory ? lastPart(agent.workingDirectory) : t("place.agentDefault")}
            onPress={onFolder}
          />
        ) : null}
        {last}
        {onComputer && vms.data?.length ? (
          <PickerRow
            icon="vm"
            title={t("place.vm")}
            value={work.vmId ?? OWN}
            options={[
              { value: OWN, label: agentVm ? t("place.agentVm", { name: agentVm.name }) : t("place.noVm") },
              ...vms.data.filter((v) => v.id !== agent.vmId).map((v) => ({ value: v.id, label: v.name })),
            ]}
            onChange={(v) => set({ vmId: v === OWN ? null : v })}
          />
        ) : null}
      </Group>
      {extraServers.length ? (
        <Group title={t("place.ssh")}>
          {extraServers.map((s) => (
            <SwitchRow
              key={s.id}
              icon="server"
              title={s.name}
              detail={`${s.username}@${s.host}`}
              value={work.sshServerIds.includes(s.id)}
              onChange={(on) => set({ sshServerIds: toggle(work.sshServerIds, s.id, on) })}
            />
          ))}
        </Group>
      ) : null}
      {onComputer && extraPhones.length ? (
        <Group title={t("place.android")}>
          {extraPhones.map((d) => (
            <SwitchRow
              key={d.id}
              icon="phone"
              title={d.name}
              detail={[d.manufacturer, d.model].filter(Boolean).join(" ")}
              value={work.androidDeviceIds.includes(d.id)}
              onChange={(on) => set({ androidDeviceIds: toggle(work.androidDeviceIds, d.id, on) })}
            />
          ))}
        </Group>
      ) : null}
    </>
  );
}

/**
 * Where a new chat works, like the desktop's chips under the composer: another computer of the group, a folder on the
 * computer, a VM, and SSH servers and Android phones on top of the agent's. Only for a phone with full access.
 */
export function NewChatPlace({ agent }: { agent: Agent }) {
  const { t } = useTranslation("chat");
  const options = useNewChatOptions((s) => s.options);
  const set = useNewChatOptions.getState().set;
  const places = usePlaces();
  const elsewhere = options.runnerId !== undefined;
  const others = places.filter((p) => !p.self && p.state === "online");
  if (options.private) return null;

  return (
    <WorkRows
      agent={agent}
      work={options}
      set={set}
      onComputer={!elsewhere}
      onFolder={() => router.push({ pathname: "/chat-folder", params: options.workingDirectory ? { path: options.workingDirectory } : {} })}
      last={
        elsewhere ? null : (
          <LinkRow
            icon="display"
            title={t("place.screen")}
            value={options.computerTarget ? computerTargetLabel(options.computerTarget, currentLanguage()) : t("place.notShared")}
            onPress={() => router.push({ pathname: "/chat-screen", params: { agentId: agent.id } })}
          />
        )
      }
      first={
        others.length ? (
          <PickerRow
            icon="laptop"
            title={t("place.computer")}
            value={options.runnerId === undefined ? DEFAULT_PLACE : (options.runnerId ?? PRIMARY)}
            options={[
              { value: DEFAULT_PLACE, label: t("place.thisComputer") },
              ...others.map((p) => ({ value: p.runnerId ?? PRIMARY, label: p.name })),
            ]}
            onChange={(v) => set({ runnerId: v === DEFAULT_PLACE ? undefined : v === PRIMARY ? null : v })}
          />
        ) : null
      }
    />
  );
}

/** The same for a chat that exists, plus sharing a screen with it. Each change applies from its next step. */
export function ChatPlace({ agent, chat, set }: { agent: Agent; chat: ConversationWithMessages; set: (patch: Partial<Work>) => void }) {
  const { t } = useTranslation("chat");
  const onComputer = useChatIsHere(chat.runnerId);
  const { workspaces } = useWorkspace();
  const vms = useQuery({ queryKey: qk.vms, queryFn: api.vms.list });
  const inherited = agent.vmId ?? workspaces.find((w) => w.id === agent.workspaceId)?.vmId ?? null;
  const vmId = chat.vmId ?? inherited;
  // A chat in a VM does everything there: this computer's screen isn't part of it.
  const inVm = !!vmId && !!vms.data?.some((v) => v.id === vmId);
  const target = chat.computerTarget ?? null;

  return (
    <WorkRows
      agent={agent}
      work={{ workingDirectory: chat.workingDirectory ?? null, vmId: chat.vmId ?? null, sshServerIds: chat.sshServerIds ?? [], androidDeviceIds: chat.androidDeviceIds ?? [] }}
      set={set}
      onComputer={onComputer}
      onFolder={() => router.push({ pathname: "/chat-folder", params: { conversationId: chat.id, ...(chat.workingDirectory ? { path: chat.workingDirectory } : {}) } })}
      last={
        onComputer && !inVm ? (
          <LinkRow
            icon="display"
            title={t("place.screen")}
            value={target ? computerTargetLabel(target, currentLanguage()) : t("place.notShared")}
            onPress={() => router.push({ pathname: "/chat-screen", params: { conversationId: chat.id } })}
          />
        ) : null
      }
    />
  );
}
