"use client";

import { useState, useTransition, type FormEvent, type ReactElement } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createRoleAction } from "../actions";

export interface RoleSource {
  id: string;
  name: string;
  /** The permissions the role really has (owners: all). */
  permissions: string[];
}

const EMPTY = "__empty";

/** "New role" and "Duplicate": a name, a description and the role whose permissions to start from. */
export function NewRoleDialog({
  trigger,
  sources,
  from,
  title = "New role",
}: {
  trigger: ReactElement;
  sources: RoleSource[];
  /** Duplicate: the role to copy. */
  from?: RoleSource;
  title?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(from ? `Copy of ${from.name}`.slice(0, 40) : "");
  const [description, setDescription] = useState("");
  const [sourceId, setSourceId] = useState(from?.id ?? EMPTY);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onOpenChange = (next: boolean) => {
    if (pending) return;
    setOpen(next);
    if (next) {
      setName(from ? `Copy of ${from.name}`.slice(0, 40) : "");
      setDescription("");
      setSourceId(from?.id ?? EMPTY);
      setFields({});
      setError(null);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setFields({});
    startTransition(async () => {
      const source = sources.find((s) => s.id === sourceId);
      const result = await createRoleAction({ name, description, permissions: source?.permissions ?? [] });
      if (!result.ok) {
        setFields(result.fields ?? {});
        if (!result.fields?.name && !result.fields?.description) setError(result.error);
        return;
      }
      toast.success("Role created");
      setOpen(false);
      router.push(`/admin/roles?role=${encodeURIComponent(result.data.id)}`);
    });
  };

  return (
    <ResponsiveDialog
      bare
      open={open}
      onOpenChange={onOpenChange}
      trigger={trigger}
      title={title}
      description="A role is a set of permissions. You choose them in the next step and can change them any time."
    >
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <ResponsiveDialogBody>
          <FormStack className="pb-2">
            <FormField label="Name" error={fields.name}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={40}
                placeholder="Support"
                autoComplete="off"
                disabled={pending}
                className="text-base md:text-sm"
              />
            </FormField>
            <FormField label="Description" optional error={fields.description}>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={200}
                placeholder="What people with this role do"
                autoComplete="off"
                disabled={pending}
                className="text-base md:text-sm"
              />
            </FormField>
            <FormField label="Start from" hint="The new role begins with the permissions of this role.">
              <Select value={sourceId} onValueChange={setSourceId} disabled={pending}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={EMPTY}>No permissions</SelectItem>
                  {sources.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
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
          <SubmitButton pending={pending} pendingLabel="Creating…" disabled={!name.trim()}>
            Create role
          </SubmitButton>
        </ResponsiveDialogFooter>
      </form>
    </ResponsiveDialog>
  );
}
