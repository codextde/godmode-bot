import { Link } from "react-router";
import { Trans, useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, MessageSquare, Plus, X } from "lucide-react";
import type { AndroidAssignment, AndroidDevice } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { AgentAvatar } from "@/components/common";
import { toastApiError } from "@/components/vault/vault-utils";
import { t as translate } from "@/i18n";
import { api } from "@/lib/api";
import { useAllAgents } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";

function assignmentHref(a: AndroidAssignment): string {
  return a.kind === "agent" ? `/agents/${a.id}/settings#android` : `/chat/${a.id}`;
}

interface AssignVars {
  kind: AndroidAssignment["kind"];
  id: string;
  assigned: boolean;
}

function useAssign(device: AndroidDevice) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: AssignVars) => api.android.assign(device.id, v),
    onSuccess: (updated) => {
      qc.setQueryData<AndroidDevice[]>(qk.androidDevices, (old) => old?.map((d) => (d.id === updated.id ? updated : d)));
      void qc.invalidateQueries({ queryKey: qk.agents });
    },
    onError: (e) => toastApiError(e, translate("android:usedBy.assignFailed"), qc),
  });
}

/** Agents and chats that control the phone, with a way to add agents (chats pick phones in their message box). */
export function UsedBy({ device }: { device: AndroidDevice }) {
  const { t } = useTranslation(["android", "common"]);
  const { data: agents = [] } = useAllAgents();
  const assign = useAssign(device);
  const removing = (a: AndroidAssignment) => assign.isPending && assign.variables?.id === a.id && !assign.variables.assigned;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="eyebrow mr-1 text-[10.5px]">{t("usedBy.title")}</span>
      {device.assignments.length === 0 && <span className="mr-1 text-xs text-muted-foreground">{t("usedBy.noOneYet")}</span>}
      {device.assignments.map((a) => {
        const agent = a.kind === "agent" ? agents.find((x) => x.id === a.id) : undefined;
        const kind = a.kind === "agent" ? t("common:words.agent") : t("usedBy.chat");
        const label = a.name || (a.kind === "conversation" ? t("usedBy.untitledChat") : kind);
        return (
          <span key={`${a.kind}:${a.id}`} className="inline-flex h-6 max-w-[14rem] min-w-0 items-center rounded-md border bg-card text-xs shadow-xs">
            <Link
              to={assignmentHref(a)}
              title={t("usedBy.assignmentTitle", { kind, label })}
              className="flex h-full min-w-0 items-center gap-1.5 rounded-l-md pr-1 pl-1.5 transition hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {agent ? (
                <AgentAvatar agent={agent} size="sm" className="size-4 rounded-[4px] text-[10px]" />
              ) : a.kind === "agent" ? (
                <Bot className="size-3.5 text-muted-foreground" />
              ) : (
                <MessageSquare className="size-3.5 text-muted-foreground" />
              )}
              <span className="truncate">{label}</span>
            </Link>
            <button
              type="button"
              aria-label={t("usedBy.takeAway", { device: device.name, label })}
              disabled={removing(a)}
              onClick={() => assign.mutate({ kind: a.kind, id: a.id, assigned: false })}
              className="grid h-full w-5 shrink-0 place-items-center rounded-r-md text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {removing(a) ? <Spinner className="size-3" /> : <X className="size-3" />}
            </button>
          </span>
        );
      })}
      <AssignPopover device={device} assign={assign} />
    </div>
  );
}

function AssignPopover({ device, assign }: { device: AndroidDevice; assign: ReturnType<typeof useAssign> }) {
  const { t } = useTranslation(["android", "common"]);
  const { data: agents = [] } = useAllAgents();
  const sorted = [...agents].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
  const assigned = new Set(device.assignments.filter((a) => a.kind === "agent").map((a) => a.id));
  const pendingId = assign.isPending ? assign.variables?.id : null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" className="h-6 text-muted-foreground hover:text-foreground" aria-label={t("usedBy.assignAria", { name: device.name })}>
          <Plus /> {t("usedBy.assign")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 overflow-hidden p-0">
        <Command>
          {sorted.length > 6 && <CommandInput placeholder={t("usedBy.searchAgents")} />}
          <CommandList className="max-h-72">
            <CommandEmpty>{t("usedBy.noAgents")}</CommandEmpty>
            <CommandGroup heading={t("common:words.agents")}>
              {sorted.map((a) => {
                const on = assigned.has(a.id);
                return (
                  <CommandItem
                    key={a.id}
                    value={`agent ${a.name} ${a.id}`}
                    disabled={pendingId === a.id}
                    onSelect={() => assign.mutate({ kind: "agent", id: a.id, assigned: !on })}
                    className="gap-2.5 py-1.5"
                  >
                    <AgentAvatar agent={a} size="sm" />
                    <span className="min-w-0 flex-1 truncate">{a.name}</span>
                    {pendingId === a.id ? <Spinner className="size-4" /> : on && <Check className="size-4" aria-label={t("usedBy.assigned")} />}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
        <p className="border-t bg-paper-2 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          <Trans t={t} i18nKey="usedBy.singleChatHint" components={{ b: <span className="font-medium text-foreground" /> }} />
        </p>
      </PopoverContent>
    </Popover>
  );
}
