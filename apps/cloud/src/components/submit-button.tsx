"use client";

import type { ComponentProps, ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/**
 * A form's primary button. Busy while the surrounding <form action={…}> is pending (useFormStatus) or while
 * `pending` is true (useTransition forms). Busy labels end in an ellipsis: pendingLabel="Saving…".
 * Disable it until something changed: `disabled={!dirty}`.
 */
export function SubmitButton({
  pending,
  pendingLabel,
  icon,
  children,
  disabled,
  type = "submit",
  ...props
}: Omit<ComponentProps<typeof Button>, "asChild"> & {
  pending?: boolean;
  pendingLabel?: string;
  /** Shown before the label while idle (replaced by the spinner while busy). */
  icon?: ReactNode;
}) {
  const status = useFormStatus();
  const busy = Boolean(pending) || status.pending;
  return (
    <Button {...props} type={type} disabled={disabled || busy} aria-busy={busy || undefined}>
      {busy ? <Spinner aria-hidden aria-label={undefined} role={undefined} /> : icon}
      {busy && pendingLabel ? pendingLabel : children}
    </Button>
  );
}
