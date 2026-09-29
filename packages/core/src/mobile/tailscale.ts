import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import type { TailscaleStatus } from "@godmode/shared";

const CLI_PATHS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"],
  linux: ["/usr/bin/tailscale", "/usr/sbin/tailscale", "/usr/local/bin/tailscale"],
  win32: ["C:\\Program Files\\Tailscale\\tailscale.exe"],
};

const CACHE_MS = 10_000;
const STATUS_TIMEOUT_MS = 4000;

let cached: { at: number; status: TailscaleStatus } | null = null;
let override: TailscaleStatus | null = null;

/** Tests: pretend Tailscale is in this state (null = probe the real one). */
export function setTailscaleOverride(status: TailscaleStatus | null) {
  override = status;
  cached = null;
}

function findCli(): string | null {
  const onPath = Bun.which("tailscale");
  if (onPath) return onPath;
  return (CLI_PATHS[process.platform] ?? []).find((p) => existsSync(p)) ?? null;
}

/** 100.64.0.0/10: the carrier-grade NAT range Tailscale hands out. */
export function isTailscaleIp(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
}

/**
 * The Tailscale interface: a 100.64.0.0/10 address next to one in Tailscale's fd7a:115c:a1e0::/48 (other VPNs and
 * carrier NAT use 100.64.0.0/10 too).
 */
function interfaceIp(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    const v4 = addrs?.find((a) => a.family === "IPv4" && !a.internal && isTailscaleIp(a.address));
    if (v4 && addrs?.some((a) => a.family === "IPv6" && a.address.toLowerCase().startsWith("fd7a:115c:a1e0:"))) return v4.address;
  }
  return null;
}

interface CliStatus {
  BackendState?: string;
  TailscaleIPs?: string[];
  Self?: { DNSName?: string; TailscaleIPs?: string[]; UserID?: number };
  CurrentTailnet?: { Name?: string } | null;
  User?: Record<string, { LoginName?: string }> | null;
}

/** `tailscale status --json` → what Godmode needs. */
export function parseTailscaleStatus(json: CliStatus): TailscaleStatus {
  const state = json.BackendState ?? "";
  const ips = json.Self?.TailscaleIPs ?? json.TailscaleIPs ?? [];
  const ip = ips.find((a) => isTailscaleIp(a)) ?? null;
  const dnsName = json.Self?.DNSName?.replace(/\.$/, "") || null;
  const user = json.Self?.UserID !== undefined ? json.User?.[String(json.Self.UserID)]?.LoginName : undefined;
  const tailnet = json.CurrentTailnet?.Name || user || null;
  const running = state === "Running" && !!ip;
  let detail: string | null = null;
  if (!running) {
    detail =
      state === "NeedsLogin" || state === "NeedsMachineAuth"
        ? "Sign in to Tailscale on this computer."
        : state === "Stopped"
          ? "Tailscale is turned off. Turn it on in the Tailscale app."
          : "Tailscale isn't connected yet.";
  }
  return { installed: true, running, ip: running ? ip : null, dnsName: running ? dnsName : null, tailnet, detail };
}

async function probe(): Promise<TailscaleStatus> {
  const cli = findCli();
  if (cli) {
    try {
      const proc = Bun.spawn([cli, "status", "--json"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
      const timer = setTimeout(() => proc.kill(), STATUS_TIMEOUT_MS);
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      clearTimeout(timer);
      if (text.trim().startsWith("{")) return parseTailscaleStatus(JSON.parse(text) as CliStatus);
    } catch {
      /* fall back to the network interfaces */
    }
  }
  const ip = interfaceIp();
  if (ip) return { installed: true, running: true, ip, dnsName: null, tailnet: null, detail: null };
  return cli
    ? { installed: true, running: false, ip: null, dnsName: null, tailnet: null, detail: "Tailscale isn't running. Open the Tailscale app and sign in." }
    : {
        installed: false,
        running: false,
        ip: null,
        dnsName: null,
        tailnet: null,
        detail: "Install Tailscale on this computer and on your phone, and sign in with the same account.",
      };
}

export async function tailscaleStatus(refresh = false): Promise<TailscaleStatus> {
  if (override) return override;
  if (!refresh && cached && Date.now() - cached.at < CACHE_MS) return cached.status;
  const status = await probe();
  cached = { at: Date.now(), status };
  return status;
}
