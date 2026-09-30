import { format, formatDistanceToNowStrict } from "date-fns";
import { TriangleAlert } from "lucide-react";
import type { SshServer } from "@godmode/shared";
import { LiveDot } from "@/components/aicss/Motion";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type SshStatus = "connected" | "failing" | "untested";

export function sshStatus(server: Pick<SshServer, "lastConnectedAt" | "lastError">): SshStatus {
  if (server.lastError) return "failing";
  return server.lastConnectedAt ? "connected" : "untested";
}

/** "deploy@web-1.example.com", with the port only when it isn't 22 (IPv6 hosts in brackets then). */
export function sshAddress(server: Pick<SshServer, "host" | "port" | "username">): string {
  if (server.port === 22) return `${server.username}@${server.host}`;
  const host = server.host.includes(":") ? `[${server.host}]` : server.host;
  return `${server.username}@${host}:${server.port}`;
}

/** "ssh-ed25519" → "ED25519", "ecdsa-sha2-nistp256" → "ECDSA", "ssh-rsa" → "RSA". */
export function keyTypeLabel(type: string): string {
  const sk = /^sk-/i.test(type) ? "-SK" : "";
  if (/ed25519/i.test(type)) return `ED25519${sk}`;
  if (/ecdsa/i.test(type)) return `ECDSA${sk}`;
  if (/rsa/i.test(type)) return "RSA";
  if (/dss|dsa/i.test(type)) return "DSA";
  return type.replace(/^ssh-/i, "").toUpperCase();
}

export function shortFingerprint(fingerprint: string, length = 18): string {
  return fingerprint.length > length ? `${fingerprint.slice(0, length)}…` : fingerprint;
}

/** "just now", "5 min ago", "3 h ago", then "4 days ago". */
export function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return formatDistanceToNowStrict(new Date(iso), { addSuffix: true });
}

/** `user@host:port`, `ssh -p 2222 user@host` or `host:port` pasted into the host field. */
export function parseSshTarget(text: string): { host: string; username?: string; port?: number } | null {
  const m = text.trim().match(/^(?:ssh\s+)?(?:-p\s*(\d{1,5})\s+)?(?:([^@\s]+)@)?(\[[^\]]+\]|[^\s:@/]+)(?::(\d{1,5}))?$/);
  if (!m) return null;
  const [, flagPort, username, rawHost, suffixPort] = m;
  if (!username && !flagPort && !suffixPort) return null;
  const port = Number(flagPort ?? suffixPort);
  return { host: rawHost.replace(/^\[|\]$/g, ""), username, port: Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined };
}

/** Small dot for lists: green after a successful sign-in, red while failing, muted until the first test. */
export function SshStatusDot({ server, className }: { server: Pick<SshServer, "lastConnectedAt" | "lastError">; className?: string }) {
  const status = sshStatus(server);
  if (status === "connected") return <LiveDot live={false} className={cn("size-1.5 bg-brand", className)} />;
  return (
    <span
      aria-hidden
      className={cn("inline-block size-1.5 shrink-0 rounded-full", status === "failing" ? "bg-destructive" : "bg-muted-foreground/45", className)}
    />
  );
}

export const SSH_STATUS_LABEL: Record<SshStatus, string> = {
  connected: "Connected",
  failing: "Can't connect",
  untested: "Not tested yet",
};

const BADGE: Record<SshStatus | "testing", string> = {
  connected: "border-brand/25 bg-brand-soft text-brand-strong",
  failing: "border-destructive/25 bg-destructive/[0.06] text-destructive",
  untested: "border-border bg-secondary text-muted-foreground",
  testing: "border-border bg-secondary text-foreground",
};

export function SshStatusBadge({ server, testing, className }: { server: SshServer; testing?: boolean; className?: string }) {
  const status = sshStatus(server);
  const badge = (
    <span
      tabIndex={status === "connected" ? 0 : undefined}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-[5px] border px-1.5 text-[11px] font-medium whitespace-nowrap outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-3",
        BADGE[testing ? "testing" : status],
        className,
      )}
    >
      {testing ? (
        <>
          <Spinner className="size-3" aria-hidden /> Testing…
        </>
      ) : status === "connected" ? (
        <>
          <LiveDot live={false} className="size-1.5 bg-brand" />
          {SSH_STATUS_LABEL.connected}
          <span className="font-normal opacity-75">· {timeAgo(server.lastConnectedAt!)}</span>
        </>
      ) : status === "failing" ? (
        <>
          <TriangleAlert aria-hidden /> {SSH_STATUS_LABEL.failing}
        </>
      ) : (
        <>
          <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/50" /> {SSH_STATUS_LABEL.untested}
        </>
      )}
    </span>
  );
  if (testing || status !== "connected") return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent>Last signed in {format(new Date(server.lastConnectedAt!), "PPp")}</TooltipContent>
    </Tooltip>
  );
}
