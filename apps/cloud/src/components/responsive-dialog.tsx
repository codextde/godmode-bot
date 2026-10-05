"use client";

import { createContext, useCallback, useContext, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { Slot } from "radix-ui";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";

const DialogModeContext = createContext<{ desktop: boolean }>({ desktop: true });

/**
 * A centred Dialog from 768 px, a bottom Drawer below (house rule 8). For confirmations and forms of up to four
 * fields; longer forms get their own page.
 *
 * Simple content: pass `children` (wrapped in the body) and `footer` (buttons).
 * A form: pass `bare` and lay it out yourself so the submit button sits inside the <form>:
 *
 *   <ResponsiveDialog bare title="Rename computer" open={open} onOpenChange={setOpen}>
 *     <form action={…} className="flex min-h-0 flex-1 flex-col">
 *       <ResponsiveDialogBody>…fields…</ResponsiveDialogBody>
 *       <ResponsiveDialogFooter>
 *         <ResponsiveDialogClose asChild><Button variant="outline">Cancel</Button></ResponsiveDialogClose>
 *         <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
 *       </ResponsiveDialogFooter>
 *     </form>
 *   </ResponsiveDialog>
 */
export function ResponsiveDialog({
  open: openProp,
  onOpenChange,
  defaultOpen = false,
  trigger,
  title,
  description,
  children,
  footer,
  bare = false,
  className,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  /** An element that opens the dialog (a Button). */
  trigger?: ReactElement;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Render children as they are, without the body padding (see the form example above). */
  bare?: boolean;
  /** Extra classes for the dialog / drawer panel (e.g. `md:max-w-lg`). */
  className?: string;
}) {
  // The server renders the desktop branch; nothing differs in markup while the dialog is closed.
  const desktop = useMediaQuery("(min-width: 768px)", true);
  const [internal, setInternal] = useState(defaultOpen);
  const open = openProp ?? internal;
  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setInternal(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
  );

  const triggerEl = trigger ? (
    <Slot.Root onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}>
      {trigger}
    </Slot.Root>
  ) : null;

  const content = (
    <DialogModeContext.Provider value={{ desktop }}>
      {bare ? children : children !== undefined && <ResponsiveDialogBody>{children}</ResponsiveDialogBody>}
      {footer && <ResponsiveDialogFooter>{footer}</ResponsiveDialogFooter>}
    </DialogModeContext.Provider>
  );

  if (desktop) {
    return (
      <>
        {triggerEl}
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className={cn("flex max-h-[min(44rem,calc(100svh-4rem))] flex-col gap-0 p-0 sm:max-w-md", className)}>
            <DialogHeader className="shrink-0 gap-1.5 px-6 pt-6 pb-4 pr-12 text-left">
              <DialogTitle>{title}</DialogTitle>
              {description ? (
                <DialogDescription>{description}</DialogDescription>
              ) : (
                <DialogDescription className="sr-only">{title}</DialogDescription>
              )}
            </DialogHeader>
            {content}
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <>
      {triggerEl}
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent className={className}>
          <DrawerHeader className="shrink-0">
            <DrawerTitle>{title}</DrawerTitle>
            {description ? (
              <DrawerDescription>{description}</DrawerDescription>
            ) : (
              <DrawerDescription className="sr-only">{title}</DrawerDescription>
            )}
          </DrawerHeader>
          {content}
        </DrawerContent>
      </Drawer>
    </>
  );
}

/** Scrollable middle part of a ResponsiveDialog. */
export function ResponsiveDialogBody({ children, className }: { children: ReactNode; className?: string }) {
  const { desktop } = useContext(DialogModeContext);
  return (
    <div className={cn("min-h-0 flex-1 overflow-y-auto text-sm", desktop ? "px-6 pb-2" : "px-5 pb-2", className)}>{children}</div>
  );
}

/** Button row: right-aligned on desktop; stacked full-width on phones with the primary (last) button on top. */
export function ResponsiveDialogFooter({ children, className }: { children: ReactNode; className?: string }) {
  const { desktop } = useContext(DialogModeContext);
  return (
    <div
      className={cn(
        "flex shrink-0 gap-2",
        desktop ? "flex-row flex-wrap justify-end px-6 pt-4 pb-6" : "flex-col-reverse px-5 pt-3 pb-4 [&>*]:w-full",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Closes the surrounding ResponsiveDialog (use with `asChild` around a Button). */
export function ResponsiveDialogClose(props: ComponentProps<typeof DialogClose>) {
  const { desktop } = useContext(DialogModeContext);
  return desktop ? <DialogClose {...props} /> : <DrawerClose {...props} />;
}
