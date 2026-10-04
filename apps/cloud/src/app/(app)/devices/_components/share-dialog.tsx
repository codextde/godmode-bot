"use client";

import { useEffect, useState, useTransition, type FormEvent } from "react";
import { toast } from "sonner";
import { ChoiceCards } from "@/components/controls";
import { FormField } from "@/components/form";
import { ResponsiveDialog, ResponsiveDialogBody, ResponsiveDialogClose, ResponsiveDialogFooter } from "@/components/responsive-dialog";
import { Callout } from "@/components/settings-kit";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { shareDeviceAction } from "../actions";

export type ShareRole = "operator" | "viewer";

export const SHARE_ROLES: { value: ShareRole; title: string; description: string }[] = [
  { value: "operator", title: "Operator", description: "Can do everything you can on this computer, including running commands" },
  { value: "viewer", title: "Viewer", description: "Can read every chat, file list and agent file" },
];

/** Share a computer with another account of this cloud, or change what someone already on the list may do. */
export function ShareDialog({
  deviceId,
  deviceName,
  open,
  onOpenChange,
  person,
}: {
  deviceId: string;
  deviceName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Set to change the role of someone who already has access (the address is then fixed). */
  person?: { email: string; role: ShareRole };
}) {
  const [email, setEmail] = useState(person?.email ?? "");
  const [role, setRole] = useState<ShareRole>(person?.role ?? "viewer");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (open) {
      setEmail(person?.email ?? "");
      setRole(person?.role ?? "viewer");
      setError(null);
    }
  }, [open, person?.email, person?.role]);

  const address = email.trim();
  const unchanged = person ? role === person.role : address === "";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (unchanged) return;
    setError(null);
    startTransition(async () => {
      const result = await shareDeviceAction(deviceId, address, role);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onOpenChange(false);
      toast.success(person ? "Saved" : `Shared with ${address.toLowerCase()}`);
    });
  };

  return (
    <ResponsiveDialog
      bare
      open={open}
      onOpenChange={(next) => !pending && onOpenChange(next)}
      title={person ? "Change access" : `Share ${deviceName}`}
      description={
        person
          ? `What ${person.email} may do on ${deviceName}.`
          : "They need an account on this cloud. The computer keeps running under your plan."
      }
    >
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <ResponsiveDialogBody className="flex flex-col gap-4 pt-1">
          {!person && (
            <FormField label="E-mail address">
              <Input
                type="email"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                maxLength={320}
                autoFocus
                disabled={pending}
              />
            </FormField>
          )}
          <ChoiceCards
            name={`share-role-${deviceId}`}
            aria-label="What they may do"
            value={role}
            onChange={setRole}
            options={SHARE_ROLES}
            disabled={pending}
            className="@xl:grid-cols-1"
          />
          {error && <Callout tone="danger" title="Could not share the computer">{error}</Callout>}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <ResponsiveDialogClose asChild>
            <Button type="button" variant="outline" disabled={pending}>
              Cancel
            </Button>
          </ResponsiveDialogClose>
          <SubmitButton pending={pending} pendingLabel={person ? "Saving…" : "Sharing…"} disabled={unchanged}>
            {person ? "Save" : "Share"}
          </SubmitButton>
        </ResponsiveDialogFooter>
      </form>
    </ResponsiveDialog>
  );
}
