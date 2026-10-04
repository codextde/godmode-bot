"use client";

import { useState, useTransition, type FormEvent } from "react";
import { usePathname, useRouter } from "next/navigation";
import { MailPlus } from "lucide-react";
import { FormField, FormStack } from "@/components/form";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogClose,
  ResponsiveDialogFooter,
} from "@/components/responsive-dialog";
import { Callout } from "@/components/settings-kit";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { RoleOption } from "../../users/capabilities";
import { createInvitesAction, type CreateInvitesResult } from "../actions";
import { InviteLinks } from "./invite-links";

/** "Invite people": one or many addresses, one role. Afterwards the links are shown to copy. */
export function InviteDialog({
  roles,
  defaultRoleId,
  defaultOpen = false,
  domainHint,
}: {
  /** Roles the signed-in person may give. */
  roles: RoleOption[];
  defaultRoleId: string;
  /** Opened by a link from elsewhere (`?invite=1`). */
  defaultOpen?: boolean;
  /** "Only addresses at solakon.de can join." when a domain list is set. */
  domainHint: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(defaultOpen);
  const [emails, setEmails] = useState("");
  const [roleId, setRoleId] = useState(defaultRoleId);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateInvitesResult | null>(null);
  const [pending, startTransition] = useTransition();
  const role = roles.find((r) => r.id === roleId);

  const onOpenChange = (next: boolean) => {
    if (pending) return;
    setOpen(next);
    if (!next) {
      // Forget the links once the dialog is closed, and drop `?invite=1` so a reload does not open it again.
      setResult(null);
      setEmails("");
      setError(null);
      setFields({});
      if (defaultOpen) router.replace(pathname, { scroll: false });
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setFields({});
    startTransition(async () => {
      const response = await createInvitesAction({ emails, roleId });
      if (!response.ok) {
        setFields(response.fields ?? {});
        if (!response.fields?.emails && !response.fields?.roleId) setError(response.error);
        return;
      }
      setResult(response.data);
    });
  };

  const trigger = (
    <Button>
      <MailPlus />
      Invite people
    </Button>
  );

  if (result) {
    const none = result.created.length === 0;
    return (
      <ResponsiveDialog
        open={open}
        onOpenChange={onOpenChange}
        trigger={trigger}
        title={none ? "Nobody was invited" : result.created.length === 1 ? "Invitation created" : `${result.created.length} invitations created`}
        description={none ? "None of the addresses could be invited." : "Copy the invite link if you want to send it yourself."}
        footer={
          <>
            {!none && (
              <Button
                variant="outline"
                onClick={() => {
                  setResult(null);
                  setEmails("");
                }}
              >
                Invite more
              </Button>
            )}
            <ResponsiveDialogClose asChild>
              <Button>Done</Button>
            </ResponsiveDialogClose>
          </>
        }
      >
        <div className="flex flex-col gap-4 pb-2">
          {!none && <InviteLinks links={result.created} />}
          {result.skipped.length > 0 && (
            <Callout tone={none ? "danger" : "muted"} title={result.skipped.length === 1 ? "1 address was skipped" : `${result.skipped.length} addresses were skipped`} role="status">
              <ul className="space-y-1">
                {result.skipped.map((s) => (
                  <li key={s.email} className="[overflow-wrap:anywhere]">
                    <span className="font-medium text-foreground">{s.email}</span> — {s.reason}
                  </li>
                ))}
              </ul>
            </Callout>
          )}
          {none && (
            <Button variant="outline" className="self-start" onClick={() => setResult(null)}>
              Back
            </Button>
          )}
        </div>
      </ResponsiveDialog>
    );
  }

  return (
    <ResponsiveDialog
      bare
      open={open}
      onOpenChange={onOpenChange}
      trigger={trigger}
      title="Invite people"
      description="Each person gets an e-mail with a link that creates their account."
    >
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <ResponsiveDialogBody>
          <FormStack className="pb-2">
            <FormField
              label="E-mail addresses"
              error={fields.emails}
              hint={`One or many, separated by commas, spaces or new lines.${domainHint ? ` ${domainHint}` : ""}`}
            >
              <Textarea
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
                rows={4}
                placeholder="anna@example.com, ben@example.com"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                inputMode="email"
                disabled={pending}
                className="max-h-48 text-base md:text-sm"
              />
            </FormField>
            <FormField label="Role" error={fields.roleId} hint={role?.description || undefined}>
              <Select value={roleId} onValueChange={setRoleId} disabled={pending}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a role" />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            {error && <Callout tone="danger" title={error} />}
          </FormStack>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <ResponsiveDialogClose asChild>
            <Button type="button" variant="outline" disabled={pending}>
              Cancel
            </Button>
          </ResponsiveDialogClose>
          <SubmitButton pending={pending} pendingLabel="Inviting…" disabled={!emails.trim() || !roleId}>
            Send invitations
          </SubmitButton>
        </ResponsiveDialogFooter>
      </form>
    </ResponsiveDialog>
  );
}
