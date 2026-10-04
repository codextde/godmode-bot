"use client";

import { useTransition, useState } from "react";
import { MonitorSmartphone } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { StatusBadge } from "@/components/data-display";
import { RelativeTime } from "@/components/relative-time";
import { SettingsGroup } from "@/components/settings-kit";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { revokeOtherSessionsAction, revokeSessionAction } from "../actions";

export interface SessionRow {
  id: string;
  label: string;
  ip: string | null;
  lastSeenAt: string;
  createdAt: string;
  current: boolean;
}

/** Every browser signed in to this account; sign out one, or every other one. */
export function SessionsList({ sessions }: { sessions: SessionRow[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const others = sessions.filter((s) => !s.current).length;

  const revoke = (id: string) => {
    setBusy(id);
    startTransition(async () => {
      const result = await revokeSessionAction(id);
      if (result.ok) toast.success("Browser signed out");
      else toast.error(result.error);
      setBusy(null);
    });
  };

  return (
    <SettingsGroup
      icon={<MonitorSmartphone />}
      title="Signed-in browsers"
      description="Where this account is signed in. Sign out anything you don't recognise."
      footer={
        others > 0 ? (
          <ConfirmDialog
            trigger={<Button variant="outline">Sign out all other browsers</Button>}
            title="Sign out all other browsers?"
            description={`${others} other ${others === 1 ? "browser stays" : "browsers stay"} signed in right now. ${others === 1 ? "It" : "They"} will have to sign in again. This browser stays signed in.`}
            confirmLabel="Sign out others"
            pendingLabel="Signing out…"
            onConfirm={() => revokeOtherSessionsAction()}
            successMessage="Other browsers signed out"
          />
        ) : undefined
      }
    >
      {sessions.map((session) => (
        <div key={session.id} className="flex items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">{session.label || "Unknown browser"}</p>
              {session.current && (
                <StatusBadge tone="positive" dot={false}>
                  This browser
                </StatusBadge>
              )}
            </div>
            <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
              <span className="font-mono tabular-nums">{session.ip ?? "Unknown address"}</span>
              <span aria-hidden>·</span>
              <span>
                Last active <RelativeTime date={session.lastSeenAt} />
              </span>
              <span aria-hidden>·</span>
              <span>
                Signed in <RelativeTime date={session.createdAt} />
              </span>
            </p>
          </div>
          {!session.current && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => revoke(session.id)}
              disabled={busy !== null}
              aria-busy={busy === session.id || undefined}
              aria-label={`Sign out ${session.label || "this browser"}`}
            >
              {busy === session.id && <Spinner aria-hidden aria-label={undefined} role={undefined} />}
              {busy === session.id ? "Signing out…" : "Sign out"}
            </Button>
          )}
        </div>
      ))}
    </SettingsGroup>
  );
}
