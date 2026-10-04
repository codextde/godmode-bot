"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SettingRow, SettingsGroup } from "@/components/settings-kit";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  removeDeviceAction,
  setDeviceStatusAction,
  unshareDeviceAction,
} from "../../actions";
import { RenameDialog } from "../../_components/rename-dialog";

export function RenameButton({
  deviceId,
  name,
}: {
  deviceId: string;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Pencil />
        Rename
      </Button>
      <RenameDialog
        deviceId={deviceId}
        name={name}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

/** Turn off / on and remove, for the computer's owner. */
export function DangerZone({
  device,
}: {
  device: { id: string; name: string; status: "active" | "disabled" };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const off = device.status !== "active";

  const turnOn = () =>
    startTransition(async () => {
      const result = await setDeviceStatusAction(device.id, "active");
      if (result.ok) toast.success("Computer turned on");
      else toast.error(result.error);
    });

  return (
    <SettingsGroup
      tone="danger"
      icon={<TriangleAlert />}
      title="Danger zone"
      description="Nothing here deletes anything on the computer itself."
    >
      <SettingRow
        label={off ? "This computer is turned off" : "Turn off"}
        description={
          off
            ? "The cloud refuses its link. Turn it on and Godmode reconnects within a few minutes."
            : "The cloud disconnects it and refuses its link until you turn it on again."
        }
      >
        {off ? (
          <Button
            variant="outline"
            onClick={turnOn}
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending && (
              <Spinner aria-hidden aria-label={undefined} role={undefined} />
            )}
            {pending ? "Turning on…" : "Turn on"}
          </Button>
        ) : (
          <ConfirmDialog
            trigger={<Button variant="outline">Turn off</Button>}
            title={`Turn off ${device.name}?`}
            description="Nobody can open it through the cloud, and phones can't reach it through the gateway, until you turn it on again. Godmode on the computer itself keeps working."
            confirmLabel="Turn off"
            pendingLabel="Turning off…"
            onConfirm={() => setDeviceStatusAction(device.id, "disabled")}
            successMessage="Computer turned off"
          />
        )}
      </SettingRow>
      <SettingRow
        label="Remove this computer"
        description="Ends the link and removes everyone's access. You can link the computer again later; its traffic history stays in your usage."
      >
        <ConfirmDialog
          trigger={<Button variant="destructive">Remove</Button>}
          tone="danger"
          title={`Remove ${device.name}?`}
          description="The link ends, people you shared it with lose access, and phones paired through the cloud stop reaching it."
          confirmLabel="Remove"
          pendingLabel="Removing…"
          onConfirm={async () => {
            const result = await removeDeviceAction(device.id);
            if (result.ok) router.push("/devices");
            return result;
          }}
          successMessage="Computer removed"
        />
      </SettingRow>
    </SettingsGroup>
  );
}

/** For someone the computer is shared with: take it off the own list. */
export function LeaveButton({
  deviceId,
  deviceName,
  userId,
}: {
  deviceId: string;
  deviceName: string;
  userId: string;
}) {
  const router = useRouter();
  return (
    <ConfirmDialog
      trigger={<Button variant="outline">Remove from my list</Button>}
      tone="danger"
      title={`Remove ${deviceName} from your list?`}
      description="You lose access to this computer. Its owner can share it with you again."
      confirmLabel="Remove"
      pendingLabel="Removing…"
      onConfirm={async () => {
        const result = await unshareDeviceAction(deviceId, userId);
        if (result.ok) router.push("/devices");
        return result;
      }}
      successMessage="Removed from your list"
    />
  );
}
