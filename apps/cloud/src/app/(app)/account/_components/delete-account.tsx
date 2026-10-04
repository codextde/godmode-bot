"use client";

import { TriangleAlert } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Callout, SettingRow, SettingsGroup } from "@/components/settings-kit";
import { Button } from "@/components/ui/button";
import { deleteOwnAccountAction } from "../actions";

export function DeleteAccount({ email, lastOwner, computers, subscribed }: { email: string; lastOwner: boolean; computers: number; subscribed: boolean }) {
  return (
    <SettingsGroup tone="danger" icon={<TriangleAlert />} title="Delete account" description="This cannot be undone.">
      <SettingRow
        label="Delete your account"
        description={
          lastOwner
            ? "You are the only owner of this cloud. Make someone else an owner under Admin → People before you delete your account."
            : [
                computers > 0 ? `Your ${computers === 1 ? "computer is" : `${computers} computers are`} unlinked and the people you shared them with lose access.` : null,
                subscribed ? "Your subscription ends immediately." : null,
                "Your sign-ins, invitations and shares are removed.",
              ]
                .filter(Boolean)
                .join(" ")
        }
      >
        {lastOwner ? (
          <Button variant="destructive" disabled>
            Delete account
          </Button>
        ) : (
          <ConfirmDialog
            trigger={<Button variant="destructive">Delete account</Button>}
            tone="danger"
            title="Delete your account?"
            description="Everything about your account on this cloud is removed. Godmode on your computers keeps working on its own."
            confirmText={email}
            confirmTextLabel={
              <span>
                Type your e-mail address <span className="font-mono font-medium text-foreground">{email}</span> to confirm.
              </span>
            }
            confirmLabel="Delete my account"
            pendingLabel="Deleting…"
            onConfirm={() => deleteOwnAccountAction(email)}
          >
            {subscribed && <Callout tone="warning" title="Your subscription ends right away">You are not charged again; no refund is made for the rest of the period.</Callout>}
          </ConfirmDialog>
        )}
      </SettingRow>
    </SettingsGroup>
  );
}
