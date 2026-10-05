import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { ExternalLink, KeyRound, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import type { LicensePlan, LicenseState, LicenseStatus } from "@godmode/shared";
import { ActivatePanel, LicenseKeyForm } from "@/components/license/activate";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage } from "@/lib/api";
import { cloudContext } from "@/lib/core";
import { openExternal } from "@/lib/desktop";
import { useLicense } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { ToneBadge } from "./cloud-section";
import { Callout, InfoRow, SectionHeading, SettingsGroup } from "./settings-kit";

const STATUS: Record<LicenseStatus, { label: string; tone: "live" | "neutral" | "warning" | "danger" }> = {
  active: { label: "Active", tone: "live" },
  trial: { label: "Free trial", tone: "live" },
  past_due: { label: "Payment due", tone: "warning" },
  grace: { label: "Key needed", tone: "warning" },
  unverified: { label: "Not checked yet", tone: "warning" },
  missing: { label: "No licence", tone: "neutral" },
  invalid: { label: "Invalid key", tone: "danger" },
  expired: { label: "Ended", tone: "danger" },
};

const PLAN: Record<LicensePlan, string> = {
  monthly: "Monthly",
  yearly: "Yearly",
  lifetime: "Founder Lifetime",
};

const day = (iso: string) => format(new Date(iso), "MMMM d, yyyy");

export function LicenseSection() {
  const license = useLicense();
  return (
    <div className="space-y-5">
      <SectionHeading title="License" description="Your Godmode Pro licence: every feature, on this computer and the runners that work for it." />
      {license.data ? (
        <LicenseCard state={license.data} />
      ) : license.isError ? (
        <Callout tone="danger" title="Couldn't load the licence">
          {errorMessage(license.error)}
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={() => license.refetch()}>
              <RefreshCw /> Try again
            </Button>
          </div>
        </Callout>
      ) : (
        <div className="space-y-4 rounded-xl border bg-card p-5 shadow-card">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-72" />
          <Skeleton className="h-4 w-56" />
        </div>
      )}
    </div>
  );
}

function LicenseCard({ state: s }: { state: LicenseState }) {
  const qc = useQueryClient();
  const [changing, setChanging] = useState(false);
  const [removing, setRemoving] = useState(false);
  const status = STATUS[s.status];
  const local = !cloudContext;

  const refresh = useMutation({
    mutationFn: api.license.refresh,
    onSuccess: (next) => {
      qc.setQueryData(qk.license, next);
      toast.success("Licence checked", { id: "license-checked", duration: 1500 });
    },
    onError: (err) => toast.error("Couldn't check the licence", { description: errorMessage(err) }),
  });
  const remove = useMutation({
    mutationFn: api.license.remove,
    onSuccess: (next) => {
      qc.setQueryData(qk.license, next);
      toast.success("Licence key removed");
    },
    onError: (err) => toast.error("Couldn't remove the key", { description: errorMessage(err) }),
  });

  if (!s.keyHint) {
    return (
      <>
        {s.message && <Callout tone={s.blocked ? "warning" : "info"}>{s.message}</Callout>}
        <SettingsGroup
          title="Activate Godmode"
          icon={<Sparkles />}
          description="Every feature in every plan. Your agents, chats and logins stay on this computer."
          actions={<ToneBadge tone={s.status === "grace" ? "warning" : "neutral"}>{STATUS[s.status].label}</ToneBadge>}
        >
          <div className="py-5">{local ? <ActivatePanel source="settings" /> : <Callout>Add the licence key in Godmode on the computer itself.</Callout>}</div>
        </SettingsGroup>
        {!s.enforced && <NotEnforced />}
      </>
    );
  }

  const renewal =
    s.status === "trial" && s.trialEndsAt
      ? { label: s.cancelAtPeriodEnd ? "Trial ends, then stops" : "Trial ends", value: day(s.trialEndsAt) }
      : s.renewsAt
        ? { label: s.cancelAtPeriodEnd ? "Cancels on" : "Renews on", value: day(s.renewsAt) }
        : s.plan === "lifetime"
          ? { label: "Renews", value: "Never, it's yours" }
          : null;

  return (
    <>
      {s.message && <Callout tone={s.blocked ? "danger" : s.status === "past_due" || s.status === "unverified" ? "warning" : "info"}>{s.message}</Callout>}
      <SettingsGroup
        title={s.plan === "lifetime" ? "Godmode Pro · Founder Lifetime" : "Godmode Pro"}
        icon={<KeyRound />}
        description={s.checkedAt ? `Checked ${formatDistanceToNow(new Date(s.checkedAt), { addSuffix: true })}` : "Not checked with usegodmode.com yet"}
        actions={<ToneBadge tone={status.tone}>{status.label}</ToneBadge>}
      >
        <InfoRow label="Plan">{s.plan ? PLAN[s.plan] : "—"}</InfoRow>
        {renewal && <InfoRow label={renewal.label}>{renewal.value}</InfoRow>}
        {s.status === "unverified" && s.unverifiedUntil && <InfoRow label="Accepted until">{day(s.unverifiedUntil)}</InfoRow>}
        {s.graceEndsAt && (s.status === "invalid" || s.status === "expired") && new Date(s.graceEndsAt) > new Date() && (
          <InfoRow label="Keeps working until">{day(s.graceEndsAt)}</InfoRow>
        )}
        <InfoRow label="Key" mono>
          <span className="text-muted-foreground">GM-•••••-•••••-•••••-</span>
          {s.keyHint}
        </InfoRow>
        <div className="flex flex-wrap items-center gap-2 py-4">
          {local && (
            <Button variant="outline" size="sm" onClick={() => setChanging(true)}>
              <KeyRound /> Change key
            </Button>
          )}
          {s.manageUrl && (
            <Button variant="outline" size="sm" onClick={() => void openExternal(s.manageUrl!)}>
              <ExternalLink /> Manage subscription
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            {refresh.isPending ? <Spinner className="size-3.5" /> : <RefreshCw />} Refresh
          </Button>
          {local && (
            <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={() => setRemoving(true)} disabled={remove.isPending}>
              Remove key…
            </Button>
          )}
        </div>
      </SettingsGroup>
      {!s.enforced && <NotEnforced />}

      <Dialog open={changing} onOpenChange={setChanging}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Change licence key</DialogTitle>
            <DialogDescription>The new key is checked before it replaces the one ending in {s.keyHint}.</DialogDescription>
          </DialogHeader>
          <LicenseKeyForm autoFocus submitLabel="Use key" onActivated={() => setChanging(false)} />
        </DialogContent>
      </Dialog>

      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the licence key?</AlertDialogTitle>
            <AlertDialogDescription>
              {s.enforced
                ? "Godmode stops starting new work on this computer until a key is added again. Your subscription itself isn't changed."
                : "Your subscription itself isn't changed; you can add the key again any time."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => remove.mutate()}>
              Remove key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function NotEnforced() {
  return <Callout tone="muted">This copy of Godmode runs from source, so it doesn't need a licence. Release builds do.</Callout>;
}
