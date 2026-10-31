import { format, formatDistanceToNowStrict } from "date-fns";
import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SshServer } from "@godmode/shared";
import { LiveDot } from "@/components/aicss/Motion";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { dateLocale, t } from "@/i18n";
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
  if (seconds < 45) return t("ssh:time.justNow");
  if (seconds < 3600) return t("ssh:time.minutesAgo", { n: Math.max(1, Math.round(seconds / 60)) });
  if (seconds < 86_400) return t("ssh:time.hoursAgo", { n: Math.round(seconds / 3600) });
  return formatDistanceToNowStrict(new Date(iso), { addSuffix: true, locale: dateLocale() });
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
  get connected() {
    return t("ssh:status.connected");
  },
  get failing() {
    return t("ssh:status.failing");
  },
  get untested() {
    return t("ssh:status.untested");
  },
};

const BADGE: Record<SshStatus | "testing", string> = {
  connected: "border-brand/25 bg-brand-soft text-brand-strong",
  failing: "border-destructive/25 bg-destructive/[0.06] text-destructive",
  untested: "border-border bg-secondary text-muted-foreground",
  testing: "border-border bg-secondary text-foreground",
};

export function SshStatusBadge({ server, testing, className }: { server: SshServer; testing?: boolean; className?: string }) {
  const { t } = useTranslation("ssh");
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
          <Spinner className="size-3" aria-hidden /> {t("status.testing")}
        </>
      ) : status === "connected" ? (
        <>
          <LiveDot live={false} className="size-1.5 bg-brand" />
          {t("status.connected")}
          <span className="font-normal opacity-75">· {timeAgo(server.lastConnectedAt!)}</span>
        </>
      ) : status === "failing" ? (
        <>
          <TriangleAlert aria-hidden /> {t("status.failing")}
        </>
      ) : (
        <>
          <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/50" /> {t("status.untested")}
        </>
      )}
    </span>
  );
  if (testing || status !== "connected") return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent>{t("status.lastSignedIn", { date: format(new Date(server.lastConnectedAt!), "PPp", { locale: dateLocale() }) })}</TooltipContent>
    </Tooltip>
  );
}
