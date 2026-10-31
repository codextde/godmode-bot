import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Lock, RefreshCw, ShieldAlert } from "lucide-react";
import type { Routine } from "@godmode/shared";
import { api } from "@/lib/api";
import { cloudContext, coreUrl } from "@/lib/core";
import { qk } from "@/lib/queryKeys";
import { CopyButton } from "@/components/chat/copy-button";
import { ConfirmDialog } from "@/components/integrations/confirm-dialog";
import { toastApiError } from "@/components/vault/vault-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";

const SAMPLE_BODY = '{"event": "checkout.abandoned", "items": 2, "total": 128}';

function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** Issue a new secret URL for a webhook automation; the old one stops working immediately. */
export function useRotateWebhook() {
  const { t } = useTranslation("automations");
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (routine: Routine) => api.routines.rotateWebhook(routine.id),
    onSuccess: ({ webhookPath }, routine) => {
      qc.setQueriesData<Routine[]>({ queryKey: qk.routines }, (old) =>
        Array.isArray(old) ? old.map((r) => (r.id === routine.id ? { ...r, webhookPath } : r)) : old,
      );
      qc.invalidateQueries({ queryKey: qk.routines });
      toast.success(t("webhook.rotated"), { description: t("webhook.rotatedDescription") });
    },
    onError: (err) => toastApiError(err, t("webhook.rotateFailed"), qc),
  });
}

/** Confirmation before rotating; shared by the automation's menu and the webhook panel. */
export function RotateWebhookDialog({
  routine,
  open,
  onOpenChange,
  onConfirm,
}: {
  routine: Routine;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation("automations");
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("webhook.rotateTitle", { name: routine.name })}
      description={t("webhook.rotateDescription")}
      confirmLabel={t("webhook.rotate")}
      onConfirm={onConfirm}
    />
  );
}

/** The secret URL of a webhook automation: copy it, see how to call it, rotate it. */
export function WebhookPanel({ routine }: { routine: Routine }) {
  const { t } = useTranslation("automations");
  const [confirm, setConfirm] = useState(false);
  // The dialog holds a snapshot of the routine; show a freshly rotated path right away.
  const [rotated, setRotated] = useState<string | null>(null);
  const rotate = useRotateWebhook();
  const path = rotated ?? routine.webhookPath;

  if (!path) {
    return (
      <div className="flex items-start gap-3 rounded-lg border bg-card p-3 text-sm shadow-card">
        <Lock className="mt-0.5 size-4 shrink-0 text-warning" />
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">{t("webhook.locked")}</span> {t("webhook.lockedHint")}
        </p>
      </div>
    );
  }

  // Through Godmode Cloud the page's address is the cloud's, which doesn't receive webhooks: show only the path.
  const remote = !!cloudContext;
  const url = remote ? path : coreUrl(path);
  const curl = `curl -X POST '${url}' \\\n  -H 'content-type: application/json' \\\n  -d '${SAMPLE_BODY}'`;

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="webhook-url" className="text-xs font-normal text-muted-foreground">
          {remote ? t("webhook.secretPathLabel") : t("webhook.secretUrlLabel")}
        </Label>
        <div className="flex items-center gap-1.5">
          <Input
            id="webhook-url"
            value={url}
            readOnly
            spellCheck={false}
            onFocus={(e) => e.currentTarget.select()}
            className="h-9 font-mono text-xs"
          />
          {!remote && <CopyButton text={url} label={t("webhook.copyUrl")} size="icon-sm" className="shrink-0" />}
        </div>
        {remote && <p className="text-xs text-muted-foreground">{t("webhook.remoteHint")}</p>}
      </div>

      {!remote && (
        <div className="rounded-lg border bg-card shadow-card">
          <div className="flex items-center justify-between border-b px-3 py-1.5">
            <span className="eyebrow">{t("webhook.tryIt")}</span>
            <CopyButton text={curl} label={t("webhook.copyCurl")} />
          </div>
          <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[11px] leading-relaxed text-foreground/85">{curl}</pre>
        </div>
      )}

      {!remote && isLocalUrl(url) && (
        <p className="text-xs text-muted-foreground">
          {t("webhook.localOnly")}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/25 bg-warning/[0.06] px-3 py-2.5 text-xs">
        <ShieldAlert className="size-4 shrink-0 text-warning" />
        <span className="min-w-0 flex-1 text-muted-foreground">{t("webhook.warning")}</span>
        <Button type="button" size="xs" variant="outline" onClick={() => setConfirm(true)} disabled={rotate.isPending}>
          {rotate.isPending ? <Spinner /> : <RefreshCw />} {t("webhook.rotate")}
        </Button>
      </div>

      <RotateWebhookDialog
        routine={routine}
        open={confirm}
        onOpenChange={setConfirm}
        onConfirm={() => rotate.mutate(routine, { onSuccess: (res) => setRotated(res.webhookPath) })}
      />
    </div>
  );
}
