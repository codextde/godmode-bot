import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
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
  const [commandOpen, setCommandOpen] = useState(false);
  const busy = vmBusy(vm.state);
  const working = vm.state === "creating" || vm.state === "starting";
  const running = vm.state === "running";
  const preset = presetOf(vm.image, presets);
  const progress =
    vm.progress ??
    (busy ? { phase: "boot" as const, label: vm.state === "stopping" ? "Shutting macOS down…" : vm.state === "starting" ? "Starting macOS…" : "Preparing…", percent: null } : null);
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
            <span className="inline-flex items-center gap-1" title="CPU cores">
              <Cpu aria-hidden /> {vm.cpu} {vm.cpu === 1 ? "core" : "cores"}
            </span>
            <span className="inline-flex items-center gap-1" title="Memory">
              <MemoryStick aria-hidden /> {formatMemory(vm.memoryMb)}
            </span>
            <span className="inline-flex items-center gap-1" title={vm.diskUsageBytes !== null ? `${formatGb(vm.diskUsageBytes)} used on this Mac` : "Disk size"}>
              <HardDrive aria-hidden /> {vm.diskGb} GB
              {vm.diskUsageBytes !== null && <span className="text-muted-foreground/80">({formatGb(vm.diskUsageBytes)} used)</span>}
            </span>
            <span className="inline-flex items-center gap-1" title="Display">
              <Monitor aria-hidden /> {formatDisplay(vm.display)}
            </span>
          </p>
          {running && vm.ip && (
            <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              IP <span className="font-mono text-foreground/80">{vm.ip}</span>
              <CopyButton text={vm.ip} label="Copy IP address" className="size-5" />
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
                  {resetting ? <Spinner className="size-3" /> : <RotateCcw />} Reset
                </Button>
              </TooltipTrigger>
              <TooltipContent>Recreate it from its image — the shared folder is kept</TooltipContent>
            </Tooltip>
          )}
        </div>
      )}

      <div className="mt-auto border-t px-4 py-3">
        <UsedBy vm={vm} vms={vms} actions={actions} />
      </div>

      <div className="flex flex-wrap items-center gap-0.5 rounded-b-xl border-t bg-paper-2/70 px-2 py-1.5">
        <OpenButton vm={vm} what="screen" actions={actions} icon={<Monitor />} label="Screen" />
        <OpenButton vm={vm} what="terminal" actions={actions} icon={<SquareTerminal />} label="Terminal" />
        <OpenButton vm={vm} what="folder" actions={actions} icon={<FolderOpen />} label="Shared folder" />
        {running && (
          <Button
            variant="ghost"
            size="sm"
            className={cn("ml-auto h-7 gap-1.5 px-2 text-[12.5px] font-normal text-muted-foreground hover:text-foreground", commandOpen && "bg-accent text-foreground")}
            aria-expanded={commandOpen}
            aria-controls={`vm-command-${vm.id}`}
            onClick={() => setCommandOpen((o) => !o)}
          >
            <Terminal className="size-3.5" /> Run command
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
      aria-label={`Open the screen of ${vm.name} in Screen Sharing`}
      className="group relative block w-full overflow-hidden rounded-lg border bg-paper-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      style={{ aspectRatio: String(aspect) }}
    >
      {data ? (
        <img src={`data:${data.mime};base64,${data.data}`} alt="" draggable={false} className="absolute inset-0 size-full object-contain select-none" />
      ) : (
        <span className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
          {isError ? "The screen isn't available right now" : <Spinner className="size-4" />}
        </span>
      )}
      <span className="absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-md bg-background/85 px-2 py-1 text-[11.5px] text-foreground opacity-0 shadow-card backdrop-blur transition group-hover:opacity-100 group-focus-visible:opacity-100">
        {opening ? <Spinner className="size-3" /> : <Monitor className="size-3" />} Open in Screen Sharing
      </span>
    </button>
  );
}

function PrimaryAction({ vm, actions }: { vm: Vm; actions: VmActions }) {
  const starting = actions.start.isPending && actions.start.variables?.id === vm.id;
  const stopping = actions.stop.isPending && actions.stop.variables?.id === vm.id;
  switch (vm.state) {
    case "stopped":
    case "suspended":
      return (
        <Button size="sm" onClick={() => actions.start.mutate(vm)} disabled={starting}>
          {starting ? <Spinner /> : <Play />} {vm.state === "suspended" ? "Resume" : "Start"}
        </Button>
      );
    case "running":
      return (
        <Button size="sm" variant="outline" onClick={() => actions.stop.mutate(vm)} disabled={stopping}>
          {stopping ? <Spinner /> : <Square />} Stop
        </Button>
      );
    case "starting":
      return (
        <Button size="sm" variant="outline" disabled>
          <Spinner /> Starting…
        </Button>
      );
    case "stopping":
      return (
        <Button size="sm" variant="outline" disabled>
          <Spinner /> Stopping…
        </Button>
      );
    default:
      return null;
  }
}

function VmMenu({ vm, actions, onEdit, onReset, onDelete }: { vm: Vm; actions: VmActions; onEdit: () => void; onReset: () => void; onDelete: () => void }) {
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
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`More actions for ${vm.name}`}>
          {pending ? <Spinner /> : <Ellipsis />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem disabled={s !== "stopped" && s !== "suspended"} onClick={() => actions.start.mutate(vm)}>
          <Play /> {s === "suspended" ? "Resume" : "Start"}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={s !== "running"} onClick={() => actions.suspend.mutate(vm)}>
          <Moon /> Suspend
        </DropdownMenuItem>
        <DropdownMenuItem disabled={s !== "running"} onClick={() => actions.restart.mutate(vm)}>
          <RotateCw /> Restart
        </DropdownMenuItem>
        <DropdownMenuItem disabled={s !== "running" && s !== "starting" && s !== "suspended"} onClick={() => actions.stop.mutate(vm)}>
          <Power /> {s === "suspended" ? "Shut down" : "Stop"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={busy} onClick={onEdit}>
          <Pencil /> Edit…
        </DropdownMenuItem>
        <DropdownMenuItem disabled={s !== "stopped"} onClick={() => actions.duplicate.mutate({ vm })}>
          <CopyPlus /> Duplicate
          {s !== "stopped" && s !== "creating" && s !== "error" && <span className="ml-auto text-[11px] text-muted-foreground">Stop first</span>}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={busy} onClick={onReset}>
          <RotateCcw /> Reset…
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          <Trash2 /> Delete…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function OpenButton({ vm, what, actions, icon, label }: { vm: Vm; what: VmOpenTarget; actions: VmActions; icon: ReactNode; label: string }) {
  const pending = actions.open.isPending && actions.open.variables?.vm.id === vm.id && actions.open.variables.what === what;
  const needsVm = what !== "folder";
  const disabled = needsVm && (vm.state === "creating" || vm.state === "stopping" || vm.state === "error");
  const hint =
    what === "folder"
      ? `Open in Finder — the VM sees it as ${guestFolderLabel(vm)}`
      : disabled
        ? vm.state === "error"
          ? "Reset the VM first"
          : "Available when the VM is ready"
        : vm.state === "running"
          ? what === "screen"
            ? "Show its screen in Screen Sharing"
            : `Open Terminal, signed in as ${vm.guestUser}`
          : `Starts the VM, then ${what === "screen" ? "shows its screen" : "opens Terminal"}`;
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
  const { data: agents = [] } = useAllAgents();
  const { data: workspaces = [] } = useWorkspaces();
  const removing = (a: VmAssignment) =>
    actions.assign.isPending && actions.assign.variables?.vm.id === vm.id && actions.assign.variables.id === a.id && !actions.assign.variables.assigned;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="eyebrow mr-1 text-[10.5px]">Used by</span>
      {vm.assignments.length === 0 && <span className="mr-1 text-xs text-muted-foreground">No one yet</span>}
      {vm.assignments.map((a) => {
        const agent = a.kind === "agent" ? agents.find((x) => x.id === a.id) : undefined;
        const ws = a.kind === "workspace" ? workspaces.find((x) => x.id === a.id) : undefined;
        const kind = a.kind === "conversation" ? "Chat" : a.kind === "agent" ? "Agent" : "Workspace";
        return (
          <span key={`${a.kind}:${a.id}`} className="inline-flex h-6 max-w-[14rem] min-w-0 items-center rounded-md border bg-card text-xs shadow-xs">
            <Link
              to={assignmentHref(a)}
              title={`${kind}: ${a.name}`}
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
              <span className="truncate">{a.name || (a.kind === "conversation" ? "Untitled chat" : kind)}</span>
            </Link>
            <button
              type="button"
              aria-label={`Stop using ${vm.name} for ${a.name || kind.toLowerCase()}`}
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
        <Button variant="ghost" size="xs" className="h-6 text-muted-foreground hover:text-foreground" aria-label={`Assign ${vm.name} to an agent or workspace`}>
          <Plus /> Assign
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 overflow-hidden p-0">
        <Command>
          <CommandInput placeholder="Search agents and workspaces…" />
          <CommandList className="max-h-72">
            <CommandEmpty>Nothing found.</CommandEmpty>
            {sortedAgents.length > 0 && (
              <CommandGroup heading="Agents">
                {sortedAgents.map((a) => {
                  const other = a.vmId && a.vmId !== vm.id ? nameOf(a.vmId) : null;
                  return (
                    <CommandItem key={a.id} value={`agent ${a.name} ${a.id}`} onSelect={() => toggle("agent", a.id, a.name, a.vmId)} className="gap-2.5 py-1.5">
                      <AgentAvatar agent={a} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{a.name}</span>
                        {other && <span className="block truncate text-[11px] text-muted-foreground">Uses {other} — switches to this one</span>}
                      </span>
                      {a.vmId === vm.id && <Check className="size-4" aria-label="Assigned" />}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
            {workspaces.length > 0 && (
              <CommandGroup heading="Workspaces">
                {workspaces.map((w) => {
                  const other = w.vmId && w.vmId !== vm.id ? nameOf(w.vmId) : null;
                  return (
                    <CommandItem key={w.id} value={`workspace ${w.name} ${w.id}`} onSelect={() => toggle("workspace", w.id, w.name, w.vmId)} className="gap-2.5 py-1.5">
                      <WorkspaceTile icon={w.icon} color={w.color} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{w.name}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">{other ? `Uses ${other} — switches to this one` : "Every agent in it, unless it has its own"}</span>
                      </span>
                      {w.vmId === vm.id && <Check className="size-4" aria-label="Assigned" />}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
        <p className="border-t bg-paper-2 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          For a single chat, pick the VM with the <span className="font-medium text-foreground">VM</span> button in its message box.
        </p>
      </PopoverContent>
    </Popover>
  );
}

/* ------------------------------------------------------------------ */
/* Run a command                                                        */
/* ------------------------------------------------------------------ */

function CommandPanel({ vm }: { vm: Vm }) {
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
            aria-label={`Command to run in ${vm.name}`}
            autoComplete="off"
            spellCheck={false}
            className="h-8 pl-7 font-mono text-[12.5px]"
          />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={!command.trim() || exec.isPending}>
          {exec.isPending ? <Spinner /> : <Play />} Run
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Runs in the VM as <span className="font-mono">{vm.guestUser}</span> — stops after 2 minutes. Agents use the same shell.
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
            {result.timedOut && <span className="font-medium text-warning">Timed out</span>}
            <span className="ml-auto truncate font-mono">{exec.variables}</span>
          </div>
          <pre className="max-h-64 overflow-auto p-3 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-foreground">
            {result.stdout}
            {result.stderr && <span className="text-destructive">{result.stderr}</span>}
            {!result.stdout && !result.stderr && <span className="text-muted-foreground">(no output)</span>}
          </pre>
        </div>
      )}
    </form>
  );
}
