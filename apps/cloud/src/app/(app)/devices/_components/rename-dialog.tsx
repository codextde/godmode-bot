"use client";

import { useEffect, useState, useTransition, type FormEvent } from "react";
import { toast } from "sonner";
import { FormField } from "@/components/form";
import { ResponsiveDialog, ResponsiveDialogBody, ResponsiveDialogClose, ResponsiveDialogFooter } from "@/components/responsive-dialog";
import { Callout } from "@/components/settings-kit";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { renameDeviceAction } from "../actions";

export function RenameDialog({
  deviceId,
  name,
  open,
  onOpenChange,
}: {
  deviceId: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (open) {
      setValue(name);
      setError(null);
    }
  }, [open, name]);

  const clean = value.replace(/\s+/g, " ").trim();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!clean || clean === name) return;
    setError(null);
    startTransition(async () => {
      const result = await renameDeviceAction(deviceId, clean);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onOpenChange(false);
      toast.success("Saved");
    });
  };

  return (
    <ResponsiveDialog
      bare
      open={open}
      onOpenChange={(next) => !pending && onOpenChange(next)}
      title="Rename computer"
      description="The name is only used here in the cloud. It changes back if the computer is linked again."
    >
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <ResponsiveDialogBody className="flex flex-col gap-4 pt-1">
          <FormField label="Name">
            <Input value={value} onChange={(e) => setValue(e.target.value)} maxLength={80} autoComplete="off" autoFocus disabled={pending} />
          </FormField>
          {error && <Callout tone="danger" title="Could not rename the computer">{error}</Callout>}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <ResponsiveDialogClose asChild>
            <Button type="button" variant="outline" disabled={pending}>
              Cancel
            </Button>
          </ResponsiveDialogClose>
          <SubmitButton pending={pending} pendingLabel="Saving…" disabled={!clean || clean === name}>
            Save
          </SubmitButton>
        </ResponsiveDialogFooter>
      </form>
    </ResponsiveDialog>
  );
}
