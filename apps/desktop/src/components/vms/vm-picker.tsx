import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowRight, Box, Check, ChevronDown, Laptop, Loader2, Plus, Settings2 } from "lucide-react";
import type { Vm } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useVmChoices } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { VM_STATE_LABEL, VmStateDot } from "./vm-parts";

/** A VM a chat would use without its own choice, and where that comes from ("Coder", "ACME workspace"). */
export interface InheritedVm {
  vmId: string;
  from: string;
}

/** First inherited candidate that still exists (the agent's VM wins over its workspace's). */
function resolveInherited(candidates: (InheritedVm | null | undefined)[], vms: Vm[]): { vm: Vm; from: string } | null {
  for (const c of candidates) {
    const vm = c ? vms.find((v) => v.id === c.vmId) : undefined;
    if (vm && c) return { vm, from: c.from };
  }
  return null;
}

/**
 * Composer control for the macOS VM a chat works in: an icon button when there's none, a pill with the VM's name
 * otherwise (muted when it comes from the agent or workspace). Hidden when VMs are off or unsupported.
 */
export function VmChip({
  value,
  inherited,
  onChange,
  busy,
}: {
  /** The chat's own VM; null = the agent's (or workspace's). */
  value: string | null;
  /** Candidates in order: the agent's VM, then its workspace's. */
  inherited: (InheritedVm | null | undefined)[];
  onChange: (vmId: string | null) => void | Promise<unknown>;
  busy?: boolean;
}) {
  const { available, vms } = useVmChoices();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  if (!available) return null;

  const own = value ? (vms.find((v) => v.id === value) ?? null) : null;
  const fallback = resolveInherited(inherited, vms);
  const current = own ?? fallback?.vm ?? null;
  const pick = (vmId: string | null) => {
    setOpen(false);
    if (vmId !== value) void onChange(vmId);
  };
  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };

  const tooltip = own
    ? `This chat works in ${own.name} (${VM_STATE_LABEL[own.state].toLowerCase()})`
    : fallback
      ? `Works in ${fallback.vm.name} — the VM of ${fallback.from}`
      : "Work in a virtual machine";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            {current ? (
              <button
                type="button"
                aria-label={`Virtual machine: ${current.name}${own ? "" : " (default)"}`}
                className={cn(
                  "flex h-8 max-w-[12rem] min-w-0 shrink items-center gap-1.5 rounded-lg border pr-1.5 pl-2 text-[13px] transition focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                  own ? "bg-card hover:bg-accent" : "border-dashed text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {busy ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <Box className="size-3.5 shrink-0 text-muted-foreground" />}
                <span className={cn("truncate", own && "font-medium")}>{current.name}</span>
                <VmStateDot state={current.state} />
                <ChevronDown className="size-3.5 shrink-0 opacity-60" />
              </button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                aria-label="Work in a virtual machine"
                className={cn(
                  "h-8 gap-1.5 rounded-lg px-2 text-[13px] font-normal text-muted-foreground hover:text-foreground has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-4",
                  open && "bg-accent text-foreground",
                )}
              >
                {busy ? <Loader2 className="animate-spin" /> : <Box />}
                <span className="@max-sm/composer:sr-only">VM</span>
              </Button>
            )}
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" side="top" sideOffset={8} className="w-80 overflow-hidden rounded-xl p-0">
        <div className="border-b px-3 pt-2.5 pb-2">
          <p className="text-[13px] font-medium">Virtual machine</p>
          <p className="text-xs text-muted-foreground">Runs in this chat install tools, run commands and use apps in this macOS VM instead of on your Mac.</p>
        </div>
        {vms.length === 0 ? (
          <div className="space-y-3 px-3 py-4 text-center">
            <p className="text-xs text-muted-foreground">No virtual machines yet.</p>
            <Button size="sm" onClick={() => go("/vms?new=1")}>
              <Plus /> Create a VM
            </Button>
          </div>
        ) : (
          <Command>
            <CommandList className="max-h-72">
              <CommandGroup>
                <CommandItem value="__default" onSelect={() => pick(null)} className="gap-2.5 py-2">
                  <span className="grid size-6 shrink-0 place-items-center rounded-md border bg-paper-2 text-muted-foreground [&_svg]:size-3.5">
                    {fallback ? <Box /> : <Laptop />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{fallback ? `Default — ${fallback.vm.name}` : "Default — this Mac"}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{fallback ? `The VM of ${fallback.from}` : "The agent and its workspace have no VM"}</span>
                  </span>
                  {!value && <Check className="size-4" aria-label="Selected" />}
                </CommandItem>
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Work in">
                {vms.map((vm) => (
                  <CommandItem key={vm.id} value={`vm ${vm.name} ${vm.id}`} onSelect={() => pick(vm.id)} className="gap-2.5 py-2">
                    <span className="grid size-6 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground [&_svg]:size-3.5">
                      <Box />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{vm.name}</span>
                      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <VmStateDot state={vm.state} />
                        {vm.progress?.percent != null ? `${VM_STATE_LABEL[vm.state]} · ${Math.floor(vm.progress.percent)}%` : VM_STATE_LABEL[vm.state]}
                      </span>
                    </span>
                    {value === vm.id && <Check className="size-4" aria-label="Selected" />}
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup>
                <CommandItem value="__manage" onSelect={() => go("/vms")} className="text-muted-foreground">
                  <Settings2 /> Manage virtual machines
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Select for the VM of an agent or workspace. Shows a "Create a VM" link instead of an empty select when there are
 * none. Callers render it only when `useVmChoices().available`.
 */
export function VmSelectField({
  id,
  label,
  value,
  onChange,
  noneLabel,
  hint,
}: {
  id: string;
  label: ReactNode;
  value: string | null;
  onChange: (vmId: string | null) => void;
  noneLabel: string;
  hint?: ReactNode;
}) {
  const { vms, isLoading } = useVmChoices();
  const known = value === null || vms.some((v) => v.id === value);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        {vms.length > 0 && (
          <Link to="/vms" className="flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground">
            Manage VMs <ArrowRight className="size-3" />
          </Link>
        )}
      </div>
      {!isLoading && vms.length === 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-3.5">
          <Box className="size-5 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 basis-48 text-sm text-muted-foreground">No virtual machines yet — create one to give agents their own Mac.</p>
          <Button type="button" variant="outline" size="sm" asChild>
            <Link id={id} to="/vms?new=1">
              <Plus /> Create a VM
            </Link>
          </Button>
        </div>
      ) : (
        <Select value={value ?? "__none"} onValueChange={(v) => onChange(v === "__none" ? null : v)} disabled={isLoading}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="__none">{noneLabel}</SelectItem>
            {vms.length > 0 && <SelectSeparator />}
            {vms.map((vm) => (
              <SelectItem key={vm.id} value={vm.id}>
                <VmStateDot state={vm.state} />
                {vm.name}
                <span className="text-xs text-muted-foreground">{VM_STATE_LABEL[vm.state].toLowerCase()}</span>
              </SelectItem>
            ))}
            {!known && value && <SelectItem value={value}>VM not found</SelectItem>}
          </SelectContent>
        </Select>
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
