import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { CircleCheck, ExternalLink, KeyRound, Pencil, RefreshCw, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
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
      if (!apiKey) toast.success("Composio key removed");
      else if (s.valid === false) toast.error("Composio rejected this key", { description: s.error ?? "Double-check it in your Composio dashboard." });
      else toast.success("Composio connected", { description: "Browse apps below and connect your accounts." });
    },
    onError: (e) => toastApiError(e, "Couldn't save the Composio key", qc),
  });

  const recheck = useMutation({
    mutationFn: api.composio.recheck,
    onSuccess: (s) => {
      qc.setQueryData(qk.composioStatus, s);
      if (s.valid === false) toast.error("Composio rejected this key", { description: s.error ?? undefined });
      else if (s.valid) toast.success("Key is valid");
    },
    onError: (e) => toastApiError(e, "Couldn't check the key", qc),
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
      aria-label="Composio API key"
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
            {!configured ? "Connect your Composio account" : invalid ? "Composio key isn't working" : "Composio is connected"}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {!configured ? (
              <>Paste an API key from your Composio dashboard (Settings → API keys). It's stored encrypted in your vault.</>
            ) : invalid ? (
              (status?.error ?? "The key was rejected. Replace it with a valid key.")
            ) : status?.valid === null ? (
              "Key saved — validation pending."
            ) : (
              <span className="inline-flex items-center gap-1">
                <ShieldCheck className="size-3.5 text-brand-strong" /> API key stored encrypted in your vault · never shown again
              </span>
            )}
          </p>
        </div>
        {configured && !editing && (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => recheck.mutate()} disabled={recheck.isPending} aria-label="Re-check Composio key">
              {recheck.isPending ? <Spinner /> : <RefreshCw />} Re-check
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              <Pencil /> Replace
            </Button>
            <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => setConfirmRemove(true)} aria-label="Remove Composio key">
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
            <div className="flex flex-col gap-2 pt-4 sm:flex-row">
              <PasswordInput
                aria-label="Composio API key"
                placeholder="ak_…"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                autoFocus={editing}
                groupClassName="flex-1"
              />
              <div className="flex gap-2">
                <Button type="submit" className="h-10" disabled={!key.trim() || save.isPending}>
                  {save.isPending ? <Spinner /> : <CircleCheck />} {save.isPending ? "Checking…" : "Save key"}
                </Button>
                {editing && (
                  <Button type="button" variant="ghost" className="h-10" onClick={() => (setEditing(false), setKey(""))}>
                    Cancel
                  </Button>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void openExternal(COMPOSIO_DASHBOARD)}
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              Get a free key at app.composio.dev <ExternalLink className="size-3" />
            </button>
          </motion.form>
        )}
      </AnimatePresence>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove the Composio key?"
        description="Agents lose access to every Composio app until you add a key again. Your connected accounts stay in Composio."
        confirmLabel="Remove key"
        onConfirm={() => save.mutate(null)}
      />
    </section>
  );
}
