"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Info, LogOut, Pencil, Power, PowerOff, Trash2, UserPlus } from "lucide-react";
import { RowActions, type RowAction } from "@/components/row-actions";
import { removeDeviceAction, setDeviceStatusAction, unshareDeviceAction } from "../actions";
import { RenameDialog } from "./rename-dialog";
import { ShareDialog } from "./share-dialog";

/**
 * The "…" menu of a computer. Owners rename, share, turn off and remove; people it is shared with can only take it
 * off their own list.
 */
export function DeviceMenu({
  device,
  owner,
  userId,
  canShare,
  detailsLink = true,
  afterRemove,
}: {
  device: { id: string; name: string; status: "active" | "disabled" };
  owner: boolean;
  /** The signed-in person (for leaving a shared computer). */
  userId: string;
  canShare: boolean;
  detailsLink?: boolean;
  /** Where to go once the computer is gone (the detail page leaves; the list just refreshes). */
  afterRemove?: string;
}) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [sharing, setSharing] = useState(false);

  const leave = async <T extends { ok: boolean }>(result: Promise<T>): Promise<T> => {
    const value = await result;
    if (value.ok && afterRemove) router.push(afterRemove);
    return value;
  };

  const items: RowAction[] = [];
  if (detailsLink) items.push({ label: "Details", icon: <Info />, href: `/devices/${device.id}` });
  if (owner) {
    items.push({ label: "Rename", icon: <Pencil />, onSelect: () => setRenaming(true) });
    if (canShare) items.push({ label: "Share", icon: <UserPlus />, onSelect: () => setSharing(true) });
    items.push(
      device.status === "active"
        ? {
            label: "Turn off",
            icon: <PowerOff />,
            separator: true,
            confirm: {
              title: `Turn off ${device.name}?`,
              description:
                "The cloud disconnects it and refuses its link until you turn it on again. Godmode on the computer itself keeps working.",
              confirmLabel: "Turn off",
              pendingLabel: "Turning off…",
              onConfirm: () => setDeviceStatusAction(device.id, "disabled"),
            },
            successMessage: "Computer turned off",
          }
        : {
            label: "Turn on",
            icon: <Power />,
            separator: true,
            onSelect: () => setDeviceStatusAction(device.id, "active"),
            successMessage: "Computer turned on",
          },
      {
        label: "Remove",
        icon: <Trash2 />,
        tone: "danger",
        confirm: {
          title: `Remove ${device.name}?`,
          description:
            "The link ends, people you shared it with lose access, and phones paired through the cloud stop reaching it. Nothing on the computer is deleted; you can link it again later.",
          confirmLabel: "Remove",
          pendingLabel: "Removing…",
          onConfirm: () => leave(removeDeviceAction(device.id)),
        },
        successMessage: "Computer removed",
      },
    );
  } else {
    items.push({
      label: "Remove from my list",
      icon: <LogOut />,
      tone: "danger",
      separator: true,
      confirm: {
        title: `Remove ${device.name} from your list?`,
        description: "You lose access to this computer. Its owner can share it with you again.",
        confirmLabel: "Remove",
        pendingLabel: "Removing…",
        onConfirm: () => leave(unshareDeviceAction(device.id, userId)),
      },
      successMessage: "Removed from your list",
    });
  }

  return (
    <>
      <RowActions label={`Actions for ${device.name}`} items={items} />
      {owner && <RenameDialog deviceId={device.id} name={device.name} open={renaming} onOpenChange={setRenaming} />}
      {owner && canShare && <ShareDialog deviceId={device.id} deviceName={device.name} open={sharing} onOpenChange={setSharing} />}
    </>
  );
}
