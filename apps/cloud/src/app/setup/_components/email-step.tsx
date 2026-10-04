"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Send } from "lucide-react";
import { Segmented } from "@/components/controls";
import { FormField, FormStack } from "@/components/form";
import { Callout } from "@/components/settings-kit";
import { StepCard, StepFooter, StepHeader } from "@/components/setup-shell";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UnsavedGuard } from "@/components/unsaved-guard";
import { saveEmailAction, testEmailAction, type SmtpInput } from "../actions";
import { stepHref } from "../_lib/steps";
import { useStepAction } from "./use-step-action";

type Provider = "ses" | "smtp";
type Security = SmtpInput["security"];

const FIELDS = ["host", "port", "security", "username", "password", "fromName", "fromEmail"] as const;

export interface EmailStepProps {
  initial: Omit<SmtpInput, "password">;
  /** A password is stored already (coming back to this step). */
  passwordSet: boolean;
  /** E-mail already goes out over SMTP. */
  configured: boolean;
  /** Amazon SES regions with their SMTP endpoint. */
  regions: { region: string; host: string }[];
  ownerEmail: string;
}

/** Step 3: how sign-in links and invitations are sent. Amazon SES preset, any SMTP server, or later. */
export function EmailStep({ initial, passwordSet, configured, regions, ownerEmail }: EmailStepProps) {
  const router = useRouter();
  const matched = regions.find((r) => r.host === initial.host);
  const [provider, setProvider] = useState<Provider>(initial.host && !matched ? "smtp" : "ses");
  const [region, setRegion] = useState(matched?.region ?? regions[0]?.region ?? "");
  const [host, setHost] = useState(matched ? "" : initial.host);
  const [port, setPort] = useState(String(initial.port));
  const [security, setSecurity] = useState<Security>(initial.security);
  const [username, setUsername] = useState(initial.username);
  const [password, setPassword] = useState("");
  const [fromName, setFromName] = useState(initial.fromName);
  const [fromEmail, setFromEmail] = useState(initial.fromEmail);
  const [dirty, setDirty] = useState(false);
  const [testedTo, setTestedTo] = useState<string | null>(null);
  const test = useStepAction(FIELDS);
  const save = useStepAction(FIELDS);
  const busy = test.pending || save.pending;
  const fields = { ...test.fields, ...save.fields };
  const error = save.error ?? test.error;

  const sesHost = regions.find((r) => r.region === region)?.host ?? "";
  const touch = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setDirty(true);
    setTestedTo(null);
  };

  /** The form as the server expects it; the SES preset fixes server, port and encryption. */
  const input = (): SmtpInput =>
    provider === "ses"
      ? { host: sesHost, port: 587, security: "starttls", username, password, fromName, fromEmail }
      : { host, port: Number(port), security, username, password, fromName, fromEmail };

  const onTest = () => {
    save.clear();
    setTestedTo(null);
    test.run(() => testEmailAction(input()), ({ to }) => setTestedTo(to));
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    test.clear();
    setTestedTo(null);
    save.run(
      () => saveEmailAction(input()),
      () => {
        setDirty(false);
        router.push(stepHref("access"));
      },
    );
  };

  return (
    <form onSubmit={onSubmit} noValidate>
      <UnsavedGuard when={dirty && !busy} />
      <StepHeader
        eyebrow="Delivery"
        title="E-mail"
        description="People sign in with a link sent by e-mail, and invitations go out the same way. Connect the mail service that sends them."
      />
      <div className="flex flex-col gap-5">
        <StepCard>
          <FormStack>
            <Segmented<Provider>
              aria-label="Mail service"
              value={provider}
              onChange={touch(setProvider)}
              disabled={busy}
              options={[
                { value: "ses", label: "Amazon SES" },
                { value: "smtp", label: "Other SMTP server" },
              ]}
              className="w-full sm:w-fit"
            />
            {provider === "ses" ? (
              <FormField
                label="Region"
                error={fields.host}
                hint={
                  <>
                    Server <span className="font-mono break-all text-foreground">{sesHost}</span>, port{" "}
                    <span className="font-mono text-foreground tabular-nums">587</span>, STARTTLS.
                  </>
                }
              >
                <SelectField name="region" value={region} onChange={touch(setRegion)} options={regions.map((r) => ({ value: r.region, label: r.region }))} mono />
              </FormField>
            ) : (
              <>
                <FormField label="SMTP server" error={fields.host}>
                  <Input
                    name="host"
                    value={host}
                    onChange={(e) => touch(setHost)(e.target.value)}
                    placeholder="smtp.example.com"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                </FormField>
                <div className="grid gap-5 sm:grid-cols-2">
                  <FormField label="Port" error={fields.port}>
                    <Input
                      name="port"
                      inputMode="numeric"
                      value={port}
                      onChange={(e) => touch(setPort)(e.target.value.replace(/\D/g, "").slice(0, 5))}
                      className="font-mono tabular-nums"
                    />
                  </FormField>
                  <FormField label="Encryption" error={fields.security}>
                    <SelectField<Security>
                      name="security"
                      value={security}
                      onChange={touch(setSecurity)}
                      options={[
                        { value: "starttls", label: "STARTTLS (port 587)" },
                        { value: "tls", label: "TLS (port 465)" },
                        { value: "none", label: "None" },
                      ]}
                    />
                  </FormField>
                </div>
              </>
            )}
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField
                label={provider === "ses" ? "SMTP user name" : "User name"}
                error={fields.username}
                hint={provider === "ses" ? "From “SMTP settings” in the SES console. Not your AWS access key." : undefined}
              >
                <Input
                  name="smtpUser"
                  value={username}
                  onChange={(e) => touch(setUsername)(e.target.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="font-mono"
                />
              </FormField>
              <FormField
                label={provider === "ses" ? "SMTP password" : "Password"}
                error={fields.password}
                hint={passwordSet ? "One is stored. Leave this empty to keep it." : "Stored encrypted and never shown again."}
              >
                <Input
                  type="password"
                  name="smtpPassword"
                  value={password}
                  onChange={(e) => touch(setPassword)(e.target.value)}
                  autoComplete="new-password"
                  placeholder={passwordSet ? "••••••••" : undefined}
                />
              </FormField>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField label="From name" error={fields.fromName}>
                <Input name="fromName" value={fromName} onChange={(e) => touch(setFromName)(e.target.value)} maxLength={80} />
              </FormField>
              <FormField
                label="From address"
                error={fields.fromEmail}
                hint={provider === "ses" ? "An address or domain you verified in SES." : undefined}
              >
                <Input
                  type="email"
                  name="fromEmail"
                  inputMode="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="cloud@example.com"
                  value={fromEmail}
                  onChange={(e) => touch(setFromEmail)(e.target.value)}
                />
              </FormField>
            </div>
            {error && <Callout tone="danger" title={error} />}
            {testedTo && (
              <Callout tone="success" role="status" title="Test e-mail sent">
                Look for it in the inbox of <span className="break-all text-foreground">{testedTo}</span>. Nothing is saved until you continue.
              </Callout>
            )}
            <div>
              <Button type="button" variant="outline" onClick={onTest} disabled={busy} aria-busy={test.pending || undefined}>
                <Send />
                {test.pending ? "Sending…" : "Send test e-mail"}
              </Button>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Goes to <span className="break-all">{ownerEmail}</span>.
              </p>
            </div>
          </FormStack>
        </StepCard>
        <Callout tone="muted" role="note" title={configured ? "E-mail is set up" : "You can do this later"}>
          {configured
            ? "E-mails already go out through the server above. Continue saves your changes after another test e-mail; “Keep as it is” leaves them untouched."
            : "Until e-mail is set up, nothing is sent: sign-in links and invitations are written to the server log, and you copy them from there. Set it up any time under Admin → Settings → E-mail."}
        </Callout>
      </div>
      <StepFooter backHref={stepHref("cloud")}>
        <Button variant="ghost" asChild className="text-muted-foreground">
          <Link href={stepHref("access")}>{configured ? "Keep as it is" : "Skip for now"}</Link>
        </Button>
        <SubmitButton pending={save.pending} pendingLabel="Testing…" disabled={test.pending} className="max-md:flex-1">
          Test and continue <ArrowRight />
        </SubmitButton>
      </StepFooter>
    </form>
  );
}

/** A Select that FormField can label (the trigger takes the id and aria attributes). */
function SelectField<T extends string>({
  name,
  value,
  onChange,
  options,
  mono,
  ...trigger
}: {
  name: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  mono?: boolean;
  id?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  return (
    <Select name={name} value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger {...trigger} className={mono ? "w-full font-mono" : "w-full"}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className={mono ? "font-mono" : undefined}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
