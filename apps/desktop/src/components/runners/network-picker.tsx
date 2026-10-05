import { useId } from "react";
import { Box, ExternalLink, RefreshCw, Wifi } from "lucide-react";
import type { RunnerNetwork, RunnerOfferRoute, TailscaleStatus } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { TAILSCALE_DOWNLOAD } from "@/components/settings/pair-phone-dialog";
import { openExternal } from "@/lib/desktop";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "godmode-runner-network";

const TITLE: Record<RunnerNetwork, string> = { lan: "Same network", vm: "Virtual machine", tailscale: "Tailscale" };

/** The network the human picked last time; the next offer starts there. */
export function preferredNetwork(): RunnerNetwork | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "lan" || v === "vm" || v === "tailscale" ? v : null;
  } catch {
    return null;
  }
}

function rememberNetwork(network: RunnerNetwork) {
  try {
    localStorage.setItem(STORAGE_KEY, network);
  } catch {
    /* private mode */
  }
}

/** The route to show: the one picked, else one on the network picked last time, else the best. */
export function pickRoute(routes: RunnerOfferRoute[], address: string | null): RunnerOfferRoute | null {
  const network = preferredNetwork();
  return routes.find((r) => r.address === address) ?? routes.find((r) => r.network === network) ?? routes[0] ?? null;
}

/** A Tailscale address (100.64.0.0/10) or MagicDNS name. */
export function isTailscaleHost(host: string | null | undefined): boolean {
  if (!host) return false;
  if (/\.ts\.net\.?$/i.test(host)) return true;
  const [a, b] = host.split(".").map(Number);
  return a === 100 && b! >= 64 && b! <= 127;
}

/** Tailscale's mark: nine dots, the bottom-right ones faded. */
export function TailscaleMark({ className }: { className?: string }) {
  const dots = [
    [0, 0, 0.35],
    [1, 0, 0.35],
    [2, 0, 0.35],
    [0, 1, 1],
    [1, 1, 1],
    [2, 1, 1],
    [0, 2, 0.35],
    [1, 2, 1],
    [2, 2, 0.35],
  ] as const;
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      {dots.map(([x, y, o]) => (
        <circle key={`${x}${y}`} cx={4 + x * 8} cy={4 + y * 8} r={2.6} opacity={o} />
      ))}
    </svg>
  );
}

function NetworkIcon({ network, className }: { network: RunnerNetwork; className?: string }) {
  if (network === "tailscale") return <TailscaleMark className={className} />;
  const Icon = network === "vm" ? Box : Wifi;
  return <Icon className={className} />;
}

function hint(route: RunnerOfferRoute): string {
  if (route.network === "tailscale") return route.detail ?? "From anywhere, through your tailnet";
  if (route.network === "vm") return `A Mac running in a VM on this one${route.detail ? ` · ${route.detail}` : ""}`;
  return `Wi-Fi or Ethernet${route.detail ? ` · ${route.detail}` : ""}`;
}

/**
 * How the other Mac reaches this one: each of this computer's addresses, Tailscale with its MagicDNS name. When
 * Tailscale isn't connected here, it says why and how to get it.
 */
export function NetworkPicker({
  routes,
  tailscale,
  value,
  onChange,
  onRefresh,
  refreshing,
}: {
  routes: RunnerOfferRoute[];
  tailscale: TailscaleStatus;
  value: RunnerOfferRoute | null;
  onChange: (route: RunnerOfferRoute) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const hasTailscale = routes.some((r) => r.network === "tailscale");
  return (
    <div className="space-y-2">
      {routes.length > 0 && (
        <RadioGroup
          value={value?.address ?? ""}
          onValueChange={(address) => {
            const route = routes.find((r) => r.address === address);
            if (!route) return;
            rememberNetwork(route.network);
            onChange(route);
          }}
          aria-label="Network"
          className="gap-1.5"
        >
          {routes.map((route) => (
            <RouteOption key={route.address} route={route} checked={value?.address === route.address} />
          ))}
        </RadioGroup>
      )}

      {!hasTailscale && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-3 py-2.5">
          <OptionTile network="tailscale" muted />
          <div className="min-w-0 flex-1 basis-56">
            <p className="text-sm font-medium text-foreground">Tailscale</p>
            <p className="text-xs text-muted-foreground">{tailscale.running ? "Tailscale has no address on this Mac yet." : tailscale.detail}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!tailscale.installed && (
              <Button variant="outline" size="xs" className="text-foreground" onClick={() => void openExternal(TAILSCALE_DOWNLOAD)}>
                <ExternalLink /> Get Tailscale
              </Button>
            )}
            <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={onRefresh} disabled={refreshing}>
              <RefreshCw className={cn(refreshing && "animate-spin")} /> Check again
            </Button>
          </div>
        </div>
      )}

      {value?.network === "tailscale" && (
        <p className="pt-0.5 text-xs leading-relaxed text-muted-foreground">
          The other Mac needs Tailscale too, signed in to the same account
          {tailscale.tailnet ? (
            <>
              {" "}
              (<span className="text-foreground">{tailscale.tailnet}</span>)
            </>
          ) : null}
          . Then it reaches this Mac from anywhere, not only at home.
        </p>
      )}
    </div>
  );
}

function OptionTile({ network, muted, checked }: { network: RunnerNetwork; muted?: boolean; checked?: boolean }) {
  return (
    <span
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-md bg-secondary ring-1 ring-border ring-inset transition-colors",
        muted ? "text-muted-foreground/60" : "text-foreground",
        checked && "bg-card",
      )}
    >
      <NetworkIcon network={network} className="size-4" />
    </span>
  );
}

function RouteOption({ route, checked }: { route: RunnerOfferRoute; checked: boolean }) {
  const id = useId();
  return (
    <Label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-lg border bg-card px-3 py-2.5 font-normal transition hover:border-foreground/15",
        checked && "border-foreground/35 bg-paper-2 ring-1 ring-foreground/10 hover:border-foreground/35",
      )}
    >
      <OptionTile network={route.network} checked={checked} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{TITLE[route.network]}</span>
        <span className="block truncate text-xs text-muted-foreground">{hint(route)}</span>
      </span>
      <span className="shrink-0 font-mono text-[11px] text-foreground/80 tabular-nums">{route.address}</span>
      <RadioGroupItem id={id} value={route.address} />
    </Label>
  );
}
