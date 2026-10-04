import type { ReactNode } from "react";
import { CopyField } from "@/components/copy-button";

/** How to link a computer, as the numbered steps of an EmptyState (the Computers page and /link use the same ones). */
export function linkSteps(publicUrl: string): ReactNode[] {
  return [
    <>
      Open <strong>Godmode</strong> on the computer and go to <strong>Settings → Cloud</strong>.
    </>,
    <>
      Choose <strong>Connect</strong> and enter this cloud&apos;s address:
      <CopyField value={publicUrl} label="Copy the cloud address" className="mt-2" />
    </>,
    <>
      Godmode shows a short code and opens this site. <strong>Approve</strong> the code here and the computer appears on this page.
    </>,
  ];
}
