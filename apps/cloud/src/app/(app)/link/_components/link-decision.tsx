"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Callout } from "@/components/settings-kit";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { approveLinkAction, denyLinkAction } from "../actions";

/** Approve / Deny for one pending request. `blocked` disables Approve (plan limit, computer online, role). */
export function LinkDecision({ code, deviceName, blocked }: { code: string; deviceName: string; blocked: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<{ title: string; text: string; billing: boolean } | null>(null);
  const [, startTransition] = useTransition();

  const approve = () => {
    setBusy("approve");
    setError(null);
    startTransition(async () => {
      const result = await approveLinkAction(code);
      if (!result.ok) {
        setError({ title: "Could not link this computer", text: result.error, billing: Boolean(result.planLimit) });
        setBusy(null);
        return;
      }
      toast.success(`${result.data.name} is linked to your account`);
      router.replace("/devices");
    });
  };

  const deny = () => {
    setBusy("deny");
    setError(null);
    startTransition(async () => {
      const result = await denyLinkAction(code);
      if (!result.ok) {
        setError({ title: "Could not deny this request", text: result.error, billing: false });
        setBusy(null);
        return;
      }
      toast.success(`Request from ${deviceName} denied`);
      router.replace("/devices");
    });
  };

  return (
    <div className="flex w-full flex-col gap-3">
      {error && (
        <Callout
          tone="danger"
          title={error.title}
          action={
            error.billing ? (
              <Button asChild variant="outline" size="sm">
                <Link href="/billing">Open billing</Link>
              </Button>
            ) : undefined
          }
        >
          {error.text}
        </Callout>
      )}
      <div className="flex flex-col-reverse gap-2 @md:flex-row @md:justify-end">
        <Button variant="outline" onClick={deny} disabled={busy !== null} aria-busy={busy === "deny" || undefined}>
          {busy === "deny" && <Spinner aria-hidden aria-label={undefined} role={undefined} />}
          {busy === "deny" ? "Denying…" : "Deny"}
        </Button>
        <Button onClick={approve} disabled={busy !== null || blocked} aria-busy={busy === "approve" || undefined}>
          {busy === "approve" && <Spinner aria-hidden aria-label={undefined} role={undefined} />}
          {busy === "approve" ? "Approving…" : "Approve"}
        </Button>
      </div>
    </div>
  );
}
