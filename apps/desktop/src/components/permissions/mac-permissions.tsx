import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, ChevronDown, FolderOpen, HardDrive, MonitorPlay, MousePointerClick, RotateCcw, RotateCw, Settings2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { create } from "zustand";
import type { PermissionId, PermissionReport, PermissionStatus } from "@godmode/shared";
import { DrawCheck, LiveDot } from "@/components/aicss/Motion";
import { Logo } from "@/components/brand";
import { ConfirmDialog } from "@/components/integrations/confirm-dialog";
import { usePermissions, toastFix } from "@/components/settings/system-permissions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, errorMessage } from "@/lib/api";
import { isTauri } from "@/lib/core";
import { restartApp } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useLive } from "@/stores/live";
import { t } from "@/i18n";

type PrivacyId = Extract<PermissionId, "accessibility" | "screen-recording" | "full-disk-access">;
type Privacy = PermissionStatus & { id: PrivacyId; privacy: NonNullable<PermissionStatus["privacy"]> };

const ORDER: PrivacyId[] = ["accessibility", "screen-recording", "full-disk-access"];

const COPY = {
  accessibility: {
    name: "Device control",
    labelKey: "copy.accessibility.label",
    titleKey: "copy.accessibility.title",
    purposeKey: "copy.accessibility.purpose",
    icon: MousePointerClick,
  },
  "screen-recording": {
    name: "Screen Recording",
    labelKey: "copy.screenRecording.label",
    titleKey: "copy.screenRecording.title",
    purposeKey: "copy.screenRecording.purpose",
    icon: MonitorPlay,
  },
  "full-disk-access": {
    name: "Full Disk Access",
    labelKey: "copy.fullDiskAccess.label",
    titleKey: "copy.fullDiskAccess.title",
    purposeKey: "copy.fullDiskAccess.purpose",
    icon: HardDrive,
  },
} as const satisfies Record<PrivacyId, { name: string; labelKey: string; titleKey: string; purposeKey: string; icon: typeof MousePointerClick }>;

function steps(p: Privacy): string[] {
  const app = p.privacy.appName;
  if (p.id === "full-disk-access")
    return [
      t("permissions:steps.fullDisk1"),
      t("permissions:steps.fullDisk2", { app }),
      t("permissions:steps.fullDisk3", { app }),
    ];
  return [
    t("permissions:steps.allow1"),
    t("permissions:steps.allow2", { app, pane: p.privacy.pane }),
    p.id === "screen-recording" ? t("permissions:steps.screenRecording3") : t("permissions:steps.allow3"),
  ];
}

export const privacyOf = (report: PermissionReport | undefined): Privacy[] =>
  ORDER.map((id) => report?.permissions.find((p) => p.id === id)).filter((p): p is Privacy => !!p?.privacy);

/** Not allowed although the feature that needs it is on, or allowed but waiting for a restart. */
export const privacyAttention = (list: Privacy[]) => list.filter((p) => (!p.ok && p.privacy.inUse) || p.privacy.restartNeeded);

export const useMacPermissionsGuide = create<{ open: boolean; focus: PrivacyId | null; show: (focus?: PermissionId) => void; close: () => void }>((set) => ({
  open: false,
  focus: null,
  show: (focus) => set({ open: true, focus: focus && (ORDER as string[]).includes(focus) ? (focus as PrivacyId) : null }),
  close: () => set({ open: false }),
}));

export const isPrivacyPermission = (id: PermissionId): id is PrivacyId => (ORDER as string[]).includes(id);

/** The step-by-step guide for macOS privacy permissions; mounted once, opened from anywhere with `useMacPermissionsGuide`. */
export function MacPermissionsGuide() {
  const { t } = useTranslation("permissions");
  const { open, focus, close } = useMacPermissionsGuide();
  const { data } = usePermissions(open);
  const list = useMemo(() => privacyOf(data), [data]);
  const [current, setCurrent] = useState<PrivacyId | null>(null);
  const [advanceTo, setAdvanceTo] = useState<PrivacyId | null>(null);

  // Opened (again, maybe for another permission): start where asked, else at the first one missing.
  const firstMissing = list.find((p) => !p.ok)?.id ?? list[0]?.id ?? null;
  const ready = !!data;
  useEffect(() => {
    if (open && ready) setCurrent(focus ?? firstMissing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, focus, ready]);

  const active = list.find((p) => p.id === current) ?? null;
  const done = list.filter((p) => p.ok).length;

  // Granted while looking at it: celebrate briefly, then go on to the next one still missing.
  const wasOk = useRef<Record<string, boolean>>({});
  useEffect(() => {
    if (!open) return void (wasOk.current = {});
    for (const p of list) {
      const before = wasOk.current[p.id];
      wasOk.current[p.id] = p.ok;
      if (before === false && p.ok && p.id === current && !p.privacy.restartNeeded) {
        const next = list.find((q) => !q.ok && q.id !== p.id);
        if (next) setAdvanceTo(next.id);
      }
    }
  }, [open, list, current]);
  useEffect(() => {
    if (!advanceTo) return;
    const timer = setTimeout(() => {
      setCurrent(advanceTo);
      setAdvanceTo(null);
    }, 1_200);
    return () => clearTimeout(timer);
  }, [advanceTo]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[860px]">
        <div className="grid min-h-[520px] grid-cols-1 md:grid-cols-[272px_1fr]">
          <aside className="flex flex-col border-b bg-paper-2 p-4 md:border-r md:border-b-0">
            <div className="flex items-center gap-2.5">
              <span className="grid size-8 place-items-center rounded-lg border bg-card text-foreground/80">
                <ShieldCheck className="size-4" />
              </span>
              <div className="leading-tight">
                <DialogTitle className="text-sm font-medium">{t("title")}</DialogTitle>
                <DialogDescription className="text-[11.5px]">
                  {list.length ? t("guide.allowedCount", { done, total: list.length }) : t("guide.checking")}
                </DialogDescription>
              </div>
            </div>
            <div className="mt-3 h-1 overflow-hidden rounded-full bg-border">
              <motion.div className="h-full rounded-full bg-success" initial={false} animate={{ width: list.length ? `${(done / list.length) * 100}%` : "0%" }} transition={{ duration: 0.4, ease: "easeOut" }} />
            </div>
            <nav className="mt-4 space-y-1">
              {list.map((p, i) => (
                <StepButton
                  key={p.id}
                  index={i}
                  permission={p}
                  active={p.id === current}
                  onClick={() => {
                    setAdvanceTo(null);
                    setCurrent(p.id);
                  }}
                />
              ))}
            </nav>
            <p className="mt-auto flex items-center gap-2 pt-4 text-[11px] text-muted-foreground">
              <LiveDot className="size-1.5" /> {t("guide.checksAgain")}
            </p>
          </aside>
          <section className="relative flex min-w-0 flex-col p-6">
            <AnimatePresence mode="wait" initial={false}>
              {active ? (
                <motion.div
                  key={active.id}
                  className="flex flex-1 flex-col"
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -12 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                >
                  <StepPane
                    permission={active}
                    index={list.indexOf(active)}
                    total={list.length}
                    onNavigate={(id) => {
                      setAdvanceTo(null);
                      setCurrent(id);
                    }}
                    list={list}
                    onClose={close}
                  />
                </motion.div>
              ) : (
                <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
                  {data ? t("guide.nothingToSetUp") : <Spinner />}
                </div>
              )}
            </AnimatePresence>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StatusPill({ permission }: { permission: Privacy }) {
  const { t } = useTranslation("permissions");
  const { ok, privacy } = permission;
  const [text, tone] = privacy.restartNeeded
    ? [t("pill.restart"), "warn"]
    : ok
      ? [t("pill.allowed"), "ok"]
      : privacy.inUse
        ? [t("pill.needed"), "warn"]
        : [t("pill.off"), "muted"];
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-px text-[10px] font-medium",
        tone === "ok" && "bg-success/12 text-success",
        tone === "warn" && "bg-warning/15 text-warning",
        tone === "muted" && "bg-muted text-muted-foreground",
      )}
    >
      {text}
    </span>
  );
}

function StepButton({ permission, index, active, onClick }: { permission: Privacy; index: number; active: boolean; onClick: () => void }) {
  const { t } = useTranslation("permissions");
  const copy = COPY[permission.id];
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors hover:bg-card/70 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
        active && "border-border bg-card shadow-card",
      )}
    >
      <span
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-full border text-[11px] font-medium tabular-nums",
          permission.ok ? "border-success/40 bg-success/10 text-success" : "bg-card text-muted-foreground",
        )}
      >
        {permission.ok ? <DrawCheck className="size-3.5" /> : index + 1}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium">{t(copy.labelKey)}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{permission.privacy.pane === copy.name ? t("mock.privacy") : permission.privacy.pane}</span>
      </span>
      <StatusPill permission={permission} />
    </button>
  );
}

function StepPane({
  permission: p,
  index,
  total,
  list,
  onNavigate,
  onClose,
}: {
  permission: Privacy;
  index: number;
  total: number;
  list: Privacy[];
  onNavigate: (id: PrivacyId) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["permissions", "common"]);
  const qc = useQueryClient();
  const copy = COPY[p.id];
  const Icon = copy.icon;
  const [waiting, setWaiting] = useState(false);
  const [help, setHelp] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: qk.permissions });

  const allow = useMutation({
    mutationFn: async () => {
      if (p.id === "full-disk-access") return api.doctor.openPrivacySettings(p.id, true).then((r) => ({ outcome: r.ok ? "pending" : "failed", output: r.output }) as const);
      return api.doctor.fixPermission(p.id);
    },
    onSuccess: (r) => {
      if (r.outcome === "failed") toast.error(t("toast.settingsDidntOpen"), { description: r.output });
      else setWaiting(true);
      refresh();
      void qc.invalidateQueries({ queryKey: qk.computer });
    },
    onError: (e) => toast.error(t("toast.askError", { name: p.name }), { description: errorMessage(e) }),
  });
  const openPane = useMutation({
    mutationFn: (reveal: boolean) => api.doctor.openPrivacySettings(p.id, reveal),
    onSuccess: (r) => (r.ok ? setWaiting(true) : toast.error(t("toast.settingsDidntOpen"), { description: r.output })),
    onError: (e) => toast.error(t("toast.settingsDidntOpen"), { description: errorMessage(e) }),
  });
  const reset = useMutation({
    mutationFn: () => api.doctor.resetPrivacy(p.id),
    onSuccess: (r) => {
      toastFix(r);
      setWaiting(true);
      refresh();
    },
    onError: (e) => toast.error(t("toast.resetError", { name: p.name }), { description: errorMessage(e) }),
  });

  const prev = list[index - 1];
  const next = list[index + 1];
  const stepList = steps(p);
  const busy = allow.isPending || openPane.isPending || reset.isPending;

  return (
    <>
      <div className="flex items-start gap-3 pr-8">
        <span className={cn("grid size-10 shrink-0 place-items-center rounded-xl border", p.ok ? "border-success/30 bg-success/10 text-success" : "bg-paper-2 text-foreground/80")}>
          <Icon className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-medium tracking-[0.12em] text-muted-foreground uppercase">
            {t("pane.step", { step: index + 1, total, pane: p.privacy.pane })}
          </p>
          <h2 className="mt-0.5 text-[17px] font-medium tracking-[-0.01em]">{t(copy.titleKey)}</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{t(copy.purposeKey)}</p>
        </div>
      </div>

      <SettingsMock permission={p} className="mt-5" />

      {p.ok ? (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className={cn(
            "mt-5 flex items-start gap-3 rounded-lg border p-3.5 text-[13px]",
            p.privacy.restartNeeded ? "border-warning/30 bg-warning/[0.07]" : "border-success/25 bg-success/[0.06]",
          )}
        >
          {p.privacy.restartNeeded ? <RotateCw className="mt-0.5 size-4 shrink-0 text-warning" /> : <DrawCheck className="mt-0.5 size-4 shrink-0 text-success" />}
          <div className="min-w-0 flex-1">
            <p className="font-medium">{p.privacy.restartNeeded ? t("pane.restartToGo") : t("pane.isAllowed", { label: t(copy.labelKey) })}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{p.detail}</p>
          </div>
          {p.privacy.restartNeeded && <RestartButton />}
        </motion.div>
      ) : (
        <>
          <ol className="mt-5 space-y-2.5">
            {stepList.map((text, i) => (
              <li key={i} className="flex gap-3 text-[13px] leading-relaxed">
                <span className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-secondary text-[10.5px] font-medium text-foreground/80 tabular-nums">{i + 1}</span>
                <span>{text}</span>
              </li>
            ))}
          </ol>
          {!p.privacy.canReset && (
            <p className="mt-3 rounded-md bg-paper-2 px-3 py-2 text-xs text-muted-foreground">
              {t("pane.runsFrom", { app: p.privacy.appName })}
            </p>
          )}
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button onClick={() => allow.mutate()} disabled={busy}>
              {allow.isPending ? <Spinner /> : p.id === "full-disk-access" ? <Settings2 /> : <ShieldCheck />}
              {p.id === "full-disk-access" ? t("pane.openSettings") : t("pane.allow")}
            </Button>
            {p.privacy.addManually && p.privacy.appPath ? (
              <Button variant="outline" onClick={() => openPane.mutate(true)} disabled={busy}>
                <FolderOpen /> {t("pane.showInFinder", { app: p.privacy.appName })}
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => openPane.mutate(false)} disabled={busy}>
                <Settings2 /> {t("pane.openPane")}
              </Button>
            )}
            <AnimatePresence>
              {waiting && (
                <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="ml-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <Spinner className="size-3" /> {t("pane.waiting")}
                </motion.span>
              )}
            </AnimatePresence>
          </div>
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setHelp((h) => !h)}
              className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              aria-expanded={help}
            >
              <ChevronDown className={cn("size-3.5 transition-transform", help && "rotate-180")} /> {t("pane.helpToggle")}
            </button>
            <AnimatePresence initial={false}>
              {help && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                  <div className="mt-2 space-y-2 rounded-lg border bg-paper-2 p-3 text-xs leading-relaxed text-muted-foreground">
                    <p>
                      {p.privacy.canReset ? t("pane.helpReset") : t("pane.helpManual", { app: p.privacy.appName })}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {p.privacy.canReset && (
                        <Button size="xs" variant="outline" onClick={() => reset.mutate()} disabled={busy}>
                          {reset.isPending ? <Spinner className="size-3" /> : <RotateCcw />} {t("pane.resetAndAsk")}
                        </Button>
                      )}
                      {isTauri && <RestartButton size="xs" variant="ghost" />}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </>
      )}

      <div className="mt-auto flex items-center justify-between pt-6">
        <Button variant="ghost" size="sm" onClick={() => prev && onNavigate(prev.id)} disabled={!prev}>
          <ArrowLeft /> {t("common:actions.back")}
        </Button>
        {next ? (
          <Button variant={p.ok ? "default" : "outline"} size="sm" onClick={() => onNavigate(next.id)}>
            {p.ok ? t("common:actions.next") : t("pane.skipForNow")} <ArrowRight />
          </Button>
        ) : (
          <Button variant={list.every((q) => q.ok) ? "default" : "outline"} size="sm" onClick={onClose}>
            {t("common:actions.done")}
          </Button>
        )}
      </div>
    </>
  );
}

function RestartButton({ size = "sm", variant = "default" }: { size?: "sm" | "xs"; variant?: "default" | "ghost" }) {
  const { t } = useTranslation("permissions");
  const running = useLive((s) => Object.keys(s.runs).length);
  const [confirming, setConfirming] = useState(false);
  const [restarting, setRestarting] = useState(false);
  if (!isTauri) return null;
  const restart = async () => {
    setRestarting(true);
    try {
      await restartApp();
    } catch (e) {
      setRestarting(false);
      toast.error(t("restart.error"), { description: errorMessage(e) });
    }
  };
  return (
    <>
      <Button size={size} variant={variant} onClick={() => (running > 0 ? setConfirming(true) : void restart())} disabled={restarting}>
        {restarting ? <Spinner className="size-3" /> : <RotateCw />} {t("restart.button")}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        destructive={false}
        title={t("restart.confirmTitle")}
        description={t("restart.confirmDescription", { count: running })}
        confirmLabel={t("restart.confirm")}
        onConfirm={() => void restart()}
      />
    </>
  );
}

/** A small System Settings window: where the switch is, and that it is Godmode's. */
const MOCK_ITEMS = [
  { id: "wifi", labelKey: "mock.wifi" },
  { id: "bluetooth", labelKey: "mock.bluetooth" },
  { id: "notifications", labelKey: "mock.notifications" },
  { id: "privacy", labelKey: "mock.privacy" },
  { id: "desktop", labelKey: "mock.desktop" },
] as const;

function SettingsMock({ permission: p, className }: { permission: Privacy; className?: string }) {
  const { t } = useTranslation("permissions");
  const on = p.ok;
  return (
    <div className={cn("overflow-hidden rounded-xl border bg-card shadow-card select-none", className)} aria-hidden>
      <div className="flex h-7 items-center gap-1.5 border-b bg-paper-2 px-3">
        <span className="size-2.5 rounded-full bg-[#ff5f57]" />
        <span className="size-2.5 rounded-full bg-[#febc2e]" />
        <span className="size-2.5 rounded-full bg-[#28c840]" />
        <span className="ml-3 text-[10.5px] text-muted-foreground">{t("mock.systemSettings")}</span>
      </div>
      <div className="flex">
        <div className="hidden w-36 shrink-0 space-y-1 border-r bg-paper-2/60 p-2 sm:block">
          {MOCK_ITEMS.map((item) => (
            <div
              key={item.id}
              className={cn("flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[10.5px] text-muted-foreground", item.id === "privacy" && "bg-[#0a84ff] text-white")}
            >
              <span className={cn("size-3 rounded-[4px]", item.id === "privacy" ? "bg-white/30" : "bg-border")} />
              {t(item.labelKey)}
            </div>
          ))}
        </div>
        <div className="min-w-0 flex-1 p-3">
          <p className="text-[10px] text-muted-foreground">‹ {t("mock.privacy")}</p>
          <p className="mt-0.5 text-[12.5px] font-medium">{p.privacy.pane}</p>
          <div className="mt-2 divide-y rounded-lg border">
            <MockRow name="Finder" on dim />
            <MockRow name={p.privacy.appName} on={on} highlight={!on} own />
            <MockRow name="Terminal" on={false} dim />
          </div>
          {p.privacy.addManually && (
            <div className="mt-1.5 flex items-center gap-1">
              <span className={cn("relative grid size-5 place-items-center rounded border bg-paper-2 text-[12px] leading-none", !on && "border-[#0a84ff] text-[#0a84ff]")}>
                +
                {!on && <span className="absolute inset-0 animate-ping rounded border border-[#0a84ff]/60" />}
              </span>
              <span className="grid size-5 place-items-center rounded border bg-paper-2 text-[12px] leading-none text-muted-foreground">−</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MockRow({ name, on, dim, highlight, own }: { name: string; on: boolean; dim?: boolean; highlight?: boolean; own?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2 px-2.5 py-1.5", dim && "opacity-45", highlight && "bg-[#0a84ff]/[0.06]")}>
      {own ? <Logo className="size-4 rounded-[4px]" /> : <span className="size-4 rounded-[4px] bg-border" />}
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{name}</span>
      <span className={cn("relative h-[15px] w-[26px] shrink-0 rounded-full transition-colors duration-300", on ? "bg-[#34c759]" : "bg-border")}>
        <motion.span className="absolute top-[1.5px] size-3 rounded-full bg-white shadow-sm" initial={false} animate={{ left: on ? 12.5 : 1.5 }} transition={{ type: "spring", stiffness: 500, damping: 32 }} />
        {highlight && <span className="absolute -inset-1 animate-pulse rounded-full ring-2 ring-[#0a84ff]/50" />}
      </span>
    </div>
  );
}

/** Sidebar notice while a permission an enabled feature needs is missing (macOS only). */
export function MacPermissionsButton() {
  const { t } = useTranslation("permissions");
  const { data } = usePermissions(false, 60_000);
  const show = useMacPermissionsGuide((s) => s.show);
  const attention = privacyAttention(privacyOf(data));
  const first = attention[0];
  return (
    <AnimatePresence initial={false}>
      {first && (
        <motion.div key="mac-permissions" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} transition={{ duration: 0.2, ease: "easeOut" }}>
          <button
            type="button"
            onClick={() => show(first.id)}
            className="flex w-full items-center gap-2.5 rounded-lg border bg-card py-1.5 pr-2 pl-1.5 text-left shadow-card transition-colors hover:bg-paper-2 group-data-[collapsible=icon]:hidden"
          >
            <span className="relative grid size-7 shrink-0 place-items-center rounded-md border bg-paper-2 text-foreground/80">
              <ShieldCheck className="size-3.5" />
              <LiveDot className="absolute -top-0.5 -right-0.5 size-1.5" />
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block text-[12.5px] font-medium">{t("title")}</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {first.privacy.restartNeeded && attention.length === 1 ? t("button.restartToFinish") : t("button.toAllowList", { count: attention.length, list: attention.map((p) => t(COPY[p.id].labelKey)).join(", ") })}
              </span>
            </span>
            <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
          <div className="hidden flex-col items-center rounded-lg border bg-card p-1 shadow-card group-data-[collapsible=icon]:flex">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="relative size-8" onClick={() => show(first.id)} aria-label={t("button.setUpLabel")}>
                  <ShieldCheck />
                  <LiveDot className="absolute top-1 right-1" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{t("button.tooltip", { count: attention.length })}</TooltipContent>
            </Tooltip>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** A compact overview with a button into the guide (onboarding, Settings → Computer). */
export function MacPermissionsSummary({ className }: { className?: string }) {
  const { t } = useTranslation("permissions");
  const { data } = usePermissions();
  const show = useMacPermissionsGuide((s) => s.show);
  const list = privacyOf(data);
  if (!list.length) return null;
  const missing = list.filter((p) => !p.ok || p.privacy.restartNeeded);
  return (
    <div className={cn("rounded-lg border bg-card p-3.5", className)}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("title")}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{missing.length ? t("summary.partial", { done: list.length - missing.length, total: list.length }) : t("summary.all")}</p>
        </div>
        <Button size="sm" variant={missing.length ? "default" : "outline"} onClick={() => show(missing[0]?.id)}>
          {missing.length ? t("summary.setUp") : t("summary.review")} <ArrowRight />
        </Button>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {list.map((p) => {
          const Icon = COPY[p.id].icon;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => show(p.id)}
              className="flex items-center gap-2 rounded-md border bg-paper-2 px-2.5 py-2 text-left transition-colors hover:bg-card"
            >
              <Icon className={cn("size-4 shrink-0", p.ok ? "text-success" : "text-muted-foreground")} />
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{t(COPY[p.id].labelKey)}</span>
              <StatusPill permission={p} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
