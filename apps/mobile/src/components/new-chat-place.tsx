import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import type { Agent } from "@godmode/shared";
import { Group, LinkRow, PickerRow, SwitchRow } from "./form";
import { api } from "@/lib/api";
import { usePlaces } from "@/lib/chat-extras";
import { useNewChatOptions } from "@/lib/chat-options";
import { useSshServers } from "@/lib/integrations";
import { qk } from "@/lib/query";

const OWN = "__own";
const DEFAULT_PLACE = "__default";
const PRIMARY = "__primary";

const lastPart = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

/**
 * Where a new chat works, like the desktop's chips under the composer: another computer of the group, a folder on the
 * computer, a VM, and SSH servers and Android phones on top of the agent's. Only for a phone with full access.
 */
export function NewChatPlace({ agent }: { agent: Agent }) {
  const { t } = useTranslation("chat");
  const options = useNewChatOptions((s) => s.options);
  const set = useNewChatOptions.getState().set;
  const places = usePlaces();
  const vms = useQuery({ queryKey: qk.vms, queryFn: api.vms.list });
  const servers = useSshServers();
  const phones = useQuery({ queryKey: qk.androidDevices, queryFn: api.android.devices });
  const elsewhere = options.runnerId !== undefined;
  const extraServers = (servers.data ?? []).filter((s) => !agent.sshServerIds.includes(s.id));
  const extraPhones = (phones.data ?? []).filter((d) => !agent.androidDeviceIds.includes(d.id));
  const agentVm = agent.vmId ? vms.data?.find((v) => v.id === agent.vmId) : undefined;
  const others = places.filter((p) => !p.self && p.state === "online");
  if (options.private) return null;

  const toggle = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((x) => x !== id));

  return (
    <>
      <Group title={t("place.title")}>
        {others.length ? (
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
        ) : null}
        {!elsewhere ? (
          <LinkRow
            icon="folder"
            title={t("place.folder")}
            value={options.workingDirectory ? lastPart(options.workingDirectory) : agent.workingDirectory ? lastPart(agent.workingDirectory) : t("place.agentDefault")}
            onPress={() => router.push({ pathname: "/chat-folder", params: options.workingDirectory ? { path: options.workingDirectory } : {} })}
          />
        ) : null}
        {!elsewhere && vms.data?.length ? (
          <PickerRow
            icon="vm"
            title={t("place.vm")}
            value={options.vmId ?? OWN}
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
              value={options.sshServerIds.includes(s.id)}
              onChange={(on) => set({ sshServerIds: toggle(options.sshServerIds, s.id, on) })}
            />
          ))}
        </Group>
      ) : null}
      {!elsewhere && extraPhones.length ? (
        <Group title={t("place.android")}>
          {extraPhones.map((d) => (
            <SwitchRow
              key={d.id}
              icon="phone"
              title={d.name}
              detail={[d.manufacturer, d.model].filter(Boolean).join(" ")}
              value={options.androidDeviceIds.includes(d.id)}
              onChange={(on) => set({ androidDeviceIds: toggle(options.androidDeviceIds, d.id, on) })}
            />
          ))}
        </Group>
      ) : null}
    </>
  );
}
