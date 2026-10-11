import { BatteryCharging, BatteryFull, BatteryLow, BatteryMedium, Cable, MonitorSmartphone, Wifi } from "lucide-react";
import type { AndroidConnection, AndroidDevice } from "@godmode/shared";
import { LiveDot } from "@/components/aicss/Motion";
import { cn } from "@/lib/utils";

export const CONNECTION_LABEL: Record<AndroidConnection, string> = { usb: "USB", wifi: "Wi-Fi", emulator: "Emulator" };

export function ConnectionIcon({ connection, className }: { connection: AndroidConnection | null; className?: string }) {
  const Icon = connection === "wifi" ? Wifi : connection === "emulator" ? MonitorSmartphone : Cable;
  return <Icon className={className} aria-hidden />;
}

/** "Connected", "Allow USB debugging", "Offline", "Not connected". */
export function stateLabel(device: Pick<AndroidDevice, "state" | "busy">): string {
  if (device.state === "connected") return device.busy ? "Agent working" : "Connected";
  if (device.state === "unauthorized") return "Allow USB debugging";
  if (device.state === "offline") return "Offline";
  return "Not connected";
}

export function AndroidStateBadge({ device, className }: { device: Pick<AndroidDevice, "state" | "busy" | "connection">; className?: string }) {
  const connected = device.state === "connected";
  const waiting = device.state === "unauthorized" || device.state === "offline";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[5px] border px-1.5 py-0.5 text-[11px] leading-none font-medium whitespace-nowrap",
        connected ? "border-brand/25 bg-brand-soft text-brand-strong" : waiting ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "bg-paper-2 text-muted-foreground",
        className,
      )}
    >
      {connected ? <LiveDot live={device.busy} className="size-1.5 bg-brand" /> : <span aria-hidden className={cn("size-1.5 rounded-full", waiting ? "bg-amber-500" : "bg-muted-foreground/40")} />}
      {stateLabel(device)}
      {connected && device.connection && <span className="font-normal opacity-70">· {CONNECTION_LABEL[device.connection]}</span>}
    </span>
  );
}

export function BatteryPill({ battery, className }: { battery: AndroidDevice["battery"]; className?: string }) {
  if (!battery) return null;
  const Icon = battery.charging ? BatteryCharging : battery.level <= 20 ? BatteryLow : battery.level <= 60 ? BatteryMedium : BatteryFull;
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11.5px] text-muted-foreground tabular-nums", battery.level <= 15 && !battery.charging && "text-destructive", className)}>
      <Icon className="size-3.5" aria-hidden />
      {battery.level}%
    </span>
  );
}

/** Small dot for pickers: green when the phone can be used now. */
export function AndroidDot({ device, className }: { device: Pick<AndroidDevice, "state">; className?: string }) {
  if (device.state === "connected") return <LiveDot live={false} className={cn("size-1.5 bg-brand", className)} />;
  return <span aria-hidden className={cn("inline-block size-1.5 rounded-full", device.state === "disconnected" ? "bg-muted-foreground/40" : "bg-amber-500", className)} />;
}

/** The phone's shape for a placeholder before the first picture: its screen size, else a typical phone. */
export function screenAspect(device: Pick<AndroidDevice, "width" | "height">, frame?: { width: number; height: number } | null): number {
  if (frame?.width && frame.height) return frame.width / frame.height;
  if (device.width && device.height) return device.width / device.height;
  return 9 / 19.5;
}
