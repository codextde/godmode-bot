import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { Cloud, ExternalLink, RefreshCw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import type { CloudStatus } from "@godmode/shared";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { DrawCheck } from "@/components/aicss/Motion";
import { toastApiError } from "@/components/vault/vault-utils";
import { useNow } from "@/components/vault/use-now";
import { api, errorMessage } from "@/lib/api";
import { openExternal } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { ExpiryRing, Step } from "./pair-phone-dialog";
import { Callout } from "./settings-kit";

/** A link request lives 10 minutes in the cloud. */
const LINK_SECONDS = 600;

/** Linked to an account (whether the link is up right now or not). */
export function isLinked(status: CloudStatus): boolean {
  return status.state !== "unlinked" && status.state !== "linking" && status.state !== "revoked";
}

/** Link status of this computer; polled while a link waits for approval, in case the live event is missed. */
export function useCloudStatus(enabled = true) {
  return useQuery({
    queryKey: qk.cloud,
    queryFn: api.cloud.status,
    enabled,
    refetchInterval: (q) => (q.state.data?.state === "linking" ? 2_000 : false),
  });
}

/** "cloud.example.com/devices" → "https://cloud.example.com": a missing scheme becomes https, any path is dropped. */
export function normalizeCloudUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

function hostOf(url: string | null | undefined): string {
  try {
    return url ? new URL(url).host : "";
  } catch {
    return url ?? "";
  }
}

/** The approval page opens only on the cloud this computer is linking to, never wherever an answer points. */
function approvalUrl(status: CloudStatus): string | null {
  if (!status.pending || !status.url) return null;
  try {
    return new URL(status.pending.verifyUrl).origin === new URL(status.url).origin ? status.pending.verifyUrl : null;
  } catch {
    return null;
  }
}

export function useUnlinkCloud() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.cloud.unlink,
    onSuccess: (next) => {
      qc.setQueryData(qk.cloud, next);
      void qc.invalidateQueries({ queryKey: qk.cloudBilling });
    },
    onError: (e) => toastApiError(e, "Could not unlink", qc),
  });
}

export function UnlinkCloudDialog({ open, onOpenChange, onConfirm }: { open: boolean; onOpenChange: (open: boolean) => void; onConfirm: () => void }) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Unlink this computer?</AlertDialogTitle>
          <AlertDialogDescription>
            Browsers and phones can't reach it through Godmode Cloud anymore, and the cloud forgets it. Godmode keeps working here, and you can link
            it again later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Unlink
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Links this computer to a Godmode Cloud account: the cloud address, then a code the person approves in the browser.
 * Approval arrives as the "cloud" entity event (or the poll above) and turns into the success state.
 */
export function CloudLinkDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const { data: status } = useCloudStatus(open);
  // Whether this dialog started (or picked up) a link, so a linked computer shows the success state and not the form.
  const [started, setStarted] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const unlink = useUnlinkCloud();

  const link = useMutation({
    mutationFn: api.cloud.link,
    onSuccess: (next) => {
      qc.setQueryData(qk.cloud, next);
      setStarted(true);
      const page = approvalUrl(next);
      if (page) void openExternal(page);
    },
  });

  useEffect(() => {
    if (!open) return;
    link.reset();
    setStarted(status?.state === "linking");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const view = status?.state === "linking" && status.pending ? "pending" : started && status && isLinked(status) ? "linked" : "form";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-[560px]">
        <DialogHeader className="border-b px-6 pt-6 pb-5 text-left">
          <DialogTitle className="text-lg font-medium tracking-[-0.02em]">Connect to Godmode Cloud</DialogTitle>
          <DialogDescription>Open this computer in any browser and reach it from your phone, through your cloud account.</DialogDescription>
        </DialogHeader>

        <AnimatePresence mode="wait" initial={false}>
          {!status ? (
            <motion.div key="loading" className="grid place-items-center px-6 py-16 text-muted-foreground">
              <Spinner />
            </motion.div>
          ) : view === "linked" ? (
            <motion.div key="linked" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} className="flex flex-col items-center px-6 pt-10 pb-8 text-center">
              <div className="grid size-14 place-items-center rounded-full bg-brand-soft text-brand-strong">
                <DrawCheck className="size-7" />
              </div>
              <h3 className="mt-5 text-lg font-medium tracking-[-0.02em]">Linked to {status.account?.email ?? hostOf(status.url)}</h3>
              <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
                Sign in to {hostOf(status.url)} in any browser to open this computer. You can change what the cloud may do in Settings → Cloud.
              </p>
              <div className="mt-7 flex flex-wrap justify-center gap-2">
                <Button onClick={() => onOpenChange(false)}>Done</Button>
                <Button variant="ghost" className="text-muted-foreground" onClick={() => setConfirmUnlink(true)} disabled={unlink.isPending}>
                  {unlink.isPending && <Spinner />} Unlink
                </Button>
              </div>
            </motion.div>
          ) : view === "pending" ? (
            <PendingLink
              key="pending"
              status={status}
              onRetry={() => status.url && link.mutate(status.url)}
              retrying={link.isPending}
              onCancel={() => unlink.mutate(undefined, { onSuccess: () => onOpenChange(false) })}
              cancelling={unlink.isPending}
            />
          ) : (
            <LinkForm
              key="form"
              status={status}
              error={link.isError ? errorMessage(link.error) : started && status.state === "unlinked" ? status.error : null}
              pending={link.isPending}
              onSubmit={(url) => link.mutate(url)}
              onCancel={() => onOpenChange(false)}
            />
          )}
        </AnimatePresence>

        <UnlinkCloudDialog
          open={confirmUnlink}
          onOpenChange={setConfirmUnlink}
          onConfirm={() =>
            unlink.mutate(undefined, {
              onSuccess: () => {
                onOpenChange(false);
                toast.success("Unlinked from Godmode Cloud");
              },
            })
          }
        />
      </DialogContent>
    </Dialog>
  );
}

function LinkForm({
  status,
  error,
  pending,
  onSubmit,
  onCancel,
}: {
  status: CloudStatus | undefined;
  error: string | null;
  pending: boolean;
  onSubmit: (url: string) => void;
  onCancel: () => void;
}) {
  // A computer removed in the cloud links again to the same address; otherwise the default address, if any.
  const preset = status?.url ?? status?.defaultUrl ?? "";
  const [value, setValue] = useState(preset);
  const [custom, setCustom] = useState(!preset);
  const url = normalizeCloudUrl(value);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (url && !pending) onSubmit(url);
  };

  return (
    <motion.form initial={{ opacity: 0 }} animate={{ opacity: 1 }} onSubmit={submit} className="space-y-5 px-6 py-6">
      {custom ? (
        <div className="space-y-1.5">
          <Label htmlFor="cloud-url">Cloud address</Label>
          <Input
            id="cloud-url"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="https://cloud.example.com"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            autoFocus
            aria-invalid={!!error || undefined}
            className="text-base md:text-sm"
          />
          <p className="text-xs text-muted-foreground">The address of your Godmode Cloud. It is shown on the Computers page there.</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-paper-2 px-3.5 py-3">
          <Cloud className="size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">Cloud</p>
            <p className="truncate font-mono text-[13px]">{hostOf(url)}</p>
          </div>
          <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setCustom(true)}>
            Use a different cloud
          </Button>
        </div>
      )}

      <Callout tone="warning" icon={<ShieldAlert className="text-warning" />}>
        Only connect to a cloud you trust. It relays, and can see, everything you do through it.
      </Callout>

      <ol className="space-y-4">
        <Step n={1} title="Connect">
          Godmode opens the cloud in your browser with a short code.
        </Step>
        <Step n={2} title="Approve in the browser">
          Sign in and check that the cloud shows the same code as this window.
        </Step>
        <Step n={3} title="Open it anywhere">
          This computer appears under Computers in the cloud, ready to open in any browser.
        </Step>
      </ol>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!url || pending}>
          {pending ? <Spinner /> : <Cloud />} {pending ? "Connecting…" : "Connect"}
        </Button>
      </div>
    </motion.form>
  );
}

function PendingLink({
  status,
  onRetry,
  retrying,
  onCancel,
  cancelling,
}: {
  status: CloudStatus;
  onRetry: () => void;
  retrying: boolean;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const now = useNow(1000);
  const pending = status.pending!;
  const page = approvalUrl(status);
  const remaining = Math.max(0, Math.round((new Date(pending.expiresAt).getTime() - now) / 1000));
  const expired = remaining === 0;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-5 px-6 py-6">
      <div className="flex flex-col items-center gap-3 rounded-xl border bg-paper-2 px-4 py-6 text-center">
        <p className="eyebrow">Code</p>
        <p className="font-mono text-[28px] leading-none font-medium tracking-[0.12em] tabular-nums">{pending.userCode}</p>
        {expired ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            The code expired.
            <Button variant="ghost" size="xs" className="text-foreground" onClick={onRetry} disabled={retrying}>
              {retrying ? <Spinner /> : <RefreshCw />} New code
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
            <ExpiryRing seconds={remaining} total={LINK_SECONDS} />
            Expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
          </div>
        )}
      </div>

      <p className="text-sm text-muted-foreground">
        Approve this computer in your browser. Only approve if the cloud shows exactly this code.
      </p>

      <div className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5 text-xs text-muted-foreground shadow-card">
        <Cloud className="size-4 shrink-0 text-foreground" />
        <span className="min-w-0">
          Waiting for approval on <span className="font-mono text-[11px] text-foreground">{hostOf(status.url)}</span>
        </span>
        <span className="ml-auto flex gap-1" aria-hidden>
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="size-1 rounded-full bg-muted-foreground"
              animate={{ opacity: [0.25, 1, 0.25] }}
              transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
            />
          ))}
        </span>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={cancelling}>
          {cancelling && <Spinner />} Cancel linking
        </Button>
        {page && !expired && (
          <Button variant="outline" onClick={() => void openExternal(page)}>
            <ExternalLink /> Open the approval page
          </Button>
        )}
      </div>
    </motion.div>
  );
}
