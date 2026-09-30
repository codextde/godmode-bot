import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { AnimatePresence, motion } from "motion/react";
import { CircleCheck, CircleX, Radar, RotateCw, ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";
import type { BotCheckReport, BotCheckStatus, BrowserSettings } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { SettingRow } from "./settings-kit";

const STATUS: Record<BotCheckStatus, { icon: typeof CircleCheck; text: string; bar: string; label: string }> = {
  pass: { icon: CircleCheck, text: "text-success", bar: "bg-success", label: "Passed" },
  warn: { icon: TriangleAlert, text: "text-warning", bar: "bg-warning", label: "Minor difference" },
  fail: { icon: CircleX, text: "text-destructive", bar: "bg-destructive", label: "Gives it away" },
};

function verdict(report: BotCheckReport) {
  const fails = report.checks.filter((c) => c.status === "fail").length;
  const warns = report.checks.filter((c) => c.status === "warn").length;
  const passed = report.checks.length - fails - warns;
  if (fails) return { tone: "fail" as const, title: fails === 1 ? "1 signal gives the browser away" : `${fails} signals give the browser away`, passed };
  if (warns) return { tone: "pass" as const, title: "Passes common bot checks", passed };
  return { tone: "pass" as const, title: "Looks like a regular Chrome", passed };
}

/** Bot check of the global default profile's browser, shown inline in Settings → Browser. */
export function BotCheck({ browser }: { browser: BrowserSettings }) {
  const qc = useQueryClient();
  const { data: profiles } = useQuery({ queryKey: qk.browserProfiles, queryFn: api.browser.profiles });
  const profile = profiles?.find((p) => p.isDefault && !p.workspaceId) ?? null;
  const key = [...qk.botCheck, profile?.id ?? ""];
  const report = useQuery<BotCheckReport | null>({ queryKey: key, queryFn: () => null, enabled: false, initialData: null, staleTime: Infinity });

  const run = useMutation({
    mutationFn: async (restart: boolean) => {
      if (!profile) throw new Error("The default browser profile isn't ready yet.");
      if (restart) {
        await api.browser.stop(profile.id);
        await api.browser.launch(profile.id, profile.headless ?? undefined);
      }
      return api.browser.botCheck(profile.id);
    },
    onSuccess: (r) => {
      qc.setQueryData([...qk.botCheck, r.profileId], r);
      void qc.invalidateQueries({ queryKey: qk.browserProfiles });
    },
    onError: (e) => toastApiError(e, "Bot check failed", qc),
  });

  const r = report.data;
  const restartNeeded = !!profile?.running && profile.stealth !== null && profile.stealth !== browser.stealth;
  const stale = !!r && !restartNeeded && r.stealth !== browser.stealth;
  const disabled = !browser.enabled || !profile;

  if (!r && !run.isPending) {
    return (
      <SettingRow
        label="Bot check"
        disabled={!browser.enabled}
        description="Opens a test page in the default profile's browser and shows what bot detection sees there — the same checks sites run before a CAPTCHA."
      >
        <Button variant="outline" size="sm" onClick={() => run.mutate(false)} disabled={disabled}>
          <Radar /> Run check
        </Button>
      </SettingRow>
    );
  }

  const v = r ? verdict(r) : null;
  return (
    <div className="py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div
            className={cn(
              "grid size-10 shrink-0 place-items-center rounded-full border [&_svg]:size-[18px]",
              !v && "bg-paper-2 text-muted-foreground",
              v?.tone === "pass" && "border-success/25 bg-success/[0.08] text-success",
              v?.tone === "fail" && "border-destructive/25 bg-destructive/[0.07] text-destructive",
            )}
          >
            {!v ? <Spinner /> : v.tone === "pass" ? <ShieldCheck /> : <ShieldAlert />}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium tracking-[-0.01em]">{v ? v.title : "Checking how sites see the browser…"}</div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {r ? (
                <>
                  {r.browser.replace("/", " ")} · {r.headless ? "Headless" : "Visible window"} · Stealth {r.stealth ? "on" : "off"} · {format(new Date(r.checkedAt), "HH:mm")}
                </>
              ) : (
                "Opening a test page in the default profile's browser"
              )}
            </div>
          </div>
        </div>
        {r && (
          <div className="flex items-center gap-3">
            <Meter report={r} />
            <Button variant="ghost" size="sm" onClick={() => run.mutate(false)} disabled={run.isPending || disabled}>
              {run.isPending ? <Spinner /> : <RotateCw />} Check again
            </Button>
          </div>
        )}
      </div>

      <AnimatePresence initial={false}>
        {(restartNeeded || stale) && !run.isPending && (
          <motion.div
            key={restartNeeded ? "restart" : "stale"}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div
              className={cn(
                "mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-3.5 py-2.5 text-xs",
                restartNeeded ? "border-warning/25 bg-warning/[0.06]" : "bg-paper-2/60 py-3",
              )}
            >
              <span className="min-w-0 flex-1 text-foreground/85">
                {restartNeeded
                  ? `The browser is still running with stealth ${profile?.stealth ? "on" : "off"}. Restart it to apply the new setting — agents using it lose their open tabs.`
                  : `Stealth is ${browser.stealth ? "on" : "off"} now — check again to see what changes.`}
              </span>
              {restartNeeded && (
                <Button size="xs" variant="outline" onClick={() => run.mutate(true)} disabled={disabled}>
                  <RotateCw /> Restart & check
                </Button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <ul className="mt-4 overflow-hidden rounded-lg border">
        {r && !run.isPending
          ? r.checks.map((c, i) => {
              const s = STATUS[c.status];
              return (
                <motion.li
                  key={c.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.025 }}
                  className="grid grid-cols-[auto_1fr] items-start gap-x-3 border-b px-3.5 py-2.5 last:border-b-0 @lg:grid-cols-[auto_9rem_1fr]"
                >
                  <s.icon role="img" className={cn("mt-px size-4", s.text)} aria-label={s.label} />
                  <span className="text-[13px] font-medium">{c.label}</span>
                  <span className="col-start-2 text-xs leading-relaxed break-words text-muted-foreground @lg:col-start-3 @lg:pt-px">{c.detail}</span>
                </motion.li>
              );
            })
          : Array.from({ length: 10 }).map((_, i) => (
              <li key={i} className="flex items-center gap-3 border-b px-3.5 py-3 last:border-b-0">
                <Skeleton className="size-4 rounded-full" />
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-3 flex-1" style={{ maxWidth: `${40 + ((i * 37) % 45)}%` }} />
              </li>
            ))}
      </ul>
    </div>
  );
}

function Meter({ report }: { report: BotCheckReport }) {
  const v = verdict(report);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          tabIndex={0}
          role="img"
          className="flex items-center gap-2 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-label={`${v.passed} of ${report.checks.length} checks passed`}
        >
          <div className="flex gap-[3px]">
            {report.checks.map((c) => (
              <span key={c.id} className={cn("h-3.5 w-1.5 rounded-full", STATUS[c.status].bar, c.status === "pass" && "opacity-80")} />
            ))}
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {v.passed}/{report.checks.length}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {v.passed} of {report.checks.length} checks passed
      </TooltipContent>
    </Tooltip>
  );
}
