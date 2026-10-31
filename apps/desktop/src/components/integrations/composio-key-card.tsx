import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { CircleCheck, ExternalLink, KeyRound, Pencil, RefreshCw, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ComposioStatus } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { PasswordInput } from "@/components/vault/password-input";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { openExternal } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { ConfirmDialog } from "./confirm-dialog";

export const COMPOSIO_DASHBOARD = "https://app.composio.dev";

/** Composio API key: status, save/replace (validated server side) and removal. */
export function ComposioKeyCard({ status, loading }: { status: ComposioStatus | undefined; loading: boolean }) {
  const { t } = useTranslation(["integrations", "common"]);
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);

  const save = useMutation({
    mutationFn: (apiKey: string | null) => api.composio.setKey(apiKey),
    onSuccess: (s, apiKey) => {
      qc.setQueryData(qk.composioStatus, s);
      void qc.invalidateQueries({ queryKey: qk.composio });
      void qc.invalidateQueries({ queryKey: qk.appSecrets });
      void qc.invalidateQueries({ queryKey: qk.mcpServers });
      setKey("");
      setEditing(false);
      if (!apiKey) toast.success(t("composioKey.removed"));
      else if (s.valid === false) toast.error(t("composioKey.rejected"), { description: s.error ?? t("composioKey.rejectedHint") });
      else toast.success(t("composioKey.connected"), { description: t("composioKey.connectedHint") });
    },
    onError: (e) => toastApiError(e, t("composioKey.saveFailed"), qc),
  });

  const recheck = useMutation({
    mutationFn: api.composio.recheck,
    onSuccess: (s) => {
      qc.setQueryData(qk.composioStatus, s);
      if (s.valid === false) toast.error(t("composioKey.rejected"), { description: s.error ?? undefined });
      else if (s.valid) toast.success(t("composioKey.valid"));
    },
    onError: (e) => toastApiError(e, t("composioKey.checkFailed"), qc),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (key.trim()) save.mutate(key.trim());
  };

  if (loading) return <Skeleton className="h-24 rounded-xl" />;

  const configured = !!status?.configured;
  const invalid = configured && status?.valid === false;
  const showForm = !configured || editing;

  return (
    <section
      className={cn(
        "relative overflow-hidden rounded-xl border bg-card p-5 shadow-card",
        invalid && "border-destructive/30",
        configured && !invalid && "border-brand/25",
      )}
      aria-label={t("composioKey.label")}
    >
      <div className="flex flex-wrap items-start gap-4">
        <div
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-lg border",
            !configured && "bg-card text-foreground shadow-card",
            configured && !invalid && "border-brand/25 bg-brand-soft text-brand-strong",
            invalid && "border-destructive/20 bg-destructive/[0.06] text-destructive",
          )}
        >
          {invalid ? <TriangleAlert className="size-5" /> : configured ? <CircleCheck className="size-5" /> : <KeyRound className="size-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] leading-snug font-medium tracking-[-0.01em]">
            {!configured ? t("composioKey.connectTitle") : invalid ? t("composioKey.invalidTitle") : t("composioKey.connectedTitle")}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {!configured ? (
              <>{t("composioKey.pasteHint")}</>
            ) : invalid ? (
              (status?.error ?? t("composioKey.rejectedReplace"))
            ) : status?.valid === null ? (
              t("composioKey.pending")
            ) : (
              <span className="inline-flex items-center gap-1">
                <ShieldCheck className="size-3.5 text-brand-strong" /> {t("composioKey.stored")}
              </span>
            )}
          </p>
        </div>
        {configured && !editing && (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => recheck.mutate()} disabled={recheck.isPending} aria-label={t("composioKey.recheckAria")}>
              {recheck.isPending ? <Spinner /> : <RefreshCw />} {t("composioKey.recheck")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              <Pencil /> {t("composioKey.replace")}
            </Button>
            <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => setConfirmRemove(true)} aria-label={t("composioKey.removeAria")}>
              <Trash2 />
            </Button>
          </div>
        )}
      </div>

      <AnimatePresence initial={false}>
        {showForm && (
          <motion.form
            key="form"
            onSubmit={onSubmit}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-2 pt-4 @md:flex-row">
              <PasswordInput
                aria-label={t("composioKey.label")}
                placeholder="ak_…"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                autoFocus={editing}
                groupClassName="flex-1"
              />
              <div className="flex gap-2">
                <Button type="submit" className="h-10" disabled={!key.trim() || save.isPending}>
                  {save.isPending ? <Spinner /> : <CircleCheck />} {save.isPending ? t("composioKey.checking") : t("composioKey.save")}
                </Button>
                {editing && (
                  <Button type="button" variant="ghost" className="h-10" onClick={() => (setEditing(false), setKey(""))}>
                    {t("common:actions.cancel")}
                  </Button>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void openExternal(COMPOSIO_DASHBOARD)}
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              {t("composioKey.getKey")} <ExternalLink className="size-3" />
            </button>
          </motion.form>
        )}
      </AnimatePresence>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={t("composioKey.removeTitle")}
        description={t("composioKey.removeDescription")}
        confirmLabel={t("composioKey.removeConfirm")}
        onConfirm={() => save.mutate(null)}
      />
    </section>
  );
}
