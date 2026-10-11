import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUpRight, Hand, Maximize2, PanelRightClose, PanelRightOpen, Smartphone } from "lucide-react";
import { androidSummary, type AndroidDevice } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LiveDot, WorkingTicks } from "@/components/aicss/Motion";
import { isTauri } from "@/lib/core";
import { isMac } from "@/lib/desktop";
import { useAndroidDevices, useSettings } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { AndroidDot, BatteryPill } from "./android-parts";
import { PhoneScreen } from "./phone-screen";

/** The phones a chat controls: its own and its agent's (none while phones are turned off). */
export function useChatPhones(own: string[] | undefined, agentIds: string[] | undefined): AndroidDevice[] {
  const { data: settings } = useSettings();
  const enabled = settings?.android.enabled !== false;
  const ids = useMemo(() => [...new Set([...(own ?? []), ...(agentIds ?? [])])], [own, agentIds]);
  const { data: devices } = useAndroidDevices();
  return useMemo(() => (enabled && ids.length ? ids.flatMap((id) => devices?.find((d) => d.id === id) ?? []) : []), [enabled, ids, devices]);
}

/** Side panel of a chat that controls phones: the phone live, what the agent is doing, and a way to take over. */
export function PhonePanel({ phones, activity, onHide }: { phones: AndroidDevice[]; activity: string | null; onHide: () => void }) {
  const [picked, setPicked] = useState<string | null>(null);
  const phone = phones.find((p) => p.id === picked) ?? phones.find((p) => p.busy) ?? phones.find((p) => p.state === "connected") ?? phones[0]!;
  const [control, setControl] = useState(false);
  const [live, setLive] = useState(false);
  const onLive = useCallback((v: boolean) => setLive(v), []);
  const connected = phone.state === "connected";

  return (
    <motion.aside
      aria-label="Android phone"
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 320, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 36 }}
      className="h-full shrink-0 overflow-hidden border-l bg-paper-2"
    >
      <div className="flex h-full w-80 flex-col">
        <div className={cn("flex h-14 shrink-0 items-center gap-2 border-b px-4", isTauri && isMac && "h-auto pt-7 pb-2")}>
          <span className="text-sm font-medium">Phone</span>
          {connected && (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-[5px] border px-1.5 py-0.5 text-[11px] font-medium",
                live ? "border-brand/25 bg-brand-soft text-brand-strong" : "bg-card text-muted-foreground",
              )}
            >
              <LiveDot live={live} />
              {live ? "Live" : "Waiting"}
            </span>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="-mr-1.5 ml-auto size-8 text-muted-foreground" onClick={onHide} aria-label="Hide the phone">
                <PanelRightClose />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Hide the phone</TooltipContent>
          </Tooltip>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {phones.length > 1 && (
            <div role="tablist" aria-label="Phones" className="flex gap-1 rounded-lg border bg-card p-0.5">
              {phones.map((p) => (
                <button
                  key={p.id}
                  role="tab"
                  type="button"
                  aria-selected={p.id === phone.id}
                  onClick={() => setPicked(p.id)}
                  className={cn(
                    "flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs transition outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    p.id === phone.id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <AndroidDot device={p} />
                  <span className="truncate">{p.name}</span>
                </button>
              ))}
            </div>
          )}

          <div className={cn("rounded-[22px]", activity && phone.busy && "glow-border")}>
            <PhoneScreen key={phone.id} device={phone} interactive={control} onLive={onLive} className="w-full max-w-[17rem]" />
          </div>

          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid size-6 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground">
              <Smartphone className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] leading-5 font-medium">{phone.name}</p>
              <p className="truncate text-[11px] leading-4 text-muted-foreground">{androidSummary(phone)}</p>
            </div>
            <BatteryPill battery={connected ? phone.battery : null} />
          </div>

          <AnimatePresence initial={false}>
            {activity && (
              <motion.div key="activity" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                <div className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2 shadow-card">
                  <WorkingTicks count={8} className="shrink-0 text-brand" />
                  <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{activity}</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex gap-2">
            <Button size="sm" variant={control ? "secondary" : "default"} className="flex-1" disabled={!connected} onClick={() => setControl((c) => !c)} aria-pressed={control}>
              <Hand /> {control ? "Stop controlling" : "Take control"}
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild variant="outline" size="icon-sm" aria-label="Open full size">
                  <Link to={`/android/${phone.id}`}>
                    <Maximize2 />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open full size</TooltipContent>
            </Tooltip>
          </div>
          {control && <p className="-mt-2 text-[11px] leading-4 text-muted-foreground">Click to tap, drag to swipe, type to enter text. Right click goes back.</p>}
        </div>

        <Link
          to="/android"
          className="group flex shrink-0 items-center gap-3 border-t px-4 py-3 transition hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground shadow-card">
            <Smartphone className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">Android phones</span>
            <span className="block truncate text-[11px] text-muted-foreground">{phones.length === 1 ? "1 phone in this chat" : `${phones.length} phones in this chat`}</span>
          </span>
          <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
        </Link>
      </div>
    </motion.aside>
  );
}

/** Header button that brings the phone panel back once it's hidden. */
export function PhoneToggle({ working, onClick }: { working: boolean; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Show the phone" onClick={onClick} className="relative text-muted-foreground">
          <PanelRightOpen />
          {working && <LiveDot className="absolute top-1.5 right-1.5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>Show the phone</TooltipContent>
    </Tooltip>
  );
}
