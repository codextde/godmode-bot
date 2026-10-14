import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, ClipboardPaste, Copy, LogOut, MessagesSquare, MoonStar, Network, Plus, RefreshCw, TriangleAlert, Unlink, X } from "lucide-react";
import { toast } from "sonner";
import { DEVICE_INVITE_PREFIX, parseDeviceInvite, RUNNER_CODE_PREFIX, type DeviceGroup, type GroupDevice } from "@godmode/shared";
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { copyText } from "@/components/chat/copy-button";
import { DeviceDot, DeviceIcon, deviceStateLine, deviceWorkLine, HandoffButton, useHandoff } from "@/components/devices/device-parts";
import { RunnerStateBadge, RunnerStateDot, THIS_COMPUTER, THIS_COMPUTER_INLINE } from "@/components/runners/runner-parts";
import { useNow } from "@/components/vault/use-now";
import { toastApiError } from "@/components/vault/vault-utils";
import { api, errorMessage } from "@/lib/api";
import { useDeviceGroup } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { ExpiryRing, Step } from "./pair-phone-dialog";
import { Callout, SectionHeading, SettingRow, SettingsGroup } from "./settings-kit";

export function DevicesSection() {
  const { data: group, isLoading, isError, error, refetch } = useDeviceGroup();
  useJoinedToasts(group);

  return (
    <div className="space-y-5">
      <SectionHeading
        title="Devices"
        description="Use Godmode on several Macs as one. Chats can run on any of them and move between them, also while they work."
      />
      {isLoading ? (
        <div className="space-y-4 rounded-xl border bg-card p-6 shadow-card">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-80" />
          <Skeleton className="h-9 w-40" />
        </div>
      ) : isError || !group ? (
        <Callout tone="warning" title="Couldn't load your devices">
          <p>{errorMessage(error)}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void refetch()}>
            <RefreshCw /> Try again
          </Button>
        </Callout>
      ) : group.role ? (
        <GroupView group={group} />
      ) : (
        <AloneView />
      )}
      {group?.port && (
        <p className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
          <Network className="size-3" aria-hidden />
          The other computers reach this one on port <span className="font-mono tabular-nums text-foreground/80">{group.port}</span>. If they can't connect, allow
          it in your firewall.
        </p>
      )}
    </div>
  );
}

/** A computer that joins while the section is open gets a toast, so the human sees the invite worked. */
function useJoinedToasts(group: DeviceGroup | undefined) {
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!group) return;
    const ids = new Set(group.devices.filter((d) => !d.self && d.id).map((d) => d.id!));
    if (known.current && group.role === "primary") {
      for (const d of group.devices) if (d.id && !d.self && !known.current.has(d.id)) toast.success(`${d.name} joined your group`);
    }
    known.current = ids;
  }, [group]);
}

/* ------------------------------------------------------------------ */
/* Not in a group                                                       */
/* ------------------------------------------------------------------ */

function AloneView() {
  const [mode, setMode] = useState<"invite" | "join" | null>(null);
  return (
    <>
      <section className="relative overflow-hidden rounded-xl border bg-card shadow-card">
        <div className="flex flex-col gap-6 p-6 @xl:flex-row @xl:items-center">
          <div className="min-w-0 flex-1">
            <p className="eyebrow">Device group</p>
            <h3 className="mt-2 text-xl leading-snug font-medium tracking-[-0.025em]">One Godmode, on every Mac.</h3>
            <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
              One Mac is the primary — keep it on (a Mac mini or a desktop). The others show everything it has, and chats can run on any of them and
              move between them, also while they work.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button aria-expanded={mode === "invite"} onClick={() => setMode((m) => (m === "invite" ? null : "invite"))}>
                <Plus /> Add a computer
              </Button>
              <Button variant="outline" aria-expanded={mode === "join"} onClick={() => setMode((m) => (m === "join" ? null : "join"))}>
                <ClipboardPaste /> Join with an invite
              </Button>
            </div>
          </div>
          <GroupGlyph />
        </div>
      </section>

      <AnimatePresence mode="wait" initial={false}>
        {mode === "invite" ? (
          <motion.div key="invite" exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.15 }}>
            <SettingsGroup
              title="Add a computer"
              icon={<Plus />}
              description="Make this Mac the primary and invite another one."
              actions={<CloseButton onClick={() => setMode(null)} />}
              bodyClassName="py-5"
            >
              <InviteCode becomesPrimary />
            </SettingsGroup>
          </motion.div>
        ) : mode === "join" ? (
          <motion.div key="join" exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.15 }}>
            <SettingsGroup
              title="Join with an invite"
              icon={<ClipboardPaste />}
              description="Make the invite on the Mac that should be the primary: Settings → Devices → Add a computer."
              actions={<CloseButton onClick={() => setMode(null)} />}
              bodyClassName="py-5"
            >
              <JoinForm />
            </SettingsGroup>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <Callout tone="muted" icon={<MessagesSquare className="text-muted-foreground" />} title="What lives where">
        Agents, logins, settings, the task board, automations and My tasks live on the primary, which also runs the schedules. Each chat lives on the
        computer it runs on, and every computer of the group sees all of them.
      </Callout>
    </>
  );
}

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon-sm" className="-my-1 text-muted-foreground" aria-label="Close" onClick={onClick}>
      <X />
    </Button>
  );
}

/** A desktop and a laptop on one quiet link, with work travelling between them. */
function GroupGlyph() {
  const still = useReducedMotion();
  return (
    <div aria-hidden className="mx-auto flex shrink-0 items-end @xl:mx-0 @xl:mr-2">
      <div className="flex flex-col items-center">
        <div className="h-[62px] w-[92px] rounded-[9px] border-[1.5px] border-foreground/15 bg-paper-2 p-1">
          <div className="flex h-full flex-col justify-end gap-1 rounded-[5px] bg-card p-2">
            <span className="h-1 w-9 rounded-full bg-foreground/10" />
            <span className="h-1 w-6 rounded-full bg-brand/70" />
          </div>
        </div>
        <span className="h-2.5 w-3 bg-foreground/10" />
        <span className="h-1 w-10 rounded-full bg-foreground/15" />
      </div>
      <div className="relative mx-2 mb-[22px] w-14 border-t-[1.5px] border-dashed border-foreground/20">
        <motion.span
          className="absolute -top-[4px] left-0 size-1.5 rounded-full bg-brand"
          animate={still ? undefined : { x: [0, 50, 50, 0, 0] }}
          transition={{ duration: 4.8, times: [0, 0.35, 0.5, 0.85, 1], ease: "easeInOut", repeat: Infinity }}
        />
      </div>
      <div className="flex flex-col items-center">
        <div className="h-[46px] w-[70px] rounded-t-[7px] border-[1.5px] border-b-0 border-foreground/15 bg-paper-2 p-1">
          <div className="flex h-full items-end rounded-[3px] bg-card p-1.5">
            <span className="h-1 w-5 rounded-full bg-foreground/10" />
          </div>
        </div>
        <span className="h-1.5 w-[86px] rounded-t-[1px] rounded-b-[5px] bg-foreground/15" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Invites                                                              */
/* ------------------------------------------------------------------ */

/** Makes an invite as it mounts and shows it with its expiry; a new one on request. */
function InviteCode({ becomesPrimary }: { becomesPrimary?: boolean }) {
  const create = useMutation({ mutationFn: api.devices.invite });
  const now = useNow(1000);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    create.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const invite = create.data;
  const expiresAt = invite ? new Date(invite.expiresAt).getTime() : 0;
  const remaining = invite ? Math.max(0, Math.round((expiresAt - now) / 1000)) : 0;
  const total = invite ? Math.max(60, Math.round((expiresAt - (create.submittedAt || now)) / 1000)) : 600;
  const expired = !!invite && remaining === 0;

  const copy = async () => {
    if (!invite || !(await copyText(invite.code))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="space-y-5">
      {create.isError ? (
        <Callout tone="warning" title="Couldn't make an invite">
          <p>{errorMessage(create.error)}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => create.mutate()}>
            <RefreshCw /> Try again
          </Button>
        </Callout>
      ) : !invite ? (
        <div className="space-y-3">
          <Skeleton className="h-[74px] w-full rounded-lg" />
          <Skeleton className="h-8 w-56" />
        </div>
      ) : (
        <div className="space-y-3">
          <p
            className={cn(
              "max-h-24 overflow-y-auto rounded-lg border bg-paper-2 px-3.5 py-3 font-mono text-[11.5px] leading-relaxed break-all text-foreground/85 transition-opacity select-all",
              (expired || create.isPending) && "opacity-40",
            )}
            aria-label="Invite"
          >
            {invite.code}
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button size="sm" onClick={() => void copy()} disabled={expired || create.isPending}>
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy invite"}
            </Button>
            <span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums" aria-live="polite">
              {expired ? (
                "This invite has expired."
              ) : (
                <>
                  <ExpiryRing seconds={remaining} total={total} />
                  Valid for {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
                </>
              )}
            </span>
            <Button variant={expired ? "outline" : "ghost"} size="xs" className={cn("ml-auto", !expired && "text-muted-foreground")} onClick={() => create.mutate()} disabled={create.isPending}>
              {create.isPending ? <Spinner className="size-3" /> : <RefreshCw />} New invite
            </Button>
          </div>
        </div>
      )}

      <ol className="space-y-3.5">
        <Step n={1} title="On the other Mac, open Godmode">
          Settings → Devices → Join with an invite.
        </Step>
        <Step n={2} title="Paste this invite and join">
          It works once and only for a few minutes. Joining takes about ten seconds.
        </Step>
        {becomesPrimary ? (
          <Step n={3} title={`${THIS_COMPUTER} becomes the primary`}>
            Keep it on. The other Mac takes its agents, logins and settings; its own chats stay and show up here too.
          </Step>
        ) : (
          <Step n={3} title="It joins the group">
            It takes the group's agents, logins and settings. Its own chats stay and show up on every computer of the group.
          </Step>
        )}
      </ol>
    </div>
  );
}

function JoinForm() {
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const now = useNow(1000);
  const join = useMutation({
    mutationFn: (text: string) => api.devices.join(text),
    onSuccess: (next) => {
      qc.setQueryData(qk.devices, next);
      // The setup here was replaced by the primary's: everything the app shows changed.
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "devices" });
      toast.success(next.primaryName ? `${THIS_COMPUTER} joined ${next.primaryName}'s group` : `${THIS_COMPUTER} joined the group`, { description: "Its agents, logins and settings are here now." });
    },
  });

  const text = code.trim();
  const parsed = text ? parseDeviceInvite(text) : null;
  const expired = !!parsed && parsed.exp * 1000 < now;
  const problem = !text
    ? null
    : !parsed
      ? text.startsWith(RUNNER_CODE_PREFIX)
        ? `That's a runner's pairing code. Here, paste an invite from another Mac; it starts with ${DEVICE_INVITE_PREFIX}`
        : `That isn't an invite. It starts with ${DEVICE_INVITE_PREFIX} — copy all of it, line breaks don't matter.`
      : expired
        ? "This invite has expired. Make a new one on the other Mac."
        : null;
  const ready = !!parsed && !expired;
  const name = parsed?.name ?? "the primary";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready && !join.isPending) join.mutate(text);
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Textarea
        value={code}
        onChange={(e) => {
          setCode(e.target.value);
          join.reset();
        }}
        rows={3}
        autoFocus
        spellCheck={false}
        autoComplete="off"
        disabled={join.isPending}
        aria-label="Invite"
        aria-invalid={!!problem || undefined}
        placeholder={`${DEVICE_INVITE_PREFIX}…`}
        className="max-h-40 font-mono text-[12px] break-all md:text-[12px]"
      />
      <div aria-live="polite">
        {problem ? (
          <p className="text-xs leading-relaxed text-destructive">{problem}</p>
        ) : join.isError ? (
          <div className="flex items-start gap-2.5 rounded-lg border border-destructive/25 bg-destructive/[0.05] px-3 py-2.5 text-xs" role="alert">
            <TriangleAlert className="mt-px size-3.5 shrink-0 text-destructive" aria-hidden />
            <div className="min-w-0 space-y-0.5">
              <p className="font-medium text-destructive">Couldn't join {name}</p>
              <p className="leading-relaxed break-words text-destructive/85">{errorMessage(join.error)}</p>
            </div>
          </div>
        ) : null}
      </div>
      <Callout tone="warning" title={`${THIS_COMPUTER} takes ${name}'s setup`}>
        Its agents, logins and settings replace the ones here. The chats on {THIS_COMPUTER_INLINE} stay, and show up on every computer of the group.
      </Callout>
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
        {join.isPending && <span className="mr-auto text-xs text-muted-foreground">Connecting to {name} and copying its setup…</span>}
        <Button type="submit" disabled={!ready || join.isPending}>
          {join.isPending ? <Spinner /> : <ClipboardPaste />}
          {join.isPending ? "Joining…" : parsed ? `Join ${parsed.name}` : "Join"}
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* In a group                                                           */
/* ------------------------------------------------------------------ */

function GroupView({ group }: { group: DeviceGroup }) {
  const [inviting, setInviting] = useState(false);
  const primary = group.role === "primary";
  const others = group.devices.filter((d) => !d.self).length;

  return (
    <>
      <StatusCard group={group} />
      <HandoffCard group={group} />

      <SettingsGroup
        title="Computers"
        icon={<Network />}
        description={`${group.devices.length} ${group.devices.length === 1 ? "computer" : "computers"} in this group. Chats can run on any of them.`}
        actions={
          <Button variant="outline" size="sm" onClick={() => setInviting(true)}>
            <Plus /> Add a computer
          </Button>
        }
      >
        <AnimatePresence initial={false}>
          {group.devices.map((d) => (
            <DeviceRow key={d.id ?? "primary"} device={d} removable={primary && !d.self && d.role === "secondary"} />
          ))}
        </AnimatePresence>
        {primary && others === 0 && <p className="py-4 text-sm text-muted-foreground">No other computer yet. Add one to share this Mac's Godmode.</p>}
      </SettingsGroup>

      <RunOnGroup group={group} />
      <LeaveGroup group={group} />

      <Dialog open={inviting} onOpenChange={setInviting}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[560px]">
          <DialogHeader className="border-b px-6 pt-6 pb-5 text-left">
            <DialogTitle className="text-lg font-medium tracking-[-0.02em]">Add a computer</DialogTitle>
            <DialogDescription>
              {primary ? "Paste this invite in Godmode on the other Mac." : `The invite comes from ${group.primaryName}: the new computer joins the group there.`}
            </DialogDescription>
          </DialogHeader>
          <div className="px-6 py-6">
            <InviteCode />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function RoleBadge({ role }: { role: "primary" | "secondary" }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-[5px] border px-1.5 text-[11px] font-medium whitespace-nowrap",
        role === "primary" ? "border-brand/25 bg-brand-soft text-brand-strong" : "border-border bg-secondary text-muted-foreground",
      )}
    >
      {role === "primary" ? "Primary" : "Secondary"}
    </span>
  );
}

function StatusCard({ group }: { group: DeviceGroup }) {
  const self = group.devices.find((d) => d.self);
  const primaryDevice = group.devices.find((d) => d.role === "primary");
  const secondary = group.role === "secondary";
  const count = group.devices.length;

  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border bg-card shadow-card">
      <div className="flex items-start gap-4 p-5">
        <div className="grid size-10 shrink-0 place-items-center rounded-lg border bg-paper-2 [&_svg]:size-[18px]">
          {self ? <DeviceIcon device={self} /> : <Network />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[17px] leading-snug font-medium tracking-[-0.02em]">{secondary ? `Synced with ${group.primaryName}` : `${THIS_COMPUTER} is the primary`}</h3>
            <RoleBadge role={secondary ? "secondary" : "primary"} />
          </div>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            {secondary
              ? `Agents, logins, settings, the board and automations come from ${group.primaryName}, which also runs the schedules. Chats can run here or on any other computer of the group.`
              : `It keeps the agents, logins, settings, the board and automations for ${count === 1 ? "the group" : `all ${count} computers`}, and runs the schedules. Keep it on and awake.`}
          </p>
        </div>
        {secondary && primaryDevice && (
          <RunnerStateBadge
            className="mt-1 hidden @lg:inline-flex"
            runner={{ state: group.primaryOnline ? "online" : "offline", latencyMs: primaryDevice.latencyMs, lastSeenAt: primaryDevice.lastSeenAt }}
          />
        )}
      </div>
      {secondary && !group.primaryOnline && (
        <div className="border-t px-5 py-4">
          <Callout tone="warning" title={`${group.primaryName} is offline`}>
            {group.primaryError && <p className="mb-1 break-words">{group.primaryError}</p>}
            <p>You see this Mac's own chats until it's back. Agents, the board and automations return with it.</p>
          </Callout>
        </div>
      )}
    </motion.section>
  );
}

function HandoffCard({ group }: { group: DeviceGroup }) {
  const { working, targets } = useHandoff();
  const secondary = group.role === "secondary";
  const to = secondary ? group.primaryName : targets.length === 1 ? targets[0].name : "another computer";
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.04 }}
      className="relative overflow-hidden rounded-xl border bg-card shadow-card"
    >
      <div className="flex flex-col gap-4 p-5 @xl:flex-row @xl:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-4">
          <div className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-soft text-brand-strong [&_svg]:size-[18px]">
            <MoonStar />
          </div>
          <div className="min-w-0">
            <h3 className="text-[15px] leading-snug font-medium tracking-[-0.01em]">Closing the lid?</h3>
            <p className="mt-0.5 max-w-md text-xs leading-relaxed text-muted-foreground">
              Hand the running work to {to}. Chats stop here and continue there with everything they did so far. Open the lid later and it's all here.
            </p>
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
              <span className={cn("size-1.5 rounded-full", working > 0 ? "animate-pulse bg-brand" : "bg-muted-foreground/40")} aria-hidden />
              {working === 0 ? `Nothing is working on ${THIS_COMPUTER_INLINE} right now.` : `${working} ${working === 1 ? "chat is" : "chats are"} working on ${THIS_COMPUTER_INLINE}.`}
            </p>
          </div>
        </div>
        <HandoffButton label="Hand off running work to" className="shrink-0 self-start @xl:self-center" variant={working > 0 ? "default" : "outline"} />
      </div>
    </motion.section>
  );
}

function DeviceRow({ device, removable }: { device: GroupDevice; removable: boolean }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.devices.remove(device.id!),
    onSuccess: (next) => {
      qc.setQueryData(qk.devices, next);
      void qc.invalidateQueries({ queryKey: qk.runners });
      toast.success(`${device.name} left the group`);
    },
    onError: (e) => toastApiError(e, `Couldn't remove ${device.name}`, qc),
  });
  const state = device.self ? "online" : device.state;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="overflow-hidden"
    >
      <div className="flex items-center gap-3 py-3.5">
        <div className={cn("grid size-9 shrink-0 place-items-center rounded-lg border bg-paper-2 [&_svg]:size-4", state === "offline" && "text-muted-foreground")}>
          <DeviceIcon device={device} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <p className="truncate text-sm font-medium">{device.name}</p>
            {device.self && (
              <span className="inline-flex h-5 shrink-0 items-center rounded-[5px] border px-1.5 text-[11px] font-medium whitespace-nowrap text-foreground/80">{THIS_COMPUTER}</span>
            )}
            <RoleBadge role={device.role} />
          </div>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <DeviceDot device={device} />
            <span className={cn("truncate", state === "update_required" && "text-warning")}>
              {[deviceStateLine(device), state === "update_required" && device.version ? `v${device.version}` : null, deviceWorkLine(device)].filter(Boolean).join(" · ")}
            </span>
          </p>
        </div>
        {removable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-destructive"
                aria-label={`Remove ${device.name} from the group`}
                disabled={remove.isPending}
                onClick={() => setConfirm(true)}
              >
                {remove.isPending ? <Spinner /> : <Unlink />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Remove from group</TooltipContent>
          </Tooltip>
        )}
      </div>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {device.name} from the group?</AlertDialogTitle>
            <AlertDialogDescription>
              It works on its own again, with the setup it has now. The chats that live on it stay there and no longer show up on the other
              computers.{device.activeRuns > 0 && ` ${device.activeRuns === 1 ? "1 chat is" : `${device.activeRuns} chats are`} working there right now.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => remove.mutate()}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  );
}

/** Select values: `here` is this computer (null in the API); "primary" names the primary from a secondary. */
const HERE = "here";

function RunOnGroup({ group }: { group: DeviceGroup }) {
  const qc = useQueryClient();
  const update = useMutation({
    mutationFn: (defaultRunOn: string | null) => api.devices.update({ defaultRunOn }),
    onMutate: async (defaultRunOn) => {
      await qc.cancelQueries({ queryKey: qk.devices });
      const prev = qc.getQueryData<DeviceGroup>(qk.devices);
      if (prev) qc.setQueryData<DeviceGroup>(qk.devices, { ...prev, defaultRunOn });
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.devices, ctx.prev);
      toastApiError(e, "Could not save", qc);
    },
    onSuccess: (next) => {
      qc.setQueryData(qk.devices, next);
      toast.success("Saved", { id: "settings-saved", duration: 1200 });
    },
  });

  const failover = useMutation({
    mutationFn: (input: { failover?: boolean; failoverMinutes?: number }) => api.devices.update(input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: qk.devices });
      const prev = qc.getQueryData<DeviceGroup>(qk.devices);
      if (prev) qc.setQueryData<DeviceGroup>(qk.devices, { ...prev, ...input });
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.devices, ctx.prev);
      toastApiError(e, "Could not save", qc);
    },
    onSuccess: (next) => {
      qc.setQueryData(qk.devices, next);
      toast.success("Saved", { id: "settings-saved", duration: 1200 });
    },
  });

  const value = group.defaultRunOn ?? HERE;
  const secondary = group.role === "secondary";
  const primaryDevice = group.devices.find((d) => d.role === "primary");
  const options: { value: string; label: string; hint?: string; device?: GroupDevice }[] = [{ value: HERE, label: THIS_COMPUTER }];
  if (secondary && primaryDevice) options.push({ value: "primary", label: group.primaryName ?? primaryDevice.name, hint: "primary", device: primaryDevice });
  for (const d of group.devices) {
    if (d.self || d.role !== "secondary" || !d.id) continue;
    if (d.state === "online" || d.id === value) options.push({ value: d.id, label: d.name, device: d });
  }
  const gone = !options.some((o) => o.value === value);

  return (
    <SettingsGroup title="Chats" icon={<MessagesSquare />} description="Where new chats work. Each chat can still move to another computer, also while it works.">
      <SettingRow
        label="New chats run on"
        htmlFor="devices-run-on"
        description={options.length === 1 ? "Other computers show up here while they're online." : "You can pick another computer for each chat as you start it."}
      >
        <Select value={value} onValueChange={(v) => update.mutate(v === HERE ? null : v)}>
          <SelectTrigger id="devices-run-on" className="w-60">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                <RunnerStateDot state={o.device && !o.device.self ? (o.value === "primary" ? (group.primaryOnline ? "online" : "offline") : o.device.state) : "online"} />
                <span className="truncate">{o.label}</span>
                {o.hint && <span className="text-xs text-muted-foreground">· {o.hint}</span>}
              </SelectItem>
            ))}
            {gone && (
              <SelectItem value={value}>
                <span className="text-muted-foreground">A computer that left</span>
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow
        label="Continue work when a computer goes away"
        htmlFor="devices-failover"
        description={
          group.failover
            ? `When a computer's lid closes while it works, ${group.role === "primary" ? THIS_COMPUTER_INLINE : group.primaryName} takes the work over after a few minutes. Handing off first keeps the agent's whole session.`
            : "Work stops while its computer sleeps and goes on when it's back."
        }
      >
        <div className="flex items-center gap-2">
          {group.failover && (
            <Select value={String(group.failoverMinutes)} onValueChange={(v) => failover.mutate({ failoverMinutes: Number(v) })}>
              <SelectTrigger aria-label="After" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                {[1, 3, 5, 10, 15, 30].map((m) => (
                  <SelectItem key={m} value={String(m)}>
                    after {m} min
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Switch id="devices-failover" checked={group.failover} onCheckedChange={(on) => failover.mutate({ failover: on })} />
        </div>
      </SettingRow>
    </SettingsGroup>
  );
}

function LeaveGroup({ group }: { group: DeviceGroup }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const primary = group.role === "primary";
  const leave = useMutation({
    mutationFn: api.devices.leave,
    onSuccess: (next) => {
      qc.setQueryData(qk.devices, next);
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "devices" });
      toast.success(primary ? "The group is dissolved" : `${THIS_COMPUTER} left ${group.primaryName}'s group`);
    },
    onError: (e) => toastApiError(e, primary ? "Couldn't dissolve the group" : "Couldn't leave the group", qc),
  });

  return (
    <SettingsGroup tone="danger" title={primary ? "Dissolve the group" : "Leave the group"} icon={<LogOut />}>
      <SettingRow
        label={primary ? "Every computer works on its own again" : `${THIS_COMPUTER} works on its own again`}
        description={
          primary
            ? "The other computers leave and keep the setup they have now. Chats that live on them stay there."
            : `It stops showing ${group.primaryName}'s Godmode and keeps a copy of the setup it has now, and its own chats.`
        }
      >
        <Button variant="outline" className="text-destructive hover:text-destructive" disabled={leave.isPending} onClick={() => setConfirm(true)}>
          {leave.isPending && <Spinner />}
          {primary ? "Dissolve group" : "Leave group"}
        </Button>
      </SettingRow>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{primary ? "Dissolve the group?" : `Leave ${group.primaryName}'s group?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {primary
                ? `${group.devices.length - 1 === 1 ? "The other computer leaves" : `All ${group.devices.length - 1} other computers leave`} and work on their own again, with the setup they have now. Chats that live on them stay there and no longer show up here.`
                : `This Mac stops showing ${group.primaryName}'s agents, board and automations, and works on its own again with a copy of the setup it has now. Its own chats stay here; chats on ${group.primaryName} stay there.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => leave.mutate()}>
              {primary ? "Dissolve" : "Leave"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsGroup>
  );
}
