"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Network, ScrollText, ShieldCheck } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SettingRow, SettingsGroup } from "@/components/settings-kit";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/format";
import type { SecuritySettings } from "@/server/settings/registry";
import { saveSecurityAction, signEveryoneOutAction } from "../actions";
import { NumberRow, SaveBar, SwitchRow, toNumber } from "./fields";
import { useSettingsForm } from "./use-settings-form";

type SecurityFormValue = Omit<SecuritySettings, "loginPerEmail" | "loginPerIp" | "auditRetentionDays" | "trustedProxyHops"> & {
  loginPerEmail: string;
  loginPerIp: string;
  auditRetentionDays: string;
  trustedProxyHops: string;
};

function toForm(s: SecuritySettings): SecurityFormValue {
  return {
    loginPerEmail: String(s.loginPerEmail),
    loginPerIp: String(s.loginPerIp),
    auditRetentionDays: String(s.auditRetentionDays),
    trustProxy: s.trustProxy,
    trustedProxyHops: String(s.trustedProxyHops),
  };
}

export function SecurityForm({ initial, activeSessions, requestIp }: { initial: SecuritySettings; activeSessions: number; requestIp: string | null }) {
  const router = useRouter();
  const [sessions, setSessions] = useState(activeSessions);
  const form = useSettingsForm<SecurityFormValue>(toForm(initial), async (v) => {
    const result = await saveSecurityAction({
      loginPerEmail: toNumber(v.loginPerEmail),
      loginPerIp: toNumber(v.loginPerIp),
      auditRetentionDays: toNumber(v.auditRetentionDays),
      trustProxy: v.trustProxy,
      trustedProxyHops: toNumber(v.trustedProxyHops),
    });
    return result.ok ? { ok: true, data: toForm(result.data) } : result;
  });
  const { value, set, fields } = form;

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={form.submit} className="flex flex-col gap-5" noValidate>
        <SettingsGroup
          title="Sign-in limits"
          description="Sign-in e-mails per 15 minutes. Over the limit, the sign-in page asks to wait a few minutes and sends nothing, so inboxes cannot be flooded."
          icon={<ShieldCheck />}
        >
          <NumberRow
            id="security-per-email"
            label="Per e-mail address"
            description="1 to 100. Five lets a person retry a few times without flooding their inbox."
            unit="/ 15 min"
            min={1}
            max={100}
            value={value.loginPerEmail}
            onChange={(v) => set("loginPerEmail", v)}
            error={fields.loginPerEmail}
          />
          <NumberRow
            id="security-per-ip"
            label="Per IP address"
            description="1 to 10,000. Raise it when many people share one address, such as an office network."
            unit="/ 15 min"
            min={1}
            max={10_000}
            value={value.loginPerIp}
            onChange={(v) => set("loginPerIp", v)}
            error={fields.loginPerIp}
          />
        </SettingsGroup>

        <SettingsGroup title="Audit log" description="Who did what, for the admin area." icon={<ScrollText />}>
          <NumberRow
            id="security-audit-days"
            label="Keep entries for"
            description="Older entries are deleted every few hours. 0 keeps everything forever. Up to 3650 days."
            unit="days"
            min={0}
            max={3650}
            value={value.auditRetentionDays}
            onChange={(v) => set("auditRetentionDays", v)}
            error={fields.auditRetentionDays}
          />
        </SettingsGroup>

        <SettingsGroup
          title="Proxy in front"
          description="Sign-in limits, the audit log and the link approval page use the visitor's IP address. Behind a reverse proxy (Coolify's Traefik, nginx, Caddy) every connection comes from the proxy, which puts the real address into the X-Forwarded-For header."
          icon={<Network />}
        >
          <SwitchRow
            id="security-trust-proxy"
            label="Take the address from X-Forwarded-For"
            description="Only when the connection comes from a private or local network address, where the proxy lives. Off: the connecting address is used, which behind a proxy is always the proxy itself, so every visitor shares one sign-in limit."
            checked={value.trustProxy}
            onChange={(v) => set("trustProxy", v)}
            error={fields.trustProxy}
          />
          <NumberRow
            id="security-proxy-hops"
            label="Proxies in front"
            description="How many proxies add to X-Forwarded-For before the request arrives. Coolify alone is 1; a CDN such as Cloudflare in front of it makes 2. Too low trusts an address visitors can fake; too high picks the proxy's own address."
            unit={value.trustedProxyHops === "1" ? "proxy" : "proxies"}
            min={1}
            max={5}
            value={value.trustedProxyHops}
            onChange={(v) => set("trustedProxyHops", v)}
            disabled={!value.trustProxy}
            error={fields.trustedProxyHops}
          />
          <SettingRow label="Your address as seen now" description="Open this page from outside the server's network: this should be your own public address, not a 10.x, 172.16–31.x or 192.168.x one.">
            <span className="font-mono text-sm tabular-nums">{requestIp ?? "unknown"}</span>
          </SettingRow>
        </SettingsGroup>

        <SaveBar form={form} />
      </form>

      <SettingsGroup
        title="Active sign-ins"
        description="Browsers and devices signed in to any account on this cloud, including the ones of linked computers' owners."
        icon={<LogOut />}
        tone="danger"
      >
        <SettingRow
          label={
            <>
              <span className="font-mono tabular-nums">{formatNumber(sessions)}</span> active {sessions === 1 ? "sign-in" : "sign-ins"}
            </>
          }
          description="Signing everyone out ends every session except yours in this browser. People sign in again with a new e-mail link; linked computers stay linked."
        >
          <ConfirmDialog
            trigger={
              <Button type="button" variant="destructive" disabled={sessions <= 1}>
                Sign everyone out
              </Button>
            }
            title="Sign everyone out?"
            description={`${formatNumber(Math.max(sessions - 1, 0))} ${sessions - 1 === 1 ? "sign-in ends" : "sign-ins end"} right away. Only this browser stays signed in. Nobody loses data.`}
            confirmLabel="Sign everyone out"
            pendingLabel="Signing out…"
            tone="danger"
            successMessage="Everyone else is signed out"
            onConfirm={async () => {
              const result = await signEveryoneOutAction();
              if (result.ok) {
                setSessions(1);
                router.refresh();
              }
              return result;
            }}
          />
        </SettingRow>
      </SettingsGroup>
    </div>
  );
}
