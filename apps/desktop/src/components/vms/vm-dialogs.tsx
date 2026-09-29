import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, CircleCheck, Download, HardDrive, RotateCcw, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import type { Vm, VmImagePreset, VmPatch, VmStatus } from "@godmode/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useShortPath } from "@/components/chat/folder-picker";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { formatDisplay, formatGb, formatMemory, guestFolderLabel, imageName, nextVmName } from "./vm-parts";
import type { VmActions } from "./use-vm-actions";

const MAX_NAME = 60;
const MAX_DISK_GB = 4000;
const DISPLAYS = ["1280x800", "1440x900", "1920x1200"];
const MEMORY_GB = [2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256];

/** Memory choices up to what the core allows (host memory − 2 GB), plus the current value when it's in between. */
function memoryOptions(hostMb: number, current?: number): number[] {
  const max = Math.max(2048, hostMb - 2048);
  const opts = MEMORY_GB.map((g) => g * 1024).filter((mb) => mb <= max);
  if (current && !opts.includes(current)) opts.push(current);
  return opts.sort((a, b) => a - b);
}

function displayOptions(current?: string): string[] {
  return current && !DISPLAYS.includes(current) ? [...DISPLAYS, current] : DISPLAYS;
}

/** Same defaults as the core: half the cores (2–4), 8 GB on Macs with 16 GB or more. */
function defaultSpecs(host: VmStatus["host"]) {
  const cpu = Math.min(host.cpus, Math.max(2, Math.min(4, Math.floor(host.cpus / 2))));
  const memoryMb = host.memoryMb >= 16 * 1024 ? 8192 : 4096;
  const opts = memoryOptions(host.memoryMb);
  return { cpu, memoryMb: opts.includes(memoryMb) ? memoryMb : (opts.at(-1) ?? 2048) };
}

function Field({ label, htmlFor, hint, children, className }: { label: ReactNode; htmlFor: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** CPU, memory, display and disk — shared by the new and edit dialogs. */
function SpecFields({
  idPrefix,
  host,
  cpu,
  memoryMb,
  display,
  disk,
  minDisk,
  diskDisabled,
  diskHint,
  onChange,
}: {
  idPrefix: string;
  host: VmStatus["host"];
  cpu: number;
  memoryMb: number;
  display: string;
  disk: string;
  minDisk: number;
  diskDisabled?: boolean;
  diskHint?: ReactNode;
  onChange: (patch: Partial<{ cpu: number; memoryMb: number; display: string; disk: string }>) => void;
}) {
  const cpus = Array.from({ length: Math.max(host.cpus, cpu) }, (_, i) => i + 1);
  const diskNum = Number(disk);
  const diskInvalid = !disk.trim() || !Number.isInteger(diskNum) || diskNum < minDisk || diskNum > MAX_DISK_GB;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label="CPU cores" htmlFor={`${idPrefix}-cpu`}>
        <Select value={String(cpu)} onValueChange={(v) => onChange({ cpu: Number(v) })}>
          <SelectTrigger id={`${idPrefix}-cpu`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" className="max-h-64">
            {cpus.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n} {n === 1 ? "core" : "cores"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Memory" htmlFor={`${idPrefix}-memory`}>
        <Select value={String(memoryMb)} onValueChange={(v) => onChange({ memoryMb: Number(v) })}>
          <SelectTrigger id={`${idPrefix}-memory`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {memoryOptions(host.memoryMb, memoryMb).map((mb) => (
              <SelectItem key={mb} value={String(mb)}>
                {formatMemory(mb)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Display" htmlFor={`${idPrefix}-display`}>
        <Select value={display} onValueChange={(v) => onChange({ display: v })}>
          <SelectTrigger id={`${idPrefix}-display`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {displayOptions(display).map((d) => (
              <SelectItem key={d} value={d}>
                {formatDisplay(d)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Disk size" htmlFor={`${idPrefix}-disk`} hint={diskHint}>
        <div
          className={cn(
            "flex h-9 items-center rounded-md border border-input bg-card shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
            diskInvalid && !diskDisabled && "border-destructive",
            diskDisabled && "opacity-50",
          )}
        >
          <input
            id={`${idPrefix}-disk`}
            type="number"
            inputMode="numeric"
            min={minDisk}
            max={MAX_DISK_GB}
            step={1}
            value={disk}
            disabled={diskDisabled}
            aria-invalid={diskInvalid && !diskDisabled}
            onChange={(e) => onChange({ disk: e.target.value })}
            className="h-full w-full min-w-0 bg-transparent px-3 text-sm tabular-nums outline-none [appearance:textfield] disabled:cursor-not-allowed [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <span className="pr-3 text-xs text-muted-foreground">GB</span>
        </div>
      </Field>
    </div>
  );
}

function diskValid(disk: string, min: number): boolean {
  const n = Number(disk);
  return !!disk.trim() && Number.isInteger(n) && n >= min && n <= MAX_DISK_GB;
}

/* ------------------------------------------------------------------ */
/* New VM                                                               */
/* ------------------------------------------------------------------ */

export function NewVmDialog({
  open,
  onOpenChange,
  status,
  vms,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: VmStatus;
  vms: Vm[];
  onCreated?: (vm: Vm) => void;
}) {
  const qc = useQueryClient();
  const short = useShortPath();
  const presets = status.images;
  const recommended = presets.find((p) => p.recommended) ?? presets[0];
  const defaults = useMemo(() => defaultSpecs(status.host), [status.host]);
  const [name, setName] = useState("");
  const [imageId, setImageId] = useState(recommended?.id ?? "");
  const [cpu, setCpu] = useState(defaults.cpu);
  const [memoryMb, setMemoryMb] = useState(defaults.memoryMb);
  const [display, setDisplay] = useState("1440x900");
  const [disk, setDisk] = useState(String(recommended?.diskGb ?? 50));
  const [diskTouched, setDiskTouched] = useState(false);
  const [start, setStart] = useState(true);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(nextVmName(vms));
    setImageId(recommended?.id ?? "");
    setCpu(defaults.cpu);
    setMemoryMb(defaults.memoryMb);
    setDisplay("1440x900");
    setDisk(String(recommended?.diskGb ?? 50));
    setDiskTouched(false);
    setStart(true);
    setAdvanced(false);
    // Only when the dialog opens: realtime list updates must not reset what the user typed.
  }, [open]);

  const preset = presets.find((p) => p.id === imageId) ?? recommended;
  const minDisk = preset?.diskGb ?? 20;

  const pickImage = (id: string) => {
    setImageId(id);
    const next = presets.find((p) => p.id === id);
    if (next && (!diskTouched || Number(disk) < next.diskGb)) setDisk(String(next.diskGb));
  };

  const diskGb = Number(disk);
  const needGb = (preset && !preset.downloaded ? preset.downloadGb : 0) + (Number.isFinite(diskGb) ? diskGb : minDisk);
  const free = status.host.freeDiskGb;
  const tight = free !== null && free < needGb;
  const valid = !!name.trim() && name.trim().length <= MAX_NAME && !!preset && diskValid(disk, minDisk);

  const create = useMutation({
    mutationFn: () =>
      api.vms.create({
        name: name.trim(),
        image: preset!.image,
        cpu,
        memoryMb,
        diskGb,
        display,
        start,
      }),
    onSuccess: (vm) => {
      qc.setQueryData<Vm[]>(qk.vmList, (old) => (old ? (old.some((v) => v.id === vm.id) ? old : [...old, vm]) : old));
      void qc.invalidateQueries({ queryKey: qk.vms });
      toast.success(`Creating ${vm.name}`, {
        description: preset?.downloaded
          ? start
            ? "It's ready and booting in a moment."
            : "It's ready in a moment."
          : `Downloading ${preset?.name ?? "the image"} (${preset?.downloadGb ?? "~27"} GB) — keep working, progress shows on its card.`,
      });
      onCreated?.(vm);
      onOpenChange(false);
    },
    onError: (e) => toastApiError(e, "Couldn't create the VM", qc),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid && !create.isPending) create.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-xl">
        <form onSubmit={submit}>
          <DialogHeader className="border-b bg-paper-2 px-6 pt-6 pb-5">
            <DialogTitle>New virtual machine</DialogTitle>
            <DialogDescription>
              A clean macOS on this Mac for your agents to work in — isolated from your files and apps. It keeps its disk until you reset or delete it.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[min(38rem,calc(100dvh-16rem))] space-y-5 overflow-y-auto px-6 py-5">
            <Field label="Name" htmlFor="new-vm-name">
              <Input id="new-vm-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={MAX_NAME} autoFocus required placeholder="e.g. Build machine" />
            </Field>

            <div className="space-y-2">
              <span id="new-vm-image-label" className="text-sm font-medium">
                macOS image
              </span>
              <RadioGroup value={preset?.id ?? ""} onValueChange={pickImage} aria-labelledby="new-vm-image-label" className="grid gap-2">
                {presets.map((p) => (
                  <ImageCard key={p.id} preset={p} checked={p.id === preset?.id} downloading={status.downloads[p.image]} />
                ))}
              </RadioGroup>
            </div>

            <Collapsible open={advanced} onOpenChange={setAdvanced}>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground transition hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <ChevronRight className={cn("size-4 transition-transform", advanced && "rotate-90")} />
                  Advanced
                  <span className="font-normal">
                    · {cpu} {cpu === 1 ? "core" : "cores"}, {formatMemory(memoryMb)}, {diskValid(disk, minDisk) ? `${disk} GB disk` : "disk"}, {formatDisplay(display)}
                  </span>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-4">
                <SpecFields
                  idPrefix="new-vm"
                  host={status.host}
                  cpu={cpu}
                  memoryMb={memoryMb}
                  display={display}
                  disk={disk}
                  minDisk={minDisk}
                  diskHint={`At least ${minDisk} GB for this image. Disks can only grow later.`}
                  onChange={(p) => {
                    if (p.cpu !== undefined) setCpu(p.cpu);
                    if (p.memoryMb !== undefined) setMemoryMb(p.memoryMb);
                    if (p.display !== undefined) setDisplay(p.display);
                    if (p.disk !== undefined) {
                      setDisk(p.disk);
                      setDiskTouched(true);
                    }
                  }}
                />
                <p className="mt-3 text-xs text-muted-foreground">
                  This Mac: {status.host.cpus} cores, {formatMemory(status.host.memoryMb)} memory. Changes to CPU, memory and display apply on the VM's next start.
                </p>
              </CollapsibleContent>
            </Collapsible>

            <label htmlFor="new-vm-start" className="flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-3.5 transition hover:border-foreground/15">
              <Checkbox id="new-vm-start" checked={start} onCheckedChange={(v) => setStart(v === true)} className="mt-0.5" />
              <span className="min-w-0 space-y-0.5">
                <span className="block text-sm font-medium">Start when ready</span>
                <span className="block text-xs text-muted-foreground">Boot macOS as soon as the VM is created, so it's warm when an agent needs it.</span>
              </span>
            </label>

            <div className={cn("flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs", tight ? "border-warning/30 bg-warning/[0.07]" : "bg-paper-2")}>
              {tight ? <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" /> : <HardDrive className="mt-px size-3.5 shrink-0 text-muted-foreground" />}
              <p className="min-w-0 text-muted-foreground">
                {free === null ? (
                  "Free space on this Mac is unknown."
                ) : tight ? (
                  <>
                    <span className="font-medium text-foreground">Only {free} GB free.</span>{" "}
                    {preset && !preset.downloaded ? `The download (${preset.downloadGb} GB) and the VM's disk (up to ${diskGb || minDisk} GB)` : `The VM's disk (up to ${diskGb || minDisk} GB)`} may not
                    fit — free up space or pick a smaller disk.
                  </>
                ) : (
                  <>
                    <span className="font-medium text-foreground">{free} GB free</span> on this Mac. The VM's disk only takes up the space macOS actually uses.
                  </>
                )}{" "}
                Stored in <span className="font-mono break-all">{short(status.storageDir)}</span>.
              </p>
            </div>
          </div>

          <DialogFooter className="border-t bg-paper-2 px-6 py-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || create.isPending}>
              {create.isPending ? <Spinner /> : preset && !preset.downloaded ? <Download /> : null}
              {create.isPending ? (status.tart.installed ? "Creating…" : "Setting up…") : preset && !preset.downloaded ? "Download & create" : "Create VM"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ImageCard({ preset: p, checked, downloading }: { preset: VmImagePreset; checked: boolean; downloading: number | null | undefined }) {
  const id = useId();
  return (
    <Label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-3.5 font-normal transition hover:border-foreground/15",
        checked && "border-foreground/35 bg-paper-2 ring-1 ring-foreground/10 hover:border-foreground/35",
      )}
    >
      <RadioGroupItem id={id} value={p.id} className="mt-0.5" />
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
          {p.name}
          {p.recommended && <span className="rounded-[5px] border border-brand/25 bg-brand-soft px-1.5 py-px text-[10px] font-medium text-brand-strong">Recommended</span>}
        </span>
        <span className="block text-xs leading-relaxed text-muted-foreground">{p.description}</span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-0.5 text-[11.5px] text-muted-foreground tabular-nums">
          {p.downloaded ? (
            <span className="inline-flex items-center gap-1 font-medium text-success">
              <CircleCheck className="size-3.5" /> Downloaded — ready in seconds
            </span>
          ) : downloading !== undefined ? (
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <Spinner className="size-3" /> Downloading{downloading !== null ? ` · ${Math.floor(downloading)}%` : "…"}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <Download className="size-3.5" /> ~{Math.round(p.downloadGb)} GB download
            </span>
          )}
          <span className="opacity-40">·</span>
          <span>{p.diskGb} GB disk</span>
        </span>
      </span>
    </Label>
  );
}

/* ------------------------------------------------------------------ */
/* Edit                                                                 */
/* ------------------------------------------------------------------ */

export function EditVmDialog({ vm, status, onClose, actions }: { vm: Vm | null; status: VmStatus | undefined; onClose: () => void; actions: VmActions }) {
  const [name, setName] = useState("");
  const [cpu, setCpu] = useState(4);
  const [memoryMb, setMemoryMb] = useState(8192);
  const [display, setDisplay] = useState("1440x900");
  const [disk, setDisk] = useState("");

  useEffect(() => {
    if (!vm) return;
    setName(vm.name);
    setCpu(vm.cpu);
    setMemoryMb(vm.memoryMb);
    setDisplay(vm.display);
    setDisk(String(vm.diskGb));
    // Seed once per opened VM: realtime updates of the same VM must not reset the form.
  }, [vm?.id]);

  if (!vm) return null;
  const host = status?.host ?? { cpus: Math.max(vm.cpu, 8), memoryMb: Math.max(vm.memoryMb + 2048, 16384), freeDiskGb: null };
  const canResize = vm.state === "stopped";
  // A suspended VM resumes with the hardware it was saved with.
  const suspended = vm.state === "suspended";
  const bootsLater = vm.state === "running" || vm.state === "starting";

  const patch: VmPatch = {};
  if (name.trim() !== vm.name) patch.name = name.trim();
  if (!suspended) {
    if (cpu !== vm.cpu) patch.cpu = cpu;
    if (memoryMb !== vm.memoryMb) patch.memoryMb = memoryMb;
    if (display !== vm.display) patch.display = display;
  }
  if (canResize && Number(disk) !== vm.diskGb) patch.diskGb = Number(disk);
  const changed = Object.keys(patch).length > 0;
  const valid = !!name.trim() && (!canResize || diskValid(disk, vm.diskGb));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!changed || !valid || actions.update.isPending) return;
    actions.update.mutate({ vm, patch }, { onSuccess: onClose });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>Edit “{vm.name}”</DialogTitle>
            <DialogDescription>
              {suspended
                ? "It's suspended with its current hardware. Shut it down (⋯ → Shut down) to change CPU, memory, display or disk."
                : bootsLater
                  ? "CPU, memory and display changes apply the next time the VM starts."
                  : "Changes apply the next time the VM starts."}
            </DialogDescription>
          </DialogHeader>
          <Field label="Name" htmlFor="edit-vm-name">
            <Input id="edit-vm-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={MAX_NAME} autoFocus />
          </Field>
          {!suspended && (
          <SpecFields
            idPrefix="edit-vm"
            host={host}
            cpu={cpu}
            memoryMb={memoryMb}
            display={display}
            disk={disk}
            minDisk={vm.diskGb}
            diskDisabled={!canResize}
            diskHint={canResize ? "Disks can only grow." : "Stop the VM to grow its disk."}
            onChange={(p) => {
              if (p.cpu !== undefined) setCpu(p.cpu);
              if (p.memoryMb !== undefined) setMemoryMb(p.memoryMb);
              if (p.display !== undefined) setDisplay(p.display);
              if (p.disk !== undefined) setDisk(p.disk);
            }}
          />
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!changed || !valid || actions.update.isPending}>
              {actions.update.isPending && <Spinner />} Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Reset + delete                                                       */
/* ------------------------------------------------------------------ */

export function ResetVmDialog({ vm, presets, onClose, actions }: { vm: Vm | null; presets: VmImagePreset[] | undefined; onClose: () => void; actions: VmActions }) {
  const [start, setStart] = useState(false);
  useEffect(() => {
    // Default: back to how it was (seeded per VM, not on every realtime update).
    if (vm) setStart(vm.state === "running" || vm.state === "starting");
  }, [vm?.id]);
  return (
    <AlertDialog open={!!vm} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reset “{vm?.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Its disk is erased and recreated from {vm ? imageName(vm.image, presets) : "its image"} — apps, files and settings inside the VM are gone.
            {vm?.state === "running" || vm?.state === "suspended" ? " It's shut down first." : ""} The shared folder ({vm ? guestFolderLabel(vm) : "~/Godmode"} in
            the VM) and who uses the VM are kept.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label htmlFor="reset-vm-start" className="flex cursor-pointer items-center gap-2.5 text-sm">
          <Checkbox id="reset-vm-start" checked={start} onCheckedChange={(v) => setStart(v === true)} />
          Start it again when it's ready
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              if (vm) actions.reset.mutate({ vm, start });
              onClose();
            }}
          >
            <RotateCcw /> Reset VM
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DeleteVmDialog({ vm, onClose, actions }: { vm: Vm | null; onClose: () => void; actions: VmActions }) {
  const short = useShortPath();
  const [keepFiles, setKeepFiles] = useState(false);
  useEffect(() => {
    if (vm) setKeepFiles(false);
  }, [vm?.id]);
  const users = vm?.assignments.length ?? 0;
  return (
    <AlertDialog open={!!vm} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{vm?.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            {vm?.state === "creating"
              ? "Creating it stops and the VM is removed from this Mac."
              : `The VM and its disk${vm?.diskUsageBytes ? ` (${formatGb(vm.diskUsageBytes)})` : ""} are removed from this Mac. This can't be undone.`}
            {users > 0 &&
              (users === 1
                ? ` ${vm?.assignments[0]?.name ?? "The agent, chat or workspace using it"} goes back to working on this Mac, unless it has another VM.`
                : ` The ${users} agents, chats and workspaces using it go back to working on this Mac, unless they have another VM.`)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label htmlFor="delete-vm-keep" className="flex cursor-pointer items-start gap-2.5 rounded-lg border bg-paper-2 p-3 text-sm">
          <Checkbox id="delete-vm-keep" checked={keepFiles} onCheckedChange={(v) => setKeepFiles(v === true)} className="mt-0.5" />
          <span className="min-w-0 space-y-0.5">
            <span className="block font-medium">Keep the shared folder's files</span>
            {vm && <span className="block font-mono text-[11px] break-all text-muted-foreground">{short(vm.sharedDir)}</span>}
          </span>
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              if (vm) actions.remove.mutate({ vm, keepFiles });
              onClose();
            }}
          >
            <Trash2 /> Delete VM
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
