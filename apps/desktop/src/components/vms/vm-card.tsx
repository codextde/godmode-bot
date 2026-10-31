import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { Trans, useTranslation } from "react-i18next";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import {
  Bot,
  Box,
  Check,
  ChevronDown,
  CopyPlus,
  Cpu,
  Ellipsis,
  FolderOpen,
  HardDrive,
  Layers,
  MemoryStick,
  MessageSquare,
  Monitor,
  Moon,
  Pencil,
  Play,
  Plus,
  Power,
  RotateCcw,
  RotateCw,
  Square,
  SquareTerminal,
  Terminal,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import type { Vm, VmAssignment, VmExecResult, VmImagePreset } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentAvatar } from "@/components/common";
import { LiveDot } from "@/components/aicss/Motion";
import { CopyButton } from "@/components/chat/copy-button";
import { WorkspaceTile } from "@/components/workspaces/workspace-tile";
import { api, errorMessage, type VmOpenTarget } from "@/lib/api";
import { useAllAgents, useWorkspaces } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { VmProgressBlock, VmStateBadge, formatDisplay, formatGb, formatMemory, guestFolderLabel, imageName, presetOf, vmBusy } from "./vm-parts";
import type { VmActions } from "./use-vm-actions";

export function VmCard({
  vm,
  presets,
  vms,
  actions,
  onEdit,
  onReset,
  onDelete,
}: {
  vm: Vm;
  presets: VmImagePreset[] | undefined;
  /** Every VM (names for "uses another VM" hints). */
  vms: Vm[];
  actions: VmActions;
  onEdit: () => void;
  onReset: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("vms");
  const [commandOpen, setCommandOpen] = useState(false);
  const busy = vmBusy(vm.state);
  const working = vm.state === "creating" || vm.state === "starting";
  const running = vm.state === "running";
  const preset = presetOf(vm.image, presets);
  const progress =
    vm.progress ??
    (busy ? { phase: "boot" as const, label: vm.state === "stopping" ? t("card.shuttingDown") : vm.state === "starting" ? t("card.startingMacos") : t("card.preparing"), percent: null } : null);
  const resetting = actions.reset.isPending && actions.reset.variables?.vm.id === vm.id;

  return (
    <article
      aria-label={vm.name}
      className={cn("flex min-w-0 flex-col rounded-xl border bg-card shadow-card transition hover:border-foreground/15", working && "glow-border")}
    >
      <div className="flex items-start gap-3.5 p-4">
        <div className="relative shrink-0">
          <div
            className={cn(
              "grid size-10 place-items-center rounded-lg border [&_svg]:size-5",
              running ? "bg-card text-foreground shadow-card" : vm.state === "suspended" ? "bg-dream-soft text-dream" : "bg-paper-2 text-muted-foreground",
            )}
          >
            {vm.state === "suspended" ? <Moon /> : <Box />}
          </div>
          <span className="absolute -right-1 -bottom-1 grid place-items-center rounded-full bg-card p-[2px]">
            <LiveDot live={running} className={cn(!running && "bg-muted-foreground/40")} />
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="min-w-0 truncate text-[15px] leading-snug font-medium tracking-[-0.01em]">{vm.name}</h3>
            <VmStateBadge state={vm.state} />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground tabular-nums [&_svg]:size-3 [&_svg]:shrink-0">
            <span className="text-foreground/80">{imageName(vm.image, presets)}</span>
            <span className="inline-flex items-center gap-1" title={t("card.cpuCores")}>
              <Cpu aria-hidden /> {t("cores", { count: vm.cpu })}
            </span>
            <span className="inline-flex items-center gap-1" title={t("card.memory")}>
              <MemoryStick aria-hidden /> {formatMemory(vm.memoryMb)}
            </span>
            <span className="inline-flex items-center gap-1" title={vm.diskUsageBytes !== null ? t("card.diskUsedTitle", { size: formatGb(vm.diskUsageBytes) }) : t("card.diskSize")}>
              <HardDrive aria-hidden /> {vm.diskGb} GB
              {vm.diskUsageBytes !== null && <span className="text-muted-foreground/80">{t("card.diskUsed", { size: formatGb(vm.diskUsageBytes) })}</span>}
            </span>
            <span className="inline-flex items-center gap-1" title={t("card.display")}>
              <Monitor aria-hidden /> {formatDisplay(vm.display)}
            </span>
          </p>
          {running && vm.ip && (
            <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              IP <span className="font-mono text-foreground/80">{vm.ip}</span>
              <CopyButton text={vm.ip} label={t("card.copyIp")} className="size-5" />
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <PrimaryAction vm={vm} actions={actions} />
          <VmMenu vm={vm} actions={actions} onEdit={onEdit} onReset={onReset} onDelete={onDelete} />
        </div>
      </div>

      {progress && (
        <div className="px-4 pb-4">
          <VmProgressBlock vm={vm} progress={progress} preset={preset} />
        </div>
      )}

      {running && (
        <div className="px-4 pb-4">
          <VmScreenPreview vm={vm} actions={actions} />
        </div>
      )}

      {vm.error && !busy && (
        <div className="mx-4 mb-4 flex flex-wrap items-start gap-x-2.5 gap-y-2 rounded-lg border border-destructive/25 bg-destructive/[0.05] px-3 py-2.5 text-xs" role="alert">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-destructive" aria-hidden />
          <p className="min-w-0 flex-1 basis-48 leading-relaxed text-destructive">{vm.error}</p>
          {vm.state === "error" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="xs" variant="outline" disabled={resetting} onClick={() => actions.reset.mutate({ vm })}>
                  {resetting ? <Spinner className="size-3" /> : <RotateCcw />} {t("card.reset")}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("card.resetTooltip")}</TooltipContent>
            </Tooltip>
          )}
        </div>
      )}

      <div className="mt-auto border-t px-4 py-3">
        <UsedBy vm={vm} vms={vms} actions={actions} />
      </div>

      <div className="flex flex-wrap items-center gap-0.5 rounded-b-xl border-t bg-paper-2/70 px-2 py-1.5">
        <OpenButton vm={vm} what="screen" actions={actions} icon={<Monitor />} label={t("card.screen")} />
        <OpenButton vm={vm} what="terminal" actions={actions} icon={<SquareTerminal />} label={t("card.terminal")} />
        <OpenButton vm={vm} what="folder" actions={actions} icon={<FolderOpen />} label={t("card.sharedFolder")} />
        {running && (
          <Button
            variant="ghost"
            size="sm"
            className={cn("ml-auto h-7 gap-1.5 px-2 text-[12.5px] font-normal text-muted-foreground hover:text-foreground", commandOpen && "bg-accent text-foreground")}
            aria-expanded={commandOpen}
            aria-controls={`vm-command-${vm.id}`}
            onClick={() => setCommandOpen((o) => !o)}
          >
            <Terminal className="size-3.5" /> {t("card.runCommand")}
            <ChevronDown className={cn("size-3.5 opacity-60 transition-transform", commandOpen && "rotate-180")} />
          </Button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {running && commandOpen && (
          <motion.div
            id={`vm-command-${vm.id}`}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
            className="overflow-hidden"
          >
            <CommandPanel vm={vm} />
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}

/* ------------------------------------------------------------------ */

/** What's on the running VM's screen right now (refreshed every few seconds); click to open it in Screen Sharing. */
function VmScreenPreview({ vm, actions }: { vm: Vm; actions: VmActions }) {
  const { t } = useTranslation("vms");
  const [w, h] = vm.display.split("x").map(Number);
  const aspect = w && h ? w / h : 16 / 10;
  const { data, isError } = useQuery({
    queryKey: qk.vmScreen(vm.id, 640),
    queryFn: () => api.vms.screenshot(vm.id, 640),
    refetchInterval: 4_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const opening = actions.open.isPending && actions.open.variables?.vm.id === vm.id && actions.open.variables.what === "screen";
  return (
    <button
      type="button"
      onClick={() => actions.open.mutate({ vm, what: "screen" })}
      aria-label={t("card.openScreenAria", { name: vm.name })}
      className="group relative block w-full overflow-hidden rounded-lg border bg-paper-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      style={{ aspectRatio: String(aspect) }}
    >
      {data ? (
        <img src={`data:${data.mime};base64,${data.data}`} alt="" draggable={false} className="absolute inset-0 size-full object-contain select-none" />
      ) : (
        <span className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
          {isError ? t("panel.screenUnavailable") : <Spinner className="size-4" />}
        </span>
      )}
      <span className="absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-md bg-background/85 px-2 py-1 text-[11.5px] text-foreground opacity-0 shadow-card backdrop-blur transition group-hover:opacity-100 group-focus-visible:opacity-100">
        {opening ? <Spinner className="size-3" /> : <Monitor className="size-3" />} {t("card.openInScreenSharing")}
      </span>
    </button>
  );
}

function PrimaryAction({ vm, actions }: { vm: Vm; actions: VmActions }) {
  const { t } = useTranslation(["vms", "common"]);
  const starting = actions.start.isPending && actions.start.variables?.id === vm.id;
  const stopping = actions.stop.isPending && actions.stop.variables?.id === vm.id;
  switch (vm.state) {
    case "stopped":
    case "suspended":
      return (
        <Button size="sm" onClick={() => actions.start.mutate(vm)} disabled={starting}>
          {starting ? <Spinner /> : <Play />} {vm.state === "suspended" ? t("card.resume") : t("card.start")}
        </Button>
      );
    case "running":
      return (
        <Button size="sm" variant="outline" onClick={() => actions.stop.mutate(vm)} disabled={stopping}>
          {stopping ? <Spinner /> : <Square />} {t("common:actions.stop")}
        </Button>
      );
    case "starting":
      return (
        <Button size="sm" variant="outline" disabled>
          <Spinner /> {t("card.starting")}
        </Button>
      );
    case "stopping":
      return (
        <Button size="sm" variant="outline" disabled>
          <Spinner /> {t("card.stopping")}
        </Button>
      );
    default:
      return null;
  }
}

function VmMenu({ vm, actions, onEdit, onReset, onDelete }: { vm: Vm; actions: VmActions; onEdit: () => void; onReset: () => void; onDelete: () => void }) {
  const { t } = useTranslation(["vms", "common"]);
  const s = vm.state;
  // Starting, shutting down or being created: other changes wait until that's done.
  const busy = s === "creating" || s === "starting" || s === "stopping";
  const pending =
    (actions.suspend.isPending && actions.suspend.variables?.id === vm.id) ||
    (actions.restart.isPending && actions.restart.variables?.id === vm.id) ||
    (actions.duplicate.isPending && actions.duplicate.variables?.vm.id === vm.id) ||
    (actions.remove.isPending && actions.remove.variables?.vm.id === vm.id);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={t("card.moreActions", { name: vm.name })}>
          {pending ? <Spinner /> : <Ellipsis />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem disabled={s !== "stopped" && s !== "suspended"} onClick={() => actions.start.mutate(vm)}>
          <Play /> {s === "suspended" ? t("card.resume") : t("card.start")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={s !== "running"} onClick={() => actions.suspend.mutate(vm)}>
          <Moon /> {t("card.suspend")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={s !== "running"} onClick={() => actions.restart.mutate(vm)}>
          <RotateCw /> {t("card.restart")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={s !== "running" && s !== "starting" && s !== "suspended"} onClick={() => actions.stop.mutate(vm)}>
          <Power /> {s === "suspended" ? t("card.shutDown") : t("common:actions.stop")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={busy} onClick={onEdit}>
          <Pencil /> {t("card.edit")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={s !== "stopped"} onClick={() => actions.duplicate.mutate({ vm })}>
          <CopyPlus /> {t("card.duplicate")}
          {s !== "stopped" && s !== "creating" && s !== "error" && <span className="ml-auto text-[11px] text-muted-foreground">{t("card.stopFirst")}</span>}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={busy} onClick={onReset}>
          <RotateCcw /> {t("card.resetMenu")}
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          <Trash2 /> {t("card.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function OpenButton({ vm, what, actions, icon, label }: { vm: Vm; what: VmOpenTarget; actions: VmActions; icon: ReactNode; label: string }) {
  const { t } = useTranslation("vms");
  const pending = actions.open.isPending && actions.open.variables?.vm.id === vm.id && actions.open.variables.what === what;
  const needsVm = what !== "folder";
  const disabled = needsVm && (vm.state === "creating" || vm.state === "stopping" || vm.state === "error");
  const hint =
    what === "folder"
      ? t("card.hint.folder", { path: guestFolderLabel(vm) })
      : disabled
        ? vm.state === "error"
          ? t("card.hint.resetFirst")
          : t("card.hint.availableWhenReady")
        : vm.state === "running"
          ? what === "screen"
            ? t("card.hint.showScreen")
            : t("card.hint.openTerminal", { user: vm.guestUser })
          : what === "screen"
            ? t("card.hint.startsThenScreen")
            : t("card.hint.startsThenTerminal");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Wrapper keeps the tooltip working on a disabled button. */}
        <span tabIndex={disabled ? 0 : undefined} className="inline-flex rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || pending}
            onClick={() => actions.open.mutate({ vm, what })}
            className="h-7 gap-1.5 px-2 text-[12.5px] font-normal text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
          >
            {pending ? <Spinner className="size-3.5" /> : icon}
            {label}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

/* ------------------------------------------------------------------ */
/* Used by                                                              */
/* ------------------------------------------------------------------ */

function assignmentHref(a: VmAssignment): string {
  if (a.kind === "agent") return `/agents/${a.id}/settings#vm`;
  if (a.kind === "workspace") return `/workspaces?edit=${a.id}`;
  return `/chat/${a.id}`;
}

function UsedBy({ vm, vms, actions }: { vm: Vm; vms: Vm[]; actions: VmActions }) {
  const { t } = useTranslation(["vms", "common"]);
  const { data: agents = [] } = useAllAgents();
  const { data: workspaces = [] } = useWorkspaces();
  const removing = (a: VmAssignment) =>
    actions.assign.isPending && actions.assign.variables?.vm.id === vm.id && actions.assign.variables.id === a.id && !actions.assign.variables.assigned;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="eyebrow mr-1 text-[10.5px]">{t("card.usedBy")}</span>
      {vm.assignments.length === 0 && <span className="mr-1 text-xs text-muted-foreground">{t("card.noOneYet")}</span>}
      {vm.assignments.map((a) => {
        const agent = a.kind === "agent" ? agents.find((x) => x.id === a.id) : undefined;
        const ws = a.kind === "workspace" ? workspaces.find((x) => x.id === a.id) : undefined;
        const kind = a.kind === "conversation" ? t("card.chat") : a.kind === "agent" ? t("common:words.agent") : t("card.workspace");
        return (
          <span key={`${a.kind}:${a.id}`} className="inline-flex h-6 max-w-[14rem] min-w-0 items-center rounded-md border bg-card text-xs shadow-xs">
            <Link
              to={assignmentHref(a)}
              title={t("card.assignmentTitle", { kind, label: a.name })}
              className="flex h-full min-w-0 items-center gap-1.5 rounded-l-md pr-1 pl-1.5 transition hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {agent ? (
                <AgentAvatar agent={agent} size="sm" className="size-4 rounded-[4px] text-[10px]" />
              ) : ws ? (
                <WorkspaceTile icon={ws.icon} color={ws.color} size="sm" className="size-4 rounded-[4px] text-[10px]" />
              ) : a.kind === "agent" ? (
                <Bot className="size-3.5 text-muted-foreground" />
              ) : a.kind === "workspace" ? (
                <Layers className="size-3.5 text-muted-foreground" />
              ) : (
                <MessageSquare className="size-3.5 text-muted-foreground" />
              )}
              <span className="truncate">{a.name || (a.kind === "conversation" ? t("card.untitledChat") : kind)}</span>
            </Link>
            <button
              type="button"
              aria-label={t("card.stopUsing", { vm: vm.name, label: a.name || kind })}
              disabled={removing(a)}
              onClick={() => actions.assign.mutate({ vm, kind: a.kind, id: a.id, name: a.name || kind, assigned: false })}
              className="grid h-full w-5 shrink-0 place-items-center rounded-r-md text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {removing(a) ? <Spinner className="size-3" /> : <X className="size-3" />}
            </button>
          </span>
        );
      })}
      <AssignPopover vm={vm} vms={vms} actions={actions} />
    </div>
  );
}

function AssignPopover({ vm, vms, actions }: { vm: Vm; vms: Vm[]; actions: VmActions }) {
  const { t } = useTranslation(["vms", "common"]);
  const [open, setOpen] = useState(false);
  const { data: agents = [] } = useAllAgents();
  const { data: workspaces = [] } = useWorkspaces();
  const nameOf = (id: string | null) => (id ? (vms.find((v) => v.id === id)?.name ?? null) : null);
  const sortedAgents = [...agents].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));

  const toggle = (kind: "agent" | "workspace", id: string, name: string, current: string | null) => {
    actions.assign.mutate({ vm, kind, id, name, assigned: current !== vm.id });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" className="h-6 text-muted-foreground hover:text-foreground" aria-label={t("card.assignAria", { name: vm.name })}>
          <Plus /> {t("card.assign")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 overflow-hidden p-0">
        <Command>
          <CommandInput placeholder={t("card.searchPlaceholder")} />
          <CommandList className="max-h-72">
            <CommandEmpty>{t("card.nothingFound")}</CommandEmpty>
            {sortedAgents.length > 0 && (
              <CommandGroup heading={t("common:words.agents")}>
                {sortedAgents.map((a) => {
                  const other = a.vmId && a.vmId !== vm.id ? nameOf(a.vmId) : null;
                  return (
                    <CommandItem key={a.id} value={`agent ${a.name} ${a.id}`} onSelect={() => toggle("agent", a.id, a.name, a.vmId)} className="gap-2.5 py-1.5">
                      <AgentAvatar agent={a} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{a.name}</span>
                        {other && <span className="block truncate text-[11px] text-muted-foreground">{t("card.usesOther", { name: other })}</span>}
                      </span>
                      {a.vmId === vm.id && <Check className="size-4" aria-label={t("card.assigned")} />}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
            {workspaces.length > 0 && (
              <CommandGroup heading={t("card.workspaces")}>
                {workspaces.map((w) => {
                  const other = w.vmId && w.vmId !== vm.id ? nameOf(w.vmId) : null;
                  return (
                    <CommandItem key={w.id} value={`workspace ${w.name} ${w.id}`} onSelect={() => toggle("workspace", w.id, w.name, w.vmId)} className="gap-2.5 py-1.5">
                      <WorkspaceTile icon={w.icon} color={w.color} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{w.name}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">{other ? t("card.usesOther", { name: other }) : t("card.everyAgent")}</span>
                      </span>
                      {w.vmId === vm.id && <Check className="size-4" aria-label={t("card.assigned")} />}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
        <p className="border-t bg-paper-2 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          <Trans t={t} i18nKey="card.singleChatHint" components={{ b: <span className="font-medium text-foreground" /> }} />
        </p>
      </PopoverContent>
    </Popover>
  );
}

/* ------------------------------------------------------------------ */
/* Run a command                                                        */
/* ------------------------------------------------------------------ */

function CommandPanel({ vm }: { vm: Vm }) {
  const { t } = useTranslation("vms");
  const [command, setCommand] = useState("");
  const exec = useMutation({
    mutationFn: (cmd: string) => api.vms.exec(vm.id, { command: cmd, timeoutSeconds: 120 }),
  });
  const result: VmExecResult | undefined = exec.data;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const cmd = command.trim();
    if (cmd && !exec.isPending) exec.mutate(cmd);
  };

  return (
    <form onSubmit={submit} className="space-y-3 border-t px-4 py-3.5">
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <span aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-mono text-xs text-muted-foreground">
            $
          </span>
          <Input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="sw_vers && brew --version"
            aria-label={t("card.commandAria", { name: vm.name })}
            autoComplete="off"
            spellCheck={false}
            className="h-8 pl-7 font-mono text-[12.5px]"
          />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={!command.trim() || exec.isPending}>
          {exec.isPending ? <Spinner /> : <Play />} {t("card.run")}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        <Trans t={t} i18nKey="card.runsAs" values={{ user: vm.guestUser }} components={{ mono: <span className="font-mono" /> }} />
      </p>
      {exec.isError && (
        <p className="rounded-lg border border-destructive/25 bg-destructive/[0.05] px-3 py-2 text-xs text-destructive" role="alert">
          {errorMessage(exec.error)}
        </p>
      )}
      {result && (
        <div className="overflow-hidden rounded-lg border bg-paper-2" aria-live="polite">
          <div className="flex items-center gap-2 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
            <span
              className={cn(
                "rounded-[4px] border px-1 font-mono tabular-nums",
                result.exitCode === 0 ? "border-success/25 text-success" : "border-destructive/25 text-destructive",
              )}
            >
              exit {result.exitCode ?? "–"}
            </span>
            {result.timedOut && <span className="font-medium text-warning">{t("card.timedOut")}</span>}
            <span className="ml-auto truncate font-mono">{exec.variables}</span>
          </div>
          <pre className="max-h-64 overflow-auto p-3 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-foreground">
            {result.stdout}
            {result.stderr && <span className="text-destructive">{result.stderr}</span>}
            {!result.stdout && !result.stderr && <span className="text-muted-foreground">{t("card.noOutput")}</span>}
          </pre>
        </div>
      )}
    </form>
  );
}
