"use client";

import { useState } from "react";
import { toast } from "sonner";
import { AtSign, Mail, Server } from "lucide-react";
import { Segmented } from "@/components/controls";
import { StatusBadge } from "@/components/data-display";
import { RelativeTime } from "@/components/relative-time";
import { Callout, SettingRow, SettingsGroup } from "@/components/settings-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { EmailSettings } from "@/server/settings/registry";
import { saveEmailAction } from "../actions";
import { NumberRow, SaveBar, TextRow, toNumber } from "./fields";
import { useSettingsForm } from "./use-settings-form";

type EmailFormValue = Omit<EmailSettings, "port"> & { port: string };

function toForm(settings: EmailSettings): EmailFormValue {
  return {
    transport: settings.transport,
    host: settings.host,
    port: String(settings.port),
    security: settings.security,
    username: settings.username,
    password: "",
    fromName: settings.fromName,
    fromEmail: settings.fromEmail,
    replyTo: settings.replyTo,
  };
}

const SECURITY_PORT: Record<EmailSettings["security"], string> = { starttls: "587", tls: "465", none: "25" };

export function EmailForm({
  initial,
  passwordSet: passwordSetInitial,
  regions,
  defaultRegion,
  testTo,
  appName,
  lastFailure,
}: {
  initial: EmailSettings;
  passwordSet: boolean;
  /** Amazon SES regions with their SMTP endpoint. */
  regions: { region: string; host: string }[];
  defaultRegion: string;
  /** Where the test message goes: the signed-in owner. */
  testTo: string;
  appName: string;
  lastFailure: { at: string; error: string } | null;
}) {
  const [passwordSet, setPasswordSet] = useState(passwordSetInitial);
  const [replacing, setReplacing] = useState(false);
  const form = useSettingsForm<EmailFormValue>(
    toForm(initial),
    async (v) => {
      const result = await saveEmailAction({ ...v, port: toNumber(v.port) });
      if (!result.ok) return result;
      setPasswordSet(result.data.settings.passwordSet);
      setReplacing(false);
      toast.success(result.data.testedTo ? `Test e-mail sent to ${result.data.testedTo}. Saved.` : "Saved");
      return { ok: true, data: toForm(result.data.settings) };
    },
    { success: null },
  );
  const { value, set, fields } = form;
  const sesRegion = regions.find((r) => r.host === value.host.trim().toLowerCase())?.region;
  const [provider, setProvider] = useState<"ses" | "other">(sesRegion || !value.host ? "ses" : "other");
  const smtp = value.transport === "smtp";

  const useRegion = (region: string) => {
    const entry = regions.find((r) => r.region === region);
    if (!entry) return;
    set("host", entry.host);
    set("port", "587");
    set("security", "starttls");
  };

  const chooseProvider = (next: "ses" | "other") => {
    setProvider(next);
    if (next === "ses" && !sesRegion) useRegion(defaultRegion);
  };

  const chooseTransport = (next: EmailSettings["transport"]) => {
    set("transport", next);
    if (next === "smtp" && provider === "ses" && !sesRegion) useRegion(defaultRegion);
  };

  return (
    <form onSubmit={form.submit} className="flex flex-col gap-5" noValidate>
      {lastFailure && (
        <Callout tone="warning" title="The last e-mail could not be sent">
          <RelativeTime date={lastFailure.at} />: <span className="font-mono">{lastFailure.error}</span>
        </Callout>
      )}

      <SettingsGroup title="Delivery" description="How sign-in links, invitations and notices leave this cloud." icon={<Mail />}>
        <SettingRow
          label="Send through"
          description={
            smtp
              ? "E-mails go out through your mail server."
              : "Nothing is sent. Every message, with its sign-in link, is printed to the server log. Good for setting up; people cannot sign in on their own."
          }
        >
          <Segmented
            aria-label="Send through"
            value={value.transport}
            onChange={chooseTransport}
            options={[
              { value: "log", label: "Server log" },
              { value: "smtp", label: "SMTP" },
            ]}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        title="Mail server"
        description={smtp ? "Any SMTP server works. Amazon SES is filled in for you." : "Kept for later; not used while messages go to the server log."}
        icon={<Server />}
      >
        <SettingRow label="Provider">
          <Segmented
            aria-label="Provider"
            value={provider}
            onChange={chooseProvider}
            options={[
              { value: "ses", label: "Amazon SES" },
              { value: "other", label: "Other SMTP" },
            ]}
          />
        </SettingRow>
        {provider === "ses" ? (
          <SettingRow
            label="Region"
            htmlFor="email-region"
            description={
              <>
                The region your SES identity is verified in. Server{" "}
                <span className="font-mono break-all">{value.host || "not set"}</span>, port 587, STARTTLS.
                {fields.host && (
                  <span role="alert" className="mt-1 block text-destructive">
                    {fields.host}
                  </span>
                )}
              </>
            }
          >
            <Select value={sesRegion ?? ""} onValueChange={useRegion}>
              <SelectTrigger id="email-region" className="w-44 font-mono" aria-invalid={fields.host ? true : undefined}>
                <SelectValue placeholder="Choose a region" />
              </SelectTrigger>
              <SelectContent>
                {regions.map((r) => (
                  <SelectItem key={r.region} value={r.region} className="font-mono">
                    {r.region}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
        ) : (
          <>
            <TextRow
              id="email-host"
              label="Server"
              placeholder="smtp.example.com"
              inputMode="url"
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              mono
              value={value.host}
              onChange={(v) => set("host", v)}
              error={fields.host}
            />
            <SettingRow label="Encryption" description="STARTTLS upgrades a plain connection (port 587). TLS encrypts from the start (port 465).">
              <Segmented
                aria-label="Encryption"
                value={value.security}
                onChange={(next) => {
                  // Follow the usual port unless a special one was typed.
                  if (Object.values(SECURITY_PORT).includes(value.port)) set("port", SECURITY_PORT[next]);
                  set("security", next);
                }}
                options={[
                  { value: "starttls", label: "STARTTLS" },
                  { value: "tls", label: "TLS" },
                  { value: "none", label: "None" },
                ]}
              />
            </SettingRow>
            <NumberRow id="email-port" label="Port" min={1} max={65535} value={value.port} onChange={(v) => set("port", v)} error={fields.port} />
            {value.security === "none" && (
              <div className="py-4">
                <Callout tone="warning" title="The password and every sign-in link travel unencrypted">
                  Use this only for a mail server on the same machine or private network.
                </Callout>
              </div>
            )}
          </>
        )}
        <TextRow
          id="email-username"
          label="Username"
          description={
            provider === "ses"
              ? "The SMTP user name from the SES console (SMTP settings → Create SMTP credentials), not an AWS access key."
              : "Leave empty for a server that needs no sign-in."
          }
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          mono
          value={value.username}
          onChange={(v) => set("username", v)}
          error={fields.username}
        />
        {passwordSet && !replacing ? (
          <SettingRow label="Password" description="Stored encrypted. It is never shown again.">
            <StatusBadge tone="info">Saved</StatusBadge>
            <Button type="button" variant="outline" size="sm" onClick={() => setReplacing(true)}>
              Replace
            </Button>
          </SettingRow>
        ) : (
          <SettingRow
            label="Password"
            htmlFor="email-password"
            stacked
            description={
              <>
                {passwordSet ? "Type the new password. The saved one is kept until the test succeeds." : "Stored encrypted and never shown again."}
                {fields.password && (
                  <span id="email-password-error" role="alert" className="mt-1 block text-destructive">
                    {fields.password}
                  </span>
                )}
              </>
            }
          >
            <div className="flex gap-2">
              <Input
                id="email-password"
                type="password"
                autoComplete="new-password"
                value={value.password}
                onChange={(e) => set("password", e.target.value)}
                aria-invalid={fields.password ? true : undefined}
                aria-describedby={fields.password ? "email-password-error" : undefined}
                className="font-mono"
              />
              {passwordSet && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    set("password", "");
                    setReplacing(false);
                  }}
                >
                  Keep saved
                </Button>
              )}
            </div>
          </SettingRow>
        )}
      </SettingsGroup>

      <SettingsGroup title="Sender" description="Who the e-mails come from." icon={<AtSign />}>
        <TextRow
          id="email-from-name"
          label="From name"
          description={`Empty uses the name of this cloud (${appName}).`}
          placeholder={appName}
          autoComplete="off"
          value={value.fromName}
          onChange={(v) => set("fromName", v)}
          error={fields.fromName}
        />
        <TextRow
          id="email-from-address"
          label="From address"
          description="Must be an address or domain your mail server is allowed to send for (verified in SES)."
          type="email"
          inputMode="email"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          placeholder="cloud@example.com"
          value={value.fromEmail}
          onChange={(v) => set("fromEmail", v)}
          error={fields.fromEmail}
        />
        <TextRow
          id="email-reply-to"
          label="Reply-to"
          description="Where answers go. Empty: replies go to the From address."
          type="email"
          inputMode="email"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          value={value.replyTo}
          onChange={(v) => set("replyTo", v)}
          error={fields.replyTo}
        />
      </SettingsGroup>

      {smtp && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          “Test and save” connects with these settings and sends a test e-mail to <span className="font-medium text-foreground">{testTo}</span>.
          They are stored only when that worked; otherwise everything stays as it was.
        </p>
      )}

      <SaveBar form={form} label={smtp ? "Test and save" : "Save"} pendingLabel={smtp ? "Testing…" : "Saving…"} alwaysEnabled={smtp} />
    </form>
  );
}
