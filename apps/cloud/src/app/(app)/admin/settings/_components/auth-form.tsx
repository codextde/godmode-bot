"use client";

import { useState, type KeyboardEvent } from "react";
import { AtSign, Globe, MailPlus, Timer, UserPlus, X } from "lucide-react";
import { ChoiceCards } from "@/components/controls";
import { Callout, SettingRow, SettingsGroup } from "@/components/settings-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AuthSettings } from "@/server/settings/registry";
import { saveAuthAction, type AccessMode } from "../actions";
import { NumberRow, SaveBar, SwitchRow, toNumber } from "./fields";
import { useSettingsForm } from "./use-settings-form";

interface AuthFormValue {
  access: AccessMode;
  allowedDomains: string[];
  defaultRoleKey: string;
  sessionDays: string;
  magicLinkMinutes: string;
  codeLogin: boolean;
  inviteDays: string;
}

function toForm(settings: AuthSettings): AuthFormValue {
  return {
    access: settings.inviteOnly ? "invite" : settings.allowedDomains.length > 0 ? "domains" : "open",
    allowedDomains: settings.allowedDomains,
    defaultRoleKey: settings.defaultRoleKey,
    sessionDays: String(settings.sessionDays),
    magicLinkMinutes: String(settings.magicLinkMinutes),
    codeLogin: settings.codeLogin,
    inviteDays: String(settings.inviteDays),
  };
}

/** The domain rule that would be stored: "Anyone" has none. */
function effectiveDomains(value: AuthFormValue): string[] {
  return value.access === "open" ? [] : value.allowedDomains;
}

// The server decides (settings registry); this only catches typos before the round trip.
const DOMAIN_SHAPE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export function AuthForm({ initial, roles }: { initial: AuthSettings; roles: { key: string; name: string }[] }) {
  const [stored, setStored] = useState(() => toForm(initial));
  const form = useSettingsForm<AuthFormValue>(toForm(initial), async (v) => {
    const result = await saveAuthAction({
      access: v.access,
      allowedDomains: v.allowedDomains,
      defaultRoleKey: v.defaultRoleKey,
      sessionDays: toNumber(v.sessionDays),
      magicLinkMinutes: toNumber(v.magicLinkMinutes),
      codeLogin: v.codeLogin,
      inviteDays: toNumber(v.inviteDays),
    });
    if (!result.ok) return result;
    // In "Anyone" the list is not stored; keep what was typed in case the choice changes back before leaving.
    const next = { ...toForm(result.data), allowedDomains: v.access === "open" ? v.allowedDomains : result.data.allowedDomains };
    setStored(next);
    return { ok: true, data: next };
  });
  const { value, set, fields } = form;
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);

  /** Moves what is typed into the list. Returns the new list, or null when an entry is not a domain. */
  const addDomains = (): string[] | null => {
    const entries = draft
      .split(/[\s,;]+/)
      .map((entry) => entry.trim().toLowerCase().replace(/^.*@/, ""))
      .filter(Boolean);
    if (entries.length === 0) return value.allowedDomains;
    const bad = entries.find((entry) => !DOMAIN_SHAPE.test(entry));
    if (bad) {
      setDraftError(`“${bad}” is not a domain. Write it like example.com.`);
      return null;
    }
    const next = [...new Set([...value.allowedDomains, ...entries])];
    set("allowedDomains", next);
    setDraft("");
    setDraftError(null);
    return next;
  };

  const onDraftKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addDomains();
    } else if (e.key === "Backspace" && draft === "" && value.allowedDomains.length > 0) {
      set("allowedDomains", value.allowedDomains.slice(0, -1));
    }
  };

  const before = effectiveDomains(stored);
  const after = effectiveDomains(value);
  // The server signs out everyone outside a changed, non-empty list: a first list, or a list that lost a domain.
  const signsPeopleOut = after.length > 0 && (before.length === 0 || before.some((d) => !after.includes(d)));
  const domainError = draftError ?? fields.allowedDomains;
  const roleKnown = roles.some((r) => r.key === value.defaultRoleKey);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (value.access === "open") return form.submit();
        // A domain still in the input counts: nobody expects typed text to be dropped on Save.
        const domains = addDomains();
        if (domains) form.submit(undefined, { ...value, allowedDomains: domains });
      }}
      className="flex flex-col gap-5"
      noValidate
    >
      <section className="animate-enter flex flex-col gap-3">
        <div>
          <h2 className="text-[15px] leading-snug font-medium tracking-[-0.01em]">Who can sign in</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            People who already have an account keep it. Owners can always sign in.
          </p>
        </div>
        <ChoiceCards
          name="access"
          aria-label="Who can sign in"
          className="@xl:grid-cols-1"
          value={value.access}
          onChange={(v) => set("access", v)}
          options={[
            {
              value: "invite",
              icon: <MailPlus />,
              title: "Only people I invite",
              description: "Nobody gets in without an invitation. You can also limit invitations to certain domains.",
            },
            {
              value: "domains",
              icon: <AtSign />,
              title: "Anyone at these domains",
              description: "Everyone with an e-mail address at one of your domains can sign in and gets an account.",
            },
            {
              value: "open",
              icon: <Globe />,
              title: "Anyone",
              description: "Everyone with an e-mail address can sign in and gets an account.",
            },
          ]}
        />
        {fields.access && (
          <p role="alert" className="text-xs text-destructive">
            {fields.access}
          </p>
        )}
      </section>

      {value.access !== "open" && (
        <SettingsGroup
          title={value.access === "invite" ? "Limit invitations to domains" : "Allowed domains"}
          description={
            value.access === "invite"
              ? "Optional. With a list, only addresses at these domains can be invited and sign in."
              : "Only addresses at these domains can sign in. Subdomains count only when listed themselves."
          }
          icon={<AtSign />}
        >
          <SettingRow
            label="Domains"
            htmlFor="auth-domain"
            stacked
            description={
              <>
                The part after “@”, like example.com. Press Enter to add one.
                {domainError && (
                  <span id="auth-domain-error" role="alert" className="mt-1 block text-destructive">
                    {domainError}
                  </span>
                )}
              </>
            }
          >
            {value.allowedDomains.length > 0 && (
              <ul aria-label="Allowed domains" className="mb-2.5 flex flex-wrap gap-1.5">
                {value.allowedDomains.map((domain) => (
                  <li
                    key={domain}
                    className="inline-flex max-w-full items-center gap-0.5 rounded-md border bg-paper-2 py-0.5 pr-0.5 pl-2 font-mono text-xs"
                  >
                    <span className="min-w-0 truncate">{domain}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove ${domain}`}
                      onClick={() => set("allowedDomains", value.allowedDomains.filter((d) => d !== domain))}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2">
              <Input
                id="auth-domain"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setDraftError(null);
                }}
                onKeyDown={onDraftKey}
                placeholder="example.com"
                inputMode="url"
                autoCapitalize="off"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={domainError ? true : undefined}
                aria-describedby={domainError ? "auth-domain-error" : undefined}
                className="font-mono"
              />
              <Button type="button" variant="outline" onClick={addDomains} disabled={!draft.trim()}>
                Add
              </Button>
            </div>
          </SettingRow>
          <div className="py-4">
            {signsPeopleOut ? (
              <Callout tone="warning" title="Saving signs people out">
                Everyone whose address is not at one of these domains is signed out right away and cannot sign in again.
                Owners stay signed in.
              </Callout>
            ) : (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Removing a domain signs out everyone at that domain right away, and they cannot sign in again. Their
                accounts and computers are kept. Owners are never signed out by this rule.
              </p>
            )}
          </div>
        </SettingsGroup>
      )}

      <SettingsGroup title="New accounts" description="What people get when they join." icon={<UserPlus />}>
        <SettingRow
          label="Role for people who sign up on their own"
          htmlFor="auth-default-role"
          disabled={value.access === "invite"}
          description={
            <>
              {value.access === "invite"
                ? "Not used while only invited people can sign in: every invitation names its role."
                : "Only roles without access to the admin area can be chosen."}
              {fields.defaultRoleKey && (
                <span role="alert" className="mt-1 block text-destructive">
                  {fields.defaultRoleKey}
                </span>
              )}
            </>
          }
        >
          <Select value={value.defaultRoleKey} onValueChange={(v) => set("defaultRoleKey", v)} disabled={value.access === "invite"}>
            <SelectTrigger id="auth-default-role" className="w-44" aria-invalid={fields.defaultRoleKey ? true : undefined}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {!roleKnown && <SelectItem value={value.defaultRoleKey}>{value.defaultRoleKey}</SelectItem>}
              {roles.map((role) => (
                <SelectItem key={role.key} value={role.key}>
                  {role.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <NumberRow
          id="auth-invite-days"
          label="Invitations expire after"
          description="An invitation that was not accepted in time has to be sent again. 1 to 90 days."
          unit="days"
          min={1}
          max={90}
          value={value.inviteDays}
          onChange={(v) => set("inviteDays", v)}
          error={fields.inviteDays}
        />
      </SettingsGroup>

      <SettingsGroup title="Signing in" description="How long a sign-in lasts and how the e-mail works." icon={<Timer />}>
        <NumberRow
          id="auth-session-days"
          label="Stay signed in for"
          description="Counted from the last visit, on every device separately. 1 to 400 days; browsers do not keep a sign-in longer than about 400."
          unit="days"
          min={1}
          max={400}
          value={value.sessionDays}
          onChange={(v) => set("sessionDays", v)}
          error={fields.sessionDays}
        />
        <NumberRow
          id="auth-link-minutes"
          label="Sign-in link works for"
          description="The link and the code in a sign-in e-mail stop working after this time. 5 to 60 minutes."
          unit="minutes"
          min={5}
          max={60}
          value={value.magicLinkMinutes}
          onChange={(v) => set("magicLinkMinutes", v)}
          error={fields.magicLinkMinutes}
        />
        <SwitchRow
          id="auth-code-login"
          label="Include a code in the sign-in e-mail"
          description="An 8-digit code to type into the browser that asked, for when the e-mail is read on another device. The link works either way."
          checked={value.codeLogin}
          onChange={(v) => set("codeLogin", v)}
          error={fields.codeLogin}
        />
      </SettingsGroup>

      <SaveBar form={form} />
    </form>
  );
}
