"use client";

import { useState, useTransition, type FormEvent } from "react";
import { UserRound } from "lucide-react";
import { toast } from "sonner";
import { Callout, InfoRow, SettingRow, SettingsGroup } from "@/components/settings-kit";
import { SubmitButton } from "@/components/submit-button";
import { UnsavedGuard } from "@/components/unsaved-guard";
import { Input } from "@/components/ui/input";
import { updateNameAction } from "../actions";

export function ProfileForm({ name, email, roleName }: { name: string | null; email: string; roleName: string }) {
  const [saved, setSaved] = useState(name ?? "");
  const [value, setValue] = useState(name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const dirty = value.trim() !== saved.trim();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    setError(null);
    startTransition(async () => {
      const result = await updateNameAction(value);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(value.trim());
      toast.success("Saved");
    });
  };

  return (
    <form onSubmit={submit}>
      <UnsavedGuard when={dirty} />
      <SettingsGroup
        icon={<UserRound />}
        title="Profile"
        description="How you appear to people you share computers with."
        footer={
          <SubmitButton pending={pending} pendingLabel="Saving…" disabled={!dirty}>
            Save
          </SubmitButton>
        }
      >
        <SettingRow label="Name" htmlFor="account-name" description="Optional. Shown next to your e-mail address.">
          <Input
            id="account-name"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={80}
            autoComplete="name"
            placeholder="Your name"
            className="@xl:w-72"
            disabled={pending}
          />
        </SettingRow>
        <InfoRow label="E-mail address">
          <span className="font-mono text-xs tabular-nums">{email}</span>
        </InfoRow>
        <InfoRow label="Role">{roleName}</InfoRow>
        {error && (
          <div className="py-4">
            <Callout tone="danger" title="Could not save your name">
              {error}
            </Callout>
          </div>
        )}
      </SettingsGroup>
    </form>
  );
}
