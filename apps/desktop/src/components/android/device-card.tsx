import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, Hand, Pencil, Smartphone, Trash2, WifiOff } from "lucide-react";
import { androidSummary, type AndroidDevice } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { AndroidStateBadge, BatteryPill, screenAspect } from "./android-parts";
import { UsedBy } from "./used-by";
import { timeAgo } from "@/components/ssh/ssh-parts";

/** A still of the phone's screen, refreshed every few seconds while it is connected. */
function Thumbnail({ device }: { device: AndroidDevice }) {
  const connected = device.state === "connected";
  const shot = useQuery({
    queryKey: qk.androidScreen(device.id, 360),
    queryFn: () => api.android.screenshot(device.id, 360),
    enabled: connected,
    refetchInterval: connected ? 4000 : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const data = connected ? shot.data : undefined;
  return (
    <div className="relative h-full" style={{ aspectRatio: screenAspect(device, data) }}>
      <div className="absolute inset-0 rounded-[18px] bg-[#141414] p-[3%] shadow-card ring-1 ring-black/10 dark:ring-white/10">
        <div className="relative size-full overflow-hidden rounded-[13px] bg-black">
          {data ? (
            <img src={`data:${data.mime};base64,${data.data}`} alt="" draggable={false} className="absolute inset-0 size-full object-contain select-none" />
          ) : connected && shot.isLoading ? (
            <Skeleton className="absolute inset-0 rounded-none bg-white/5" />
          ) : (
            <span className="absolute inset-0 grid place-items-center text-white/35">
              <Smartphone className="size-5" />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function DeviceCard({ device, onEdit, onForget }: { device: AndroidDevice; onEdit: () => void; onForget: () => void }) {
  const { t } = useTranslation("android");
  const qc = useQueryClient();
  const connected = device.state === "connected";
  const disconnect = useMutation({
    mutationFn: () => api.android.disconnect(device.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.android }),
    onError: (e) => toastApiError(e, t("deviceCard.disconnectFailed"), qc),
  });

  return (
    <article aria-label={device.name} className={cn("flex min-w-0 flex-col rounded-xl border bg-card shadow-card transition hover:border-foreground/15", device.busy && "glow-border")}>
      {connected && (
      <Link
        to={`/android/${device.id}`}
        aria-label={t("deviceCard.open", { name: device.name })}
        className="group/preview relative flex h-56 items-center justify-center overflow-hidden rounded-t-xl border-b bg-paper-2 py-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <Thumbnail device={device} />
        {connected && (
          <span className="absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition group-hover/preview:bg-black/20 group-hover/preview:opacity-100 group-focus-visible/preview:opacity-100">
            <span className="glass inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-foreground">
              <Hand className="size-3.5" /> {t("deviceCard.takeControl")}
            </span>
          </span>
        )}
      </Link>
      )}

      <div className="flex items-start gap-3 p-4">
        {!connected && (
          <Link
            to={`/android/${device.id}`}
            aria-label={t("deviceCard.open", { name: device.name })}
            className="grid size-10 shrink-0 place-items-center rounded-lg border bg-paper-2 text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <Smartphone className="size-5" />
          </Link>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="min-w-0 truncate text-[15px] leading-snug font-medium tracking-[-0.01em]">{device.name}</h3>
            <AndroidStateBadge device={device} />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
            <span className="truncate">{androidSummary(device)}</span>
            <BatteryPill battery={connected ? device.battery : null} />
            {!connected && device.lastSeenAt && <span>{t("deviceCard.lastSeen", { time: timeAgo(device.lastSeenAt) })}</span>}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="-mr-1.5 text-muted-foreground" aria-label={t("deviceCard.more", { name: device.name })}>
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil /> {t("deviceCard.rename")}
            </DropdownMenuItem>
            {connected && device.connection === "wifi" && (
              <DropdownMenuItem onSelect={() => disconnect.mutate()}>
                <WifiOff /> {t("deviceCard.disconnectWifi")}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={device.state !== "disconnected"} onSelect={onForget}>
              <Trash2 /> {t("deviceCard.forget")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {device.description && <p className="-mt-2 line-clamp-2 px-4 pb-4 text-[13px] leading-relaxed text-muted-foreground">{device.description}</p>}

      <div className="mt-auto border-t px-4 py-3">
        <UsedBy device={device} />
      </div>
    </article>
  );
}
