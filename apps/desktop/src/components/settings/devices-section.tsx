import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Cable, Check, ClipboardPaste, Copy, KeyRound, LaptopMinimalCheck, LogOut, MessagesSquare, MonitorPause, MonitorSmartphone, MoonStar, Network, Plus, RefreshCw, Timer, Trash2, TriangleAlert, Unlink, X } from "lucide-react";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
import { DEVICE_INVITE_PREFIX, parseDeviceInvite, RUNNER_CODE_PREFIX, type BrowserSignIns, type DeviceGroup, type DeviceGroupPatch, type GroupDevice, type RemoteRunner } from "@godmode/shared";
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { copyText } from "@/components/chat/copy-button";
import {
  clockTime,
  countdown,
  DeviceDot,
  DeviceIcon,
  deviceState,
  deviceStateLine,
  deviceWorkLine,
  HandoffButton,
  isStandingIn,
  needsFullDiskAccess,
  useGroupClock,
  useHandoff,
} from "@/components/devices/device-parts";
import { useMacPermissionsGuide } from "@/components/permissions/mac-permissions";
import { RUNNER_STATE_LABEL, RunnerStateBadge, RunnerStateDot, runnerWorkLine } from "@/components/runners/runner-parts";
import { useNow } from "@/components/vault/use-now";
import { toastApiError } from "@/components/vault/vault-utils";
import { api, errorMessage } from "@/lib/api";
import { t as translate } from "@/i18n";
import { isMac } from "@/lib/desktop";
import { useDeviceGroup, useRunners } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { ExpiryRing, Step } from "./pair-phone-dialog";
import { Callout, SectionHeading, SettingRow, SettingsGroup } from "./settings-kit";

const here = (form: "start" | "inline" | "dat" | "acc") => translate(isMac ? `settings:devices.here.mac.${form}` : `settings:devices.here.pc.${form}`);

export function DevicesSection() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: group, isLoading, isError, error, refetch } = useDeviceGroup();
  useJoinedToasts(group);

  return (
    <div className="space-y-5">
      <SectionHeading title={t("devices.title")} description={t("devices.description")} />
      {isLoading ? (
        <div className="space-y-4 rounded-xl border bg-card p-6 shadow-card">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-80" />
          <Skeleton className="h-9 w-40" />
        </div>
      ) : isError || !group ? (
        <Callout tone="warning" title={t("devices.loadError")}>
          <p>{errorMessage(error)}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void refetch()}>
            <RefreshCw /> {t("common:actions.tryAgain")}
          </Button>
        </Callout>
      ) : group.role ? (
        <GroupView group={group} />
      ) : (
        <AloneView />
      )}
      {group && <OlderRunners group={group} />}
      {group?.port && (
        <p className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
          <Network className="size-3" aria-hidden />
          <Trans t={t} i18nKey="devices.port" values={{ port: group.port }} components={{ code: <span className="font-mono tabular-nums text-foreground/80" /> }} />
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
      for (const d of group.devices) if (d.id && !d.self && !known.current.has(d.id)) toast.success(translate("settings:devices.joinedToast", { name: d.name }));
    }
    known.current = ids;
  }, [group]);
}

/* ------------------------------------------------------------------ */
/* Not in a group                                                       */
/* ------------------------------------------------------------------ */

function AloneView() {
  const { t } = useTranslation("settings");
  const [mode, setMode] = useState<"invite" | "join" | null>(null);
  return (
    <>
      <section className="relative overflow-hidden rounded-xl border bg-card shadow-card">
        <div className="flex flex-col gap-6 p-6 @xl:flex-row @xl:items-center">
          <div className="min-w-0 flex-1">
            <p className="eyebrow">{t("devices.alone.eyebrow")}</p>
            <h3 className="mt-2 text-xl leading-snug font-medium tracking-[-0.025em]">{t("devices.alone.title")}</h3>
            <p className="mt-1.5 max-w-md text-sm text-muted-foreground">{t("devices.alone.body")}</p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button aria-expanded={mode === "invite"} onClick={() => setMode((m) => (m === "invite" ? null : "invite"))}>
                <Plus /> {t("devices.add")}
              </Button>
              <Button variant="outline" aria-expanded={mode === "join"} onClick={() => setMode((m) => (m === "join" ? null : "join"))}>
                <ClipboardPaste /> {t("devices.alone.join")}
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
              title={t("devices.add")}
              icon={<Plus />}
              description={t("devices.alone.addDescription")}
              actions={<CloseButton onClick={() => setMode(null)} />}
              bodyClassName="py-5"
            >
              <InviteCode becomesPrimary />
            </SettingsGroup>
          </motion.div>
        ) : mode === "join" ? (
          <motion.div key="join" exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.15 }}>
            <SettingsGroup
              title={t("devices.alone.join")}
              icon={<ClipboardPaste />}
              description={t("devices.alone.joinDescription")}
              actions={<CloseButton onClick={() => setMode(null)} />}
              bodyClassName="py-5"
            >
              <JoinForm />
            </SettingsGroup>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <Callout tone="muted" icon={<MessagesSquare className="text-muted-foreground" />} title={t("devices.alone.whereTitle")}>
        {t("devices.alone.whereBody")}
      </Callout>
    </>
  );
}

function CloseButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation("common");
  return (
    <Button variant="ghost" size="icon-sm" className="-my-1 text-muted-foreground" aria-label={t("actions.close")} onClick={onClick}>
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
  const { t } = useTranslation(["settings", "common"]);
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
        <Callout tone="warning" title={t("devices.invite.error")}>
          <p>{errorMessage(create.error)}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => create.mutate()}>
            <RefreshCw /> {t("common:actions.tryAgain")}
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
            aria-label={t("devices.invite.label")}
          >
            {invite.code}
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button size="sm" onClick={() => void copy()} disabled={expired || create.isPending}>
              {copied ? <Check /> : <Copy />}
              {copied ? t("common:actions.copied") : t("devices.invite.copy")}
            </Button>
            <span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums" aria-live="polite">
              {expired ? (
                t("devices.invite.expired")
              ) : (
                <>
                  <ExpiryRing seconds={remaining} total={total} />
                  {t("devices.invite.valid", { time: `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}` })}
                </>
              )}
            </span>
            <Button variant={expired ? "outline" : "ghost"} size="xs" className={cn("ml-auto", !expired && "text-muted-foreground")} onClick={() => create.mutate()} disabled={create.isPending}>
              {create.isPending ? <Spinner className="size-3" /> : <RefreshCw />} {t("devices.invite.new")}
            </Button>
          </div>
        </div>
      )}

      <ol className="space-y-3.5">
        <Step n={1} title={t("devices.invite.step1")}>
          {t("devices.invite.step1Body")}
        </Step>
        <Step n={2} title={t("devices.invite.step2")}>
          {t("devices.invite.step2Body")}
        </Step>
        {becomesPrimary ? (
          <Step n={3} title={t("devices.invite.step3Primary", { computer: here("start") })}>
            {t("devices.invite.step3PrimaryBody")}
          </Step>
        ) : (
          <Step n={3} title={t("devices.invite.step3")}>
            {t("devices.invite.step3Body")}
          </Step>
        )}
      </ol>
    </div>
  );
}

function JoinForm() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const now = useNow(1000);
  const join = useMutation({
    mutationFn: (text: string) => api.devices.join(text),
    onSuccess: (next) => {
      qc.setQueryData(qk.devices, next);
      // The setup here was replaced by the primary's: everything the app shows changed.
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "devices" });
      toast.success(next.primaryName ? t("devices.join.toastNamed", { computer: here("start"), name: next.primaryName }) : t("devices.join.toast", { computer: here("start") }), { description: t("devices.join.toastDescription") });
    },
  });

  const text = code.trim();
  const parsed = text ? parseDeviceInvite(text) : null;
  const expired = !!parsed && parsed.exp * 1000 < now;
  const problem = !text
    ? null
    : !parsed
      ? text.startsWith(RUNNER_CODE_PREFIX)
        ? t("devices.join.runnerCode", { prefix: DEVICE_INVITE_PREFIX })
        : t("devices.join.notInvite", { prefix: DEVICE_INVITE_PREFIX })
      : expired
        ? t("devices.join.expired")
        : null;
  const ready = !!parsed && !expired;
  const name = parsed?.name ?? t("devices.thePrimary");

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
        aria-label={t("devices.invite.label")}
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
              <p className="font-medium text-destructive">{t("devices.join.error", { name })}</p>
              <p className="leading-relaxed break-words text-destructive/85">{errorMessage(join.error)}</p>
            </div>
          </div>
        ) : null}
      </div>
      <Callout tone="warning" title={parsed ? t("devices.join.takesSetup", { computer: here("start"), name: parsed.name }) : t("devices.join.takesSetupPrimary", { computer: here("start") })}>
        {t("devices.join.takesSetupBody", { computer: here("dat") })}
      </Callout>
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
        {join.isPending && <span className="mr-auto text-xs text-muted-foreground">{t("devices.join.connecting", { name })}</span>}
        <Button type="submit" disabled={!ready || join.isPending}>
          {join.isPending ? <Spinner /> : <ClipboardPaste />}
          {join.isPending ? t("devices.join.joining") : parsed ? t("devices.join.joinNamed", { name: parsed.name }) : t("devices.join.join")}
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* In a group                                                           */
/* ------------------------------------------------------------------ */

function GroupView({ group }: { group: DeviceGroup }) {
  const { t } = useTranslation("settings");
  const [inviting, setInviting] = useState(false);
  const primary = group.role === "primary";
  const others = group.devices.filter((d) => !d.self).length;
  const now = useGroupClock(group);
  // While the primary is away what this computer does about it matters most.
  const away = group.role === "secondary" && !group.primaryOnline;
  const computers = t("devices.group.computersDescription", { count: group.devices.length });

  return (
    <>
      <StatusCard group={group} />
      {away && <StandInGroup group={group} now={now} />}
      <HandoffCard group={group} />

      <SettingsGroup
        title={t("devices.group.computers")}
        icon={<Network />}
        description={computers}
        actions={
          <Button variant="outline" size="sm" onClick={() => setInviting(true)}>
            <Plus /> {t("devices.add")}
          </Button>
        }
      >
        <AnimatePresence initial={false}>
          {group.devices.map((d) => (
            <DeviceRow key={d.id ?? "primary"} device={d} group={group} now={now} removable={primary && !d.self && d.role === "secondary"} />
          ))}
        </AnimatePresence>
        {primary && others === 0 && <p className="py-4 text-sm text-muted-foreground">{t("devices.group.noOthers")}</p>}
      </SettingsGroup>

      {!away && <StandInGroup group={group} now={now} />}
      <RunOnGroup group={group} />
      <BrowserSignInsGroup group={group} />
      <LeaveGroup group={group} />

      <Dialog open={inviting} onOpenChange={setInviting}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[560px]">
          <DialogHeader className="border-b px-6 pt-6 pb-5 text-left">
            <DialogTitle className="text-lg font-medium tracking-[-0.02em]">{t("devices.add")}</DialogTitle>
            <DialogDescription>
              {primary ? t("devices.group.invitePrimary") : t("devices.group.inviteSecondary", { name: group.primaryName })}
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

const ROLE_BADGE = {
  primary: { labelKey: "devices.role.primary", cls: "border-brand/25 bg-brand-soft text-brand-strong" },
  secondary: { labelKey: "devices.role.secondary", cls: "border-border bg-secondary text-muted-foreground" },
  standIn: { labelKey: "devices.role.standIn", cls: "border-brand/25 bg-brand-soft text-brand-strong" },
} as const;

function RoleBadge({ role }: { role: keyof typeof ROLE_BADGE }) {
  const { t } = useTranslation("settings");
  const { labelKey, cls } = ROLE_BADGE[role];
  return <span className={cn("inline-flex h-5 shrink-0 items-center rounded-[5px] border px-1.5 text-[11px] font-medium whitespace-nowrap", cls)}>{t(labelKey)}</span>;
}

function StatusCard({ group }: { group: DeviceGroup }) {
  const { t } = useTranslation("settings");
  const self = group.devices.find((d) => d.self);
  const primaryDevice = group.devices.find((d) => d.role === "primary");
  const secondary = group.role === "secondary";
  const standing = secondary && group.standIn.state === "active";
  const count = group.devices.length;
  const name = group.primaryName ?? t("devices.thePrimary");
  const title = !secondary
    ? t("devices.status.primary", { computer: here("start") })
    : group.primaryOnline
      ? t("devices.status.synced", { name })
      : standing
        ? t("devices.status.standing", { name })
        : t("devices.status.away", { name });

  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border bg-card shadow-card">
      <div className="flex items-start gap-4 p-5">
        <div className="grid size-10 shrink-0 place-items-center rounded-lg border bg-paper-2 [&_svg]:size-[18px]">
          {self ? <DeviceIcon device={self} /> : <Network />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[17px] leading-snug font-medium tracking-[-0.02em]">{title}</h3>
            <RoleBadge role={standing ? "standIn" : secondary ? "secondary" : "primary"} />
          </div>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            {standing
              ? t("devices.status.bodyStanding", { name, computer: here("inline") })
              : secondary
                ? t("devices.status.bodySecondary", { name, computer: here("start") })
                : count === 1
                  ? t("devices.status.bodyPrimarySolo")
                  : group.standInEnabled
                    ? t("devices.status.bodyPrimaryAllStandIn", { count })
                    : t("devices.status.bodyPrimaryAll", { count })}
          </p>
        </div>
        {secondary && primaryDevice && group.primaryOnline && (
          <RunnerStateBadge
            className="mt-1 hidden @lg:inline-flex"
            runner={{ state: "online", latencyMs: null, lastSeenAt: primaryDevice.lastSeenAt }}
          />
        )}
      </div>
    </motion.section>
  );
}

/** The live side of standing in, on a secondary while its primary is away. */
function StandInNow({ group, now }: { group: DeviceGroup; now: number }) {
  const { t } = useTranslation("settings");
  const name = group.primaryName ?? t("devices.thePrimaryStart");
  const { state, since, takesOverAt } = group.standIn;
  const error = group.primaryError && <p className="mb-1 break-words">{group.primaryError}</p>;
  if (state === "active") {
    const n = group.pendingChanges;
    return (
      <Callout icon={<LaptopMinimalCheck className="text-brand-strong" />} title={t("devices.standInNow.activeTitle", { computer: here("start"), name })} className="border-brand/20 bg-brand-soft/50">
        <p>
          {since ? t("devices.standInNow.activeSince", { time: clockTime(since) }) : t("devices.standInNow.active")}{" "}
          {n > 0 ? t("devices.standInNow.pending", { count: n, name }) : t("devices.standInNow.pendingNone", { name })}
        </p>
      </Callout>
    );
  }
  if (state === "waiting" && takesOverAt) {
    const left = new Date(takesOverAt).getTime() - now;
    return (
      <Callout icon={<Timer className="text-foreground" />} title={t("devices.status.away", { name })}>
        {error}
        <p className="tabular-nums">
          {left > 0 ? t("devices.standInNow.takesOverIn", { computer: here("start"), time: countdown(left) }) : t("devices.standInNow.takesOverSoon", { computer: here("start") })}
        </p>
      </Callout>
    );
  }
  const other = group.devices.find((d) => !d.self && d.standingIn);
  return (
    <Callout tone="muted" title={t("devices.status.away", { name })}>
      {error}
      <p>
        {other
          ? t("devices.standInNow.otherStandsIn", { name: other.name })
          : t("devices.standInNow.waitsHere")}
      </p>
    </Callout>
  );
}

/** One PATCH /api/devices, shown at once and rolled back when it fails. */
function useGroupPatch() {
  const { t } = useTranslation("common");
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DeviceGroupPatch) => api.devices.update(input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: qk.devices });
      const prev = qc.getQueryData<DeviceGroup>(qk.devices);
      if (prev) qc.setQueryData<DeviceGroup>(qk.devices, { ...prev, ...input });
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.devices, ctx.prev);
      toastApiError(e, t("errors.couldNotSave"), qc);
    },
    onSuccess: (next) => {
      qc.setQueryData(qk.devices, next);
      toast.success(t("status.saved"), { id: "settings-saved", duration: 1200 });
    },
  });
}

const STAND_IN_MINUTES = [1, 2, 3, 5, 10, 15];

function StandInGroup({ group, now }: { group: DeviceGroup; now: number }) {
  const { t } = useTranslation("settings");
  const patch = useGroupPatch();
  const primary = group.role === "primary";
  const subject = primary ? here("inline") : (group.primaryName ?? t("devices.thePrimary"));
  const m = group.standInMinutes;
  const minutes = STAND_IN_MINUTES.includes(m) ? STAND_IN_MINUTES : [...STAND_IN_MINUTES, m].sort((a, b) => a - b);

  return (
    <SettingsGroup title={t("devices.standIn.title")} icon={<MonitorPause />} description={t("devices.standIn.description")}>
      {group.role === "secondary" && !group.primaryOnline && (
        <div className="py-4">
          <StandInNow group={group} now={now} />
        </div>
      )}
      <SettingRow
        label={t("devices.standIn.label")}
        htmlFor="devices-stand-in"
        disabled={!primary}
        description={
          group.standInEnabled
            ? primary
              ? t("devices.standIn.on", { subject, minutes: m })
              : t("devices.standIn.onElsewhere", { subject, minutes: m, name: group.primaryName })
            : primary
              ? t("devices.standIn.off", { subject })
              : t("devices.standIn.offElsewhere", { subject, name: group.primaryName })
        }
      >
        <div className="flex items-center gap-2">
          {group.standInEnabled && (
            <Select value={String(m)} disabled={!primary} onValueChange={(v) => patch.mutate({ standInMinutes: Number(v) })}>
              <SelectTrigger aria-label={t("devices.after")} className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                {minutes.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {t("devices.afterMinutes", { minutes: n })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Switch id="devices-stand-in" checked={group.standInEnabled} disabled={!primary} onCheckedChange={(on) => patch.mutate({ standInEnabled: on })} />
        </div>
      </SettingRow>
    </SettingsGroup>
  );
}

const SIGN_INS = {
  own: { labelKey: "devices.signIns.ownLabel", lineKey: "devices.signIns.ownLine" },
  seed: { labelKey: "devices.signIns.seedLabel", lineKey: "devices.signIns.seedLine" },
} as const satisfies Record<BrowserSignIns, { labelKey: string; lineKey: string }>;

function BrowserSignInsGroup({ group }: { group: DeviceGroup }) {
  const { t } = useTranslation(["settings", "common"]);
  const patch = useGroupPatch();
  const primary = group.role === "primary";
  const value = group.browserSignIns;
  return (
    <SettingsGroup title={t("devices.signIns.title")} icon={<KeyRound />} description={t("devices.signIns.description")}>
      <SettingRow
        label={t("devices.signIns.label")}
        htmlFor="devices-sign-ins"
        disabled={!primary}
        description={
          value === "own"
            ? primary
              ? t("devices.signIns.own")
              : t("devices.signIns.ownElsewhere", { name: group.primaryName })
            : primary
              ? t("devices.signIns.seedSelf", { computer: here("dat") })
              : t("devices.signIns.seedElsewhere", { name: group.primaryName })
        }
      >
        <Select value={value} disabled={!primary} onValueChange={(v) => patch.mutate({ browserSignIns: v as BrowserSignIns })}>
          <SelectTrigger id="devices-sign-ins" className="w-60">
            <SelectValue>{t(SIGN_INS[value].labelKey)}</SelectValue>
          </SelectTrigger>
          <SelectContent position="popper" align="end" className="w-80">
            {(Object.keys(SIGN_INS) as BrowserSignIns[]).map((v) => (
              <SelectItem key={v} value={v} className="py-2">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 font-medium">
                    {t(SIGN_INS[v].labelKey)}
                    {v === "own" && <span className="text-[11px] font-normal text-brand-strong">{t("memory.backend.recommended")}</span>}
                  </span>
                  <span className="text-xs text-muted-foreground">{t(SIGN_INS[v].lineKey)}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
    </SettingsGroup>
  );
}

function HandoffCard({ group }: { group: DeviceGroup }) {
  const { t } = useTranslation("settings");
  const { working, targets } = useHandoff();
  const secondary = group.role === "secondary";
  const to = secondary ? group.primaryName : targets.length === 1 ? targets[0].name : t("devices.handoff.another");
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
            <h3 className="text-[15px] leading-snug font-medium tracking-[-0.01em]">{t("devices.handoff.title")}</h3>
            <p className="mt-0.5 max-w-md text-xs leading-relaxed text-muted-foreground">{t("devices.handoff.body", { to })}</p>
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
              <span className={cn("size-1.5 rounded-full", working > 0 ? "animate-pulse bg-brand" : "bg-muted-foreground/40")} aria-hidden />
              {working === 0 ? t("devices.handoff.idle", { computer: here("dat") }) : t("devices.handoff.working", { count: working, computer: here("dat") })}
            </p>
          </div>
        </div>
        <HandoffButton label={t("devices.handoff.label")} className="max-w-full shrink-0 self-start @xl:max-w-80 @xl:self-center" variant={working > 0 ? "default" : "outline"} />
      </div>
    </motion.section>
  );
}

/** A note under a computer of the list: what is wrong or odd there, and the one thing to do about it. */
function DeviceNote({ tone, icon, title, action, children }: { tone?: "warning"; icon: ReactNode; title: string; action: ReactNode; children: ReactNode }) {
  return (
    <div className={cn("flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border px-3 py-2.5", tone === "warning" ? "border-warning/30 bg-warning/[0.07]" : "bg-paper-2")}>
      <span className={cn("mt-0.5 shrink-0 [&_svg]:size-4", tone === "warning" ? "text-warning" : "text-muted-foreground")}>{icon}</span>
      <div className="min-w-0 flex-1 basis-52">
        <p className="text-[13px] font-medium">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{children}</p>
      </div>
      <div className="shrink-0 self-center">{action}</div>
    </div>
  );
}

function FullDiskAccessNote({ device }: { device: GroupDevice }) {
  const { t } = useTranslation(["settings", "common"]);
  const showGuide = useMacPermissionsGuide((s) => s.show);
  const [open, setOpen] = useState(false);
  return (
    <>
      <DeviceNote
        tone="warning"
        icon={<TriangleAlert />}
        title={t("devices.fda.title")}
        action={
          <Button size="xs" variant="outline" onClick={() => (device.self ? showGuide("full-disk-access") : setOpen(true))}>
            {t("devices.fda.fix")}
          </Button>
        }
      >
        {device.self
          ? t("devices.fda.self")
          : t("devices.fda.other", { name: device.name })}
      </DeviceNote>
      {!device.self && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="sm:max-w-[460px]">
            <DialogHeader>
              <DialogTitle className="text-lg font-medium tracking-[-0.02em]">{t("devices.fda.dialogTitle", { name: device.name })}</DialogTitle>
              <DialogDescription>{t("devices.fda.dialogDescription", { name: device.name })}</DialogDescription>
            </DialogHeader>
            <ol className="space-y-3.5 py-1">
              <Step n={1} title={t("devices.fda.step1")}>
                {t("devices.fda.step1Body")}
              </Step>
              <Step n={2} title={t("devices.fda.step2")}>
                {t("devices.fda.step2Body")}
              </Step>
              <Step n={3} title={t("devices.fda.step3")}>
                {t("devices.fda.step3Body")}
              </Step>
            </ol>
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>{t("common:actions.done")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function RunnerTwinNote({ device, runnerId }: { device: GroupDevice; runnerId: string }) {
  const { t } = useTranslation(["settings", "common"]);
  const qc = useQueryClient();
  const { data: runners } = useRunners();
  const [confirm, setConfirm] = useState(false);
  const runner = runners?.find((r) => r.id === runnerId);
  const name = device.self ? here("start") : device.name;
  const there = device.self ? here("dat") : device.name;
  const retire = useMutation({
    mutationFn: () => api.devices.retireRunner(runnerId),
    onSuccess: (result) => {
      const chats = result.moved === 0 ? t("devices.twin.noChats") : t("devices.twin.moved", { count: result.moved });
      toast.success(t("devices.twin.toast", { name }), {
        description: result.uninstalled ? t("devices.twin.uninstalled", { chats }) : t("devices.twin.stillStarts", { chats, there, command: "godmode runner uninstall" }),
      });
      void qc.invalidateQueries({ queryKey: qk.devices });
      void qc.invalidateQueries({ queryKey: qk.runners });
      void qc.invalidateQueries({ queryKey: qk.conversationsAll });
    },
    onError: (e) => toastApiError(e, t("devices.twin.error", { there }), qc),
  });
  const n = runner?.conversations ?? 0;
  return (
    <>
      <DeviceNote
        icon={<Cable />}
        title={t("devices.twin.title")}
        action={
          <Button size="xs" variant="outline" disabled={retire.isPending} onClick={() => setConfirm(true)}>
            {retire.isPending && <Spinner className="size-3" />}
            {t("devices.twin.useApp")}
          </Button>
        }
      >
        {t("devices.twin.body", { name })}
      </DeviceNote>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("devices.twin.confirmTitle", { there })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("devices.twin.confirmBody", { there, moves: n > 0 ? t("devices.twin.moves", { count: n }) : t("devices.twin.movesNone") })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => retire.mutate()}>{t("devices.twin.useApp")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function DeviceRow({ device, group, now, removable }: { device: GroupDevice; group: DeviceGroup; now: number; removable: boolean }) {
  const { t } = useTranslation(["settings", "common"]);
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.devices.remove(device.id!),
    onSuccess: (next) => {
      qc.setQueryData(qk.devices, next);
      void qc.invalidateQueries({ queryKey: qk.runners });
      toast.success(t("devices.row.left", { name: device.name }));
    },
    onError: (e) => toastApiError(e, t("devices.row.removeError", { name: device.name }), qc),
  });
  const state = deviceState(device, group);
  const fda = needsFullDiskAccess(device);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="overflow-hidden"
    >
      <div className="py-3.5">
        <div className="flex items-center gap-3">
          <div className={cn("grid size-9 shrink-0 place-items-center rounded-lg border bg-paper-2 [&_svg]:size-4", state === "offline" && "text-muted-foreground")}>
            <DeviceIcon device={device} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <p className="truncate text-sm font-medium">{device.name}</p>
              {device.self && (
                <span className="inline-flex h-5 shrink-0 items-center rounded-[5px] border px-1.5 text-[11px] font-medium whitespace-nowrap text-foreground/80">{here("start")}</span>
              )}
              <RoleBadge role={device.role} />
            </div>
            <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <DeviceDot device={device} group={group} />
              <span className={cn("truncate tabular-nums", state === "update_required" && "text-warning")}>
                <span className={cn(isStandingIn(device, group) && "font-medium text-brand-strong")}>{deviceStateLine(device, group, now)}</span>
                {[state === "update_required" && device.version ? `v${device.version}` : null, deviceWorkLine(device)].filter(Boolean).map((part) => ` · ${part}`).join("")}
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
                  aria-label={t("devices.row.removeLabel", { name: device.name })}
                  disabled={remove.isPending}
                  onClick={() => setConfirm(true)}
                >
                  {remove.isPending ? <Spinner /> : <Unlink />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("devices.row.removeTooltip")}</TooltipContent>
            </Tooltip>
          )}
        </div>
        {(fda || device.runnerTwin) && (
          <div className="mt-3 space-y-2 @md:pl-12">
            {fda && <FullDiskAccessNote device={device} />}
            {device.runnerTwin && <RunnerTwinNote device={device} runnerId={device.runnerTwin} />}
          </div>
        )}
      </div>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("devices.row.confirmTitle", { name: device.name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {device.activeRuns > 0 ? t("devices.row.confirmBodyWorking", { count: device.activeRuns }) : t("devices.row.confirmBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => remove.mutate()}>
              {t("common:actions.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Runners from before device groups                                    */
/* ------------------------------------------------------------------ */

/** Classic runners still paired here. A computer of the group that also runs one has its own note in the list above. */
function OlderRunners({ group }: { group: DeviceGroup }) {
  const { t } = useTranslation("settings");
  const { data: runners = [] } = useRunners();
  const twins = new Set(group.devices.map((d) => d.runnerTwin).filter(Boolean));
  const older = runners.filter((r) => r.kind === "runner" && !twins.has(r.id));
  if (!older.length) return null;

  return (
    <SettingsGroup
      title={t("devices.older.title")}
      icon={<MonitorSmartphone />}
      description={t("devices.older.description")}
    >
      <AnimatePresence initial={false}>
        {older.map((r) => (
          <OlderRunnerRow key={r.id} runner={r} />
        ))}
      </AnimatePresence>
    </SettingsGroup>
  );
}

function OlderRunnerRow({ runner }: { runner: RemoteRunner }) {
  const { t } = useTranslation(["settings", "common"]);
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.runners.remove(runner.id),
    onSuccess: () => {
      qc.setQueryData<RemoteRunner[]>(qk.runners, (old) => old?.filter((r) => r.id !== runner.id));
      void qc.invalidateQueries({ queryKey: qk.conversationsAll });
      toast.success(t("devices.older.removed", { name: runner.name }), { description: runner.conversations > 0 ? t("devices.older.removedDescription", { computer: here("dat") }) : undefined });
    },
    onError: (e) => toastApiError(e, t("devices.row.removeError", { name: runner.name }), qc),
  });
  const chats = runner.conversations;
  const working = runner.activeRuns;

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
        <div className={cn("grid size-9 shrink-0 place-items-center rounded-lg border bg-paper-2 [&_svg]:size-4", runner.state !== "online" && "text-muted-foreground")}>
          <MonitorSmartphone />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{runner.name}</p>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <RunnerStateDot state={runner.state} />
            <span className="truncate tabular-nums">
              {RUNNER_STATE_LABEL[runner.state]} · {runnerWorkLine(runner)}
            </span>
          </p>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-destructive"
              aria-label={t("devices.older.removeLabel", { name: runner.name })}
              disabled={remove.isPending}
              onClick={() => setConfirm(true)}
            >
              {remove.isPending ? <Spinner /> : <Trash2 />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("common:actions.remove")}</TooltipContent>
        </Tooltip>
      </div>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("devices.older.confirmTitle", { name: runner.name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {[
                t("devices.older.forget", { computer: here("acc") }),
                chats > 0 ? t("devices.older.chats", { count: chats, computer: here("dat") }) : null,
                working > 0 ? t("devices.older.working", { count: working }) : null,
                t("devices.older.installed", { host: runner.hostname || t("devices.older.otherComputer") }),
              ]
                .filter(Boolean)
                .join(" ")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => remove.mutate()}>
              {t("common:actions.remove")}
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
  const { t } = useTranslation("settings");
  const patch = useGroupPatch();

  const value = group.defaultRunOn ?? HERE;
  const secondary = group.role === "secondary";
  const primaryDevice = group.devices.find((d) => d.role === "primary");
  const options: { value: string; label: string; hint?: string; device?: GroupDevice }[] = [{ value: HERE, label: here("start") }];
  if (secondary && primaryDevice) options.push({ value: "primary", label: group.primaryName ?? primaryDevice.name, hint: t("devices.runOn.primaryHint"), device: primaryDevice });
  for (const d of group.devices) {
    if (d.self || d.role !== "secondary" || !d.id) continue;
    if (d.state === "online" || d.id === value) options.push({ value: d.id, label: d.name, device: d });
  }
  const gone = !options.some((o) => o.value === value);

  return (
    <SettingsGroup title={t("devices.runOn.title")} icon={<MessagesSquare />} description={t("devices.runOn.description")}>
      <SettingRow
        label={t("devices.runOn.label")}
        htmlFor="devices-run-on"
        description={options.length === 1 ? t("devices.runOn.single") : t("devices.runOn.multi")}
      >
        <Select value={value} onValueChange={(v) => patch.mutate({ defaultRunOn: v === HERE ? null : v })}>
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
                <span className="text-muted-foreground">{t("devices.runOn.gone")}</span>
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow
        label={t("devices.runOn.failover")}
        htmlFor="devices-failover"
        description={
          group.failover
            ? t("devices.runOn.failoverOn", { target: group.role === "primary" ? here("inline") : group.primaryName })
            : t("devices.runOn.failoverOff")
        }
      >
        <div className="flex items-center gap-2">
          {group.failover && (
            <Select value={String(group.failoverMinutes)} onValueChange={(v) => patch.mutate({ failoverMinutes: Number(v) })}>
              <SelectTrigger aria-label={t("devices.after")} className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                {[1, 3, 5, 10, 15, 30].map((m) => (
                  <SelectItem key={m} value={String(m)}>
                    {t("devices.afterMinutes", { minutes: m })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Switch id="devices-failover" checked={group.failover} onCheckedChange={(on) => patch.mutate({ failover: on })} />
        </div>
      </SettingRow>
    </SettingsGroup>
  );
}

function LeaveGroup({ group }: { group: DeviceGroup }) {
  const { t } = useTranslation(["settings", "common"]);
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const primary = group.role === "primary";
  const leave = useMutation({
    mutationFn: api.devices.leave,
    onSuccess: (next) => {
      qc.setQueryData(qk.devices, next);
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "devices" });
      toast.success(primary ? t("devices.leave.dissolved") : t("devices.leave.left", { computer: here("start"), name: group.primaryName }));
    },
    onError: (e) => toastApiError(e, primary ? t("devices.leave.dissolveError") : t("devices.leave.leaveError"), qc),
  });

  return (
    <SettingsGroup tone="danger" title={primary ? t("devices.leave.titleDissolve") : t("devices.leave.titleLeave")} icon={<LogOut />}>
      <SettingRow
        label={primary ? t("devices.leave.labelPrimary") : t("devices.leave.labelSelf", { computer: here("start") })}
        description={primary ? t("devices.leave.descPrimary") : t("devices.leave.descSecondary", { name: group.primaryName })}
      >
        <Button variant="outline" className="text-destructive hover:text-destructive" disabled={leave.isPending} onClick={() => setConfirm(true)}>
          {leave.isPending && <Spinner />}
          {primary ? t("devices.leave.buttonDissolve") : t("devices.leave.buttonLeave")}
        </Button>
      </SettingRow>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{primary ? t("devices.leave.confirmTitleDissolve") : t("devices.leave.confirmTitleLeave", { name: group.primaryName })}</AlertDialogTitle>
            <AlertDialogDescription>
              {primary
                ? t("devices.leave.confirmDissolve", { count: group.devices.length - 1 })
                : t("devices.leave.confirmLeave", { computer: here("start"), name: group.primaryName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => leave.mutate()}>
              {primary ? t("devices.leave.dissolve") : t("devices.leave.leave")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsGroup>
  );
}
