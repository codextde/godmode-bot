"use client";

import { Fragment, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { Ellipsis } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog, isNavigationError, type ActionResultLike } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface RowAction {
  label: string;
  icon?: ReactNode;
  /** Navigates there. */
  href?: string;
  /** Runs right away. A server action bound to the row works: `suspendUser.bind(null, id)`. */
  onSelect?: () => ActionResultLike | Promise<ActionResultLike>;
  /** Asks first (destructive or hard-to-undo actions). Takes the place of `onSelect`. */
  confirm?: {
    title: ReactNode;
    description?: ReactNode;
    confirmLabel: string;
    pendingLabel?: string;
    /** Text the person must type first. */
    confirmText?: string;
    onConfirm: () => ActionResultLike | Promise<ActionResultLike>;
  };
  /** Toast after `onSelect` or `confirm` succeeded. */
  successMessage?: string;
  tone?: "danger";
  disabled?: boolean;
  /** Draw a separator above this item. */
  separator?: boolean;
}

/**
 * The trailing "…" menu of a DataTable row (or any card). Confirmations open as a ResponsiveDialog next to the
 * menu, so they survive the menu closing. Errors from `onSelect` (`{ ok: false, error }`) become a toast.
 */
export function RowActions({ items, label = "Actions", align = "end" }: { items: RowAction[]; label?: string; align?: "start" | "end" }) {
  const [confirming, setConfirming] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();
  const visible = items.filter(Boolean);
  if (visible.length === 0) return null;
  const active = confirming === null ? null : visible[confirming];

  const run = (item: RowAction) => {
    if (!item.onSelect) return;
    const onSelect = item.onSelect;
    startTransition(async () => {
      try {
        const result = await onSelect();
        if (result && result.ok === false) toast.error(result.error ?? "Could not finish this. Try again.");
        else if (item.successMessage) toast.success(item.successMessage);
      } catch (err) {
        if (isNavigationError(err)) throw err;
        toast.error(err instanceof Error && err.message ? err.message : "Could not finish this. Try again.");
      }
    });
  };

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            disabled={pending}
            className="text-muted-foreground hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
          >
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} className="min-w-48">
          {visible.map((item, i) => (
            <Fragment key={`${item.label}-${i}`}>
              {item.separator && i > 0 && <DropdownMenuSeparator />}
              {item.href ? (
                <DropdownMenuItem asChild disabled={item.disabled} variant={item.tone === "danger" ? "destructive" : "default"}>
                  <Link href={item.href}>
                    {item.icon}
                    {item.label}
                  </Link>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  disabled={item.disabled}
                  variant={item.tone === "danger" ? "destructive" : "default"}
                  onSelect={() => (item.confirm ? setConfirming(i) : run(item))}
                >
                  {item.icon}
                  {item.label}
                  {item.confirm && <span aria-hidden className="ml-auto text-muted-foreground">…</span>}
                </DropdownMenuItem>
              )}
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {active?.confirm && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirming(null)}
          title={active.confirm.title}
          description={active.confirm.description}
          confirmLabel={active.confirm.confirmLabel}
          pendingLabel={active.confirm.pendingLabel}
          confirmText={active.confirm.confirmText}
          tone={active.tone === "danger" ? "danger" : "default"}
          onConfirm={active.confirm.onConfirm}
          successMessage={active.successMessage}
        />
      )}
    </>
  );
}
