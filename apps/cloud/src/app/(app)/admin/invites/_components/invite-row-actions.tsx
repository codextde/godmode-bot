"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, Ellipsis, Send } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ResponsiveDialog, ResponsiveDialogClose } from "@/components/responsive-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { resendInviteAction, revokeInviteAction, type InviteLink } from "../actions";
import { InviteLinks } from "./invite-links";

/** The trailing menu of an invitation: resend (shows the new link to copy) and revoke. */
export function InviteRowActions({
  invite,
  canResend,
  canRevoke,
}: {
  invite: { id: string; email: string };
  /** Pending or expired, and a role the signed-in person may give. */
  canResend: boolean;
  canRevoke: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [link, setLink] = useState<InviteLink | null>(null);
  const [revoking, setRevoking] = useState(false);
  if (!canResend && !canRevoke) return null;

  const resend = () =>
    startTransition(async () => {
      const result = await resendInviteAction(invite.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setLink({ email: invite.email, ...result.data });
    });

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for the invitation of ${invite.email}`}
            disabled={pending}
            aria-busy={pending || undefined}
            className="text-muted-foreground hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
          >
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          {canResend && (
            <DropdownMenuItem onSelect={resend}>
              <Send />
              Resend with a new link
            </DropdownMenuItem>
          )}
          {canRevoke && (
            <DropdownMenuItem variant="destructive" onSelect={() => setRevoking(true)}>
              <Ban />
              Revoke…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {link && (
        <ResponsiveDialog
          open
          onOpenChange={(open) => {
            if (open) return;
            setLink(null);
            router.refresh();
          }}
          title="Invitation resent"
          description="The earlier link no longer works. Copy the invite link if you want to send it yourself."
          footer={
            <ResponsiveDialogClose asChild>
              <Button>Done</Button>
            </ResponsiveDialogClose>
          }
        >
          <div className="pb-2">
            <InviteLinks links={[link]} />
          </div>
        </ResponsiveDialog>
      )}
      {revoking && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setRevoking(false)}
          title="Revoke this invitation?"
          description={`The link sent to ${invite.email} stops working right away. You can invite them again later.`}
          confirmLabel="Revoke"
          pendingLabel="Revoking…"
          tone="danger"
          onConfirm={() => revokeInviteAction(invite.id)}
          successMessage="Invitation revoked"
        />
      )}
    </>
  );
}
