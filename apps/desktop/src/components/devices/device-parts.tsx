import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRightFromLine, ChevronDown, Laptop, Monitor } from "lucide-react";
import { toast } from "sonner";
import type { DeviceGroup, GroupDevice } from "@godmode/shared";
import { RUNNER_STATE_LABEL, RunnerStateDot, THIS_COMPUTER, THIS_COMPUTER_INLINE } from "@/components/runners/runner-parts";
import { timeAgo } from "@/components/ssh/ssh-parts";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { useDeviceGroup } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";

/** Laptops by their name, everything else (a Mac mini, an iMac, a Studio) as a desktop. */
export function DeviceIcon({ device, className }: { device: Pick<GroupDevice, "name" | "role">; className?: string }) {
  const laptop = /book|laptop|notebook/i.test(device.name) || (device.role === "secondary" && !/mini|studio|imac|mac pro|desktop|tower/i.test(device.name));
  const Icon = laptop ? Laptop : Monitor;
  return <Icon className={className} aria-hidden />;
}

export function deviceName(device: GroupDevice): string {
  return device.self ? THIS_COMPUTER : device.name;
}

/** "2 working · 14 chats" */
export function deviceWorkLine(device: Pick<GroupDevice, "activeRuns" | "conversations">): string {
  const chats = device.conversations === 1 ? "1 chat" : `${device.conversations} chats`;
  return device.activeRuns > 0 ? `${device.activeRuns} working · ${chats}` : chats;
}

/** "Online · 12 ms", "Offline · seen 3 h ago" */
export function deviceStateLine(device: GroupDevice): string {
  if (device.self) return "Online";
  if (device.state === "online") return device.latencyMs !== null ? `Online · ${device.latencyMs} ms` : "Online";
  if (device.state === "offline" && device.lastSeenAt) return `Offline · seen ${timeAgo(device.lastSeenAt)}`;
  return RUNNER_STATE_LABEL[device.state];
}

export function DeviceDot({ device, className }: { device: GroupDevice; className?: string }) {
  return <RunnerStateDot state={device.self ? "online" : device.state} className={className} />;
}

/** Where this computer's running work can go: the primary from a secondary, the online secondaries from the primary. */
export function handoffTargets(group: DeviceGroup | undefined): GroupDevice[] {
  if (!group?.role) return [];
  if (group.role === "secondary") return group.primaryOnline ? group.devices.filter((d) => d.role === "primary") : [];
  return group.devices.filter((d) => !d.self && d.role === "secondary" && d.state === "online");
}

/** Hand this computer's working chats to another computer of the group, with a toast that says how it went. */
export function useHandoff() {
  const qc = useQueryClient();
  const { data: group } = useDeviceGroup();
  const self = group?.devices.find((d) => d.self) ?? null;
  const targets = handoffTargets(group);
  const run = useMutation({
    mutationFn: (to: GroupDevice) =>
      api.devices.handoff(group?.role === "secondary" ? { from: group.selfId, to: null } : { from: null, to: to.id }),
    onSuccess: (result, to) => {
      const moved = result.moved.length;
      const failed = result.failed.length;
      const chats = (n: number) => (n === 1 ? "1 chat" : `${n} chats`);
      const details = result.failed.map((f) => `${f.title}: ${f.error}`).join("\n");
      if (!moved && !failed) toast("Nothing to hand off", { description: `No chat is working on ${THIS_COMPUTER_INLINE} right now.` });
      else if (!failed) toast.success(`Moved ${chats(moved)} to ${to.name}`, { description: "They continue there with everything they did so far." });
      else if (!moved) toast.error(`Couldn't move ${failed === 1 ? "the chat" : "the chats"} to ${to.name}`, { description: details });
      else toast.warning(`Moved ${moved} of ${moved + failed} chats to ${to.name}`, { description: details });
      void qc.invalidateQueries({ queryKey: qk.devices });
      void qc.invalidateQueries({ queryKey: qk.conversationsAll });
    },
    onError: (e, to) => toastApiError(e, `Couldn't hand off to ${to.name}`, qc),
  });
  return { group, self, targets, working: self?.activeRuns ?? 0, handoff: run.mutate, pending: run.isPending };
}

/** "Hand off to Mac mini", or a menu of computers when more than one could take it. */
export function HandoffButton({
  size = "default",
  variant = "default",
  className,
  label = "Hand off to",
}: {
  size?: "default" | "sm";
  variant?: "default" | "outline";
  className?: string;
  label?: string;
}) {
  const { group, targets, handoff, pending } = useHandoff();
  const icon = pending ? <Spinner /> : <ArrowRightFromLine />;
  if (targets.length <= 1) {
    const to = targets[0];
    return (
      <Button size={size} variant={variant} className={className} disabled={!to || pending} onClick={() => to && handoff(to)}>
        {icon}
        {pending ? "Handing off…" : to ? `${label} ${to.name}` : group?.role === "secondary" ? `${group.primaryName ?? "The primary"} is offline` : "No other computer online"}
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size={size} variant={variant} className={className} disabled={pending}>
          {icon}
          {pending ? "Handing off…" : `${label}…`}
          {!pending && <ChevronDown className="opacity-60" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Continue the running work on</DropdownMenuLabel>
        {targets.map((d) => (
          <DropdownMenuItem key={d.id ?? "primary"} onSelect={() => handoff(d)}>
            <DeviceIcon device={d} />
            <span className="min-w-0 flex-1 truncate">{d.name}</span>
            <span className="text-xs text-muted-foreground tabular-nums">{d.activeRuns > 0 ? `${d.activeRuns} working` : d.latencyMs !== null ? `${d.latencyMs} ms` : ""}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
