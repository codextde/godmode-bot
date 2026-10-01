import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

/**
 * A picture at full size. Clicks in it stay in it: the dialog is a portal, but React still bubbles its events to the
 * picture's parents (a description that opens its editor on click, say).
 */
export function Lightbox({
  src,
  alt,
  open,
  onOpenChange,
  footer,
}: {
  src: string;
  alt: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  footer?: ReactNode;
}) {
  return (
    <span className="contents" onClick={(e) => e.stopPropagation()}>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent aria-describedby={undefined} className="w-max max-w-[92vw] gap-2 p-2 sm:max-w-[92vw]">
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          <img src={src} alt={alt} className="mx-auto max-h-[80vh] w-auto max-w-full rounded-lg object-contain" />
          {footer}
        </DialogContent>
      </Dialog>
    </span>
  );
}
