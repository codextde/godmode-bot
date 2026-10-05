"use client";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { revokeUserSessionAction } from "../actions";

/** "Sign out" next to one signed-in browser on a person's page. */
export function RevokeSessionButton({ userId, sessionId, label }: { userId: string; sessionId: string; label: string }) {
  return (
    <ConfirmDialog
      trigger={
        <Button variant="outline" size="sm" aria-label={`Sign out ${label}`}>
          Sign out
        </Button>
      }
      title="Sign out this browser?"
      description={`${label} has to sign in again. Other browsers stay signed in.`}
      confirmLabel="Sign out"
      pendingLabel="Signing out…"
      onConfirm={() => revokeUserSessionAction(userId, sessionId)}
      successMessage="Browser signed out"
    />
  );
}
