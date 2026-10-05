"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Globe, Mail, UserPlus } from "lucide-react";
import { ChoiceCards } from "@/components/controls";
import { CopyField } from "@/components/copy-button";
import { FormField, FormStack } from "@/components/form";
import { Callout } from "@/components/settings-kit";
import { StepCard, StepFooter, StepHeader } from "@/components/setup-shell";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { UnsavedGuard } from "@/components/unsaved-guard";
import { inviteTeammatesAction, saveAccessAction, type AccessInput, type InviteOutcome } from "../actions";
import { stepHref, type AccessMode } from "../_lib/steps";
import { useStepAction } from "./use-step-action";

export interface AccessStepProps {
  initial: { mode: AccessMode; domains: string; sessionDays: number };
  roles: { id: string; name: string }[];
  defaultRoleId: string;
  /** Sign-in links still go to the server log, so invitation e-mails are not delivered. */
  mailInLog: boolean;
}

const ACCESS_FIELDS = ["mode", "domains", "sessionDays"] as const;
const INVITE_FIELDS = [...ACCESS_FIELDS, "emails", "roleId"] as const;

/** Step 4: who can sign in, how long a browser stays signed in, and the first invitations. */
export function AccessStep({ initial, roles, defaultRoleId, mailInLog }: AccessStepProps) {
  const router = useRouter();
  const [mode, setMode] = useState<AccessMode>(initial.mode);
  const [domains, setDomains] = useState(initial.domains);
  const [sessionDays, setSessionDays] = useState(String(initial.sessionDays));
  const [saved, setSaved] = useState(initial);
  const [emails, setEmails] = useState("");
  const [roleId, setRoleId] = useState(defaultRoleId);
  const [outcome, setOutcome] = useState<InviteOutcome | null>(null);
  const save = useStepAction(ACCESS_FIELDS);
  const invite = useStepAction(INVITE_FIELDS);
  const busy = save.pending || invite.pending;
  const fields = { ...save.fields, ...invite.fields };
  const error = save.error ?? invite.error;

  const access = (): AccessInput => ({ mode, domains, sessionDays: Number(sessionDays) });
  const dirty = mode !== saved.mode || domains !== saved.domains || Number(sessionDays) !== saved.sessionDays;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    invite.clear();
    save.run(
      () => saveAccessAction(access(), true),
      () => {
        setSaved({ mode, domains, sessionDays: Number(sessionDays) });
        router.push(stepHref("billing"));
      },
    );
  };

  const onInvite = () => {
    save.clear();
    invite.run(
      () => inviteTeammatesAction({ access: access(), emails, roleId }),
      (result) => {
        setSaved({ mode, domains, sessionDays: Number(sessionDays) });
        setOutcome(result);
        setEmails("");
      },
    );
  };

  return (
    <form onSubmit={onSubmit} noValidate>
      <UnsavedGuard when={dirty && !busy} />
      <StepHeader eyebrow="Sign-in" title="Access" description="Decide who may sign in. You can change this any time under Admin → Settings → Sign-in." />
      <div className="flex flex-col gap-5">
        <StepCard>
          <FormStack>
            <ChoiceCards<AccessMode>
              name="access-mode"
              aria-label="Who can sign in"
              value={mode}
              onChange={(v) => setMode(v)}
              disabled={busy}
              options={[
                {
                  value: "invite",
                  icon: <Mail />,
                  title: "Only people I invite",
                  description: "Nobody gets in without an invitation from you or an admin. The usual choice for a team.",
                },
                {
                  value: "domains",
                  icon: <Globe />,
                  title: "Anyone at these domains",
                  description: "Everyone with an e-mail address at your domains can sign in and gets an account on first sign-in.",
                },
                {
                  value: "open",
                  icon: <UserPlus />,
                  title: "Anyone",
                  description: "Anyone with an e-mail address can sign in. For a public service with billing.",
                },
              ]}
            />
            {mode !== "open" && (
              <FormField
                label={mode === "domains" ? "Allowed domains" : "Limit invitations to these domains"}
                optional={mode === "invite"}
                error={fields.domains}
                hint="The part after “@”. Separate several with commas; subdomains count separately."
              >
                <Input
                  name="domains"
                  value={domains}
                  onChange={(e) => setDomains(e.target.value)}
                  placeholder="example.com, example.org"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="font-mono"
                />
              </FormField>
            )}
            <FormField label="Stay signed in for (days)" error={fields.sessionDays} hint="How long a browser stays signed in; extended while it is used. 1 to 400 days.">
              <Input
                name="sessionDays"
                inputMode="numeric"
                value={sessionDays}
                onChange={(e) => setSessionDays(e.target.value.replace(/\D/g, "").slice(0, 3))}
                className="w-28 font-mono tabular-nums"
              />
            </FormField>
            {error && <Callout tone="danger" title={error} />}
          </FormStack>
        </StepCard>

        <StepCard>
          <FormStack>
            <div>
              <h2 className="text-[15px] leading-snug font-medium tracking-[-0.01em]">
                Invite teammates <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">optional</span>
              </h2>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                They get a link to join with the role you choose. Your access rules above are saved first.
              </p>
            </div>
            <FormField label="E-mail addresses" error={fields.emails} hint="One per line, or separated by commas.">
              <Textarea
                name="emails"
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
                placeholder={"anna@example.com\nben@example.com"}
                rows={3}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="font-mono"
              />
            </FormField>
            <FormField label="Role" error={fields.roleId}>
              <RoleSelect value={roleId} onChange={setRoleId} roles={roles} />
            </FormField>
            <div>
              <Button type="button" variant="outline" onClick={onInvite} disabled={busy || !emails.trim()} aria-busy={invite.pending || undefined}>
                <UserPlus />
                {invite.pending ? "Inviting…" : "Invite"}
              </Button>
            </div>
            {outcome && (
              <div className="flex flex-col gap-3" aria-live="polite">
                {outcome.created.length > 0 && (
                  <>
                    {mailInLog || outcome.created.some((c) => !c.emailed) ? (
                      <Callout tone="warning" role="note" title="Send these links yourself">
                        E-mail delivery is not set up, so nobody received an invitation. Copy each link and send it to that person.
                      </Callout>
                    ) : (
                      <Callout tone="success" role="status" title={outcome.created.length === 1 ? "Invitation sent" : `${outcome.created.length} invitations sent`}>
                        Each link also works on its own if an e-mail does not arrive.
                      </Callout>
                    )}
                    <ul className="flex flex-col gap-3">
                      {outcome.created.map((c) => (
                        <li key={c.email} className="space-y-1.5">
                          <p className="text-sm font-medium break-all">{c.email}</p>
                          <CopyField value={c.url} label={`Copy the invite link for ${c.email}`} />
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {outcome.skipped.length > 0 && (
                  <Callout tone="muted" role="note" title={outcome.skipped.length === 1 ? "One address was skipped" : `${outcome.skipped.length} addresses were skipped`}>
                    <ul className="space-y-1">
                      {outcome.skipped.map((s) => (
                        <li key={s.email}>
                          <span className="font-mono break-all text-foreground">{s.email}</span>: {s.reason}
                        </li>
                      ))}
                    </ul>
                  </Callout>
                )}
              </div>
            )}
          </FormStack>
        </StepCard>
      </div>
      <StepFooter backHref={stepHref("email")}>
        <SubmitButton pending={save.pending} pendingLabel="Saving…" disabled={invite.pending} className="max-md:flex-1">
          Continue <ArrowRight />
        </SubmitButton>
      </StepFooter>
    </form>
  );
}

function RoleSelect({
  value,
  onChange,
  roles,
  ...trigger
}: {
  value: string;
  onChange: (value: string) => void;
  roles: { id: string; name: string }[];
  id?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  return (
    <Select name="roleId" value={value} onValueChange={onChange}>
      <SelectTrigger {...trigger} className="w-full sm:w-64">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {roles.map((r) => (
          <SelectItem key={r.id} value={r.id}>
            {r.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
