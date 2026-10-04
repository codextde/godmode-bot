"use client";

import { useEffect, useId, useState, useTransition, type ReactElement, type ReactNode } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/settings-kit";
import { ResponsiveDialog, ResponsiveDialogClose } from "@/components/responsive-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";

/** What a server action returns (`ActionResult` from src/lib/action.ts fits), or nothing. */
export type ActionResultLike = { ok: boolean; error?: string } | void | null | undefined;

/** Next's redirect()/notFound() travel as errors with a NEXT_ digest; they must reach the router untouched. */
export function isNavigationError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "digest" in err && String((err as { digest: unknown }).digest).startsWith("NEXT_");
}

/**
 * Asks before an action (house rule 8: Dialog from md, Drawer below). `onConfirm` may return a server action's
 * ActionResult: `{ ok: false, error }` keeps the dialog open and shows the error; anything else closes it and shows
 * `successMessage` as a toast. `confirmText` makes the person type a value first (e.g. their e-mail address).
 *
 *   <ConfirmDialog
 *     trigger={<Button variant="outline">Revoke</Button>}
 *     title="Revoke this invite?"
 *     description="The link stops working right away."
 *     confirmLabel="Revoke" pendingLabel="Revoking…" tone="danger"
 *     onConfirm={() => revokeInviteAction(invite.id)}
 *     successMessage="Invite revoked"
 *   />
 */
export function ConfirmDialog({
  trigger,
  open: openProp,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = "Confirm",
  pendingLabel,
  cancelLabel = "Cancel",
  tone = "default",
  confirmText,
  confirmTextLabel,
  onConfirm,
  successMessage,
}: {
  trigger?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** A question: "Remove this computer?" */
  title: ReactNode;
  description?: ReactNode;
  /** Extra content between the description and the buttons. */
  children?: ReactNode;
  confirmLabel?: string;
  /** "Removing…" */
  pendingLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  /** The exact text the person must type before confirming. */
  confirmText?: string;
  confirmTextLabel?: ReactNode;
  onConfirm: () => ActionResultLike | Promise<ActionResultLike>;
  successMessage?: string;
}) {
  const id = useId();
  const [internal, setInternal] = useState(false);
  const open = openProp ?? internal;
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (open) {
      setError(null);
      setTyped("");
    }
  }, [open]);

  const setOpen = (next: boolean) => {
    if (pending && !next) return;
    if (openProp === undefined) setInternal(next);
    onOpenChange?.(next);
  };

  const matches = !confirmText || typed.trim().toLowerCase() === confirmText.trim().toLowerCase();

  const confirm = () => {
    if (!matches) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await onConfirm();
        if (result && result.ok === false) {
          setError(result.error ?? "Could not finish this. Try again.");
          return;
        }
        if (openProp === undefined) setInternal(false);
        onOpenChange?.(false);
        if (successMessage) toast.success(successMessage);
      } catch (err) {
        if (isNavigationError(err)) throw err;
        setError(err instanceof Error && err.message ? err.message : "Could not finish this. Try again.");
      }
    });
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={setOpen}
      trigger={trigger}
      title={title}
      description={description}
      footer={
        <>
          <ResponsiveDialogClose asChild>
            <Button variant="outline" disabled={pending}>
              {cancelLabel}
            </Button>
          </ResponsiveDialogClose>
          <Button
            variant={tone === "danger" ? "destructive" : "default"}
            onClick={confirm}
            disabled={pending || !matches}
            aria-busy={pending || undefined}
          >
            {pending && <Spinner aria-hidden aria-label={undefined} role={undefined} />}
            {pending && pendingLabel ? pendingLabel : confirmLabel}
          </Button>
        </>
      }
    >
      {(children || confirmText || error) && (
        <div className="flex flex-col gap-4 pb-2">
          {children}
          {confirmText && (
            <div className="space-y-2">
              <Label htmlFor={`${id}-confirm`} className="text-sm font-normal text-muted-foreground">
                {confirmTextLabel ?? (
                  <span>
                    Type <span className="font-mono font-medium text-foreground">{confirmText}</span> to confirm.
                  </span>
                )}
              </Label>
              <Input
                id={`${id}-confirm`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    confirm();
                  }
                }}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                disabled={pending}
              />
            </div>
          )}
          {error && <Callout tone="danger" title={error} />}
        </div>
      )}
    </ResponsiveDialog>
  );
}
