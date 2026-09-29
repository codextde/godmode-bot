import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { formatDistanceToNow } from "date-fns";
import type { LucideIcon } from "lucide-react";
import { ArrowRight, AudioLines, Boxes, BrainCircuit, Check, CircleDashed, CircleCheck, Cloud, ExternalLink, KeyRound, Mic, Pencil, ShieldCheck, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { PasswordInput } from "@/components/vault/password-input";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { openExternal } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { ConfirmDialog } from "./confirm-dialog";
import { QueryError } from "./query-error";

interface KeyMeta {
  key: string;
  label: string;
  description: string;
  icon: LucideIcon;
  link?: { href: string; label: string };
  placeholder?: string;
  optional?: boolean;
  /** Managed elsewhere (e.g. the Composio tab) */
  managedIn?: "composio";
}

export const KNOWN_KEYS: KeyMeta[] = [
  {
    key: "anthropic_api_key",
    label: "Anthropic API key",
    description: "Optional — otherwise your Claude Code login is used. Set it to bill runs to an API account instead.",
    icon: BrainCircuit,
    link: { href: "https://console.anthropic.com/settings/keys", label: "console.anthropic.com" },
    placeholder: "sk-ant-…",
    optional: true,
  },
  {
    key: "openai_api_key",
    label: "OpenAI API key",
    description: "Voice: speech-to-text and natural text-to-speech when the OpenAI voice provider is selected.",
    icon: Mic,
    link: { href: "https://platform.openai.com/api-keys", label: "platform.openai.com" },
    placeholder: "sk-…",
  },
  {
    key: "elevenlabs_api_key",
    label: "ElevenLabs API key",
    description: "Voice: premium text-to-speech voices when ElevenLabs is selected.",
    icon: AudioLines,
    link: { href: "https://elevenlabs.io/app/settings/api-keys", label: "elevenlabs.io" },
  },
  {
    key: "browser_use_api_key",
    label: "browser-use Cloud API key",
    description: "Lets profile-use sync your Chrome cookies to a browser-use Cloud profile.",
    icon: Cloud,
    link: { href: "https://cloud.browser-use.com", label: "cloud.browser-use.com" },
    placeholder: "bu_…",
  },
  {
    key: "composio_api_key",
    label: "Composio API key",
    description: "Connects hundreds of apps through Composio.",
    icon: Boxes,
    managedIn: "composio",
  },
];

type SecretRow = { key: string; set: boolean; updatedAt: string | null };

/** App-level API keys stored in the vault. Values are write-only. */
export function ApiKeysTab({ onOpenComposio }: { onOpenComposio: () => void }) {
  const secrets = useQuery({ queryKey: qk.appSecrets, queryFn: api.vault.secrets.list });
  const byKey = new Map((secrets.data ?? []).map((s) => [s.key, s] as const));
  const unknown = (secrets.data ?? []).filter((s) => !KNOWN_KEYS.some((k) => k.key === s.key));

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-xl border border-brand/25 bg-brand-soft p-4">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-brand-strong" />
        <div className="text-sm">
          <p className="font-medium">Encrypted, write-only</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Keys are sealed in your vault with AES-256-GCM and are never displayed again. Godmode injects them where they're needed — agents
            don't see them.
          </p>
        </div>
      </div>

      {secrets.isError ? (
        <QueryError error={secrets.error} onRetry={() => secrets.refetch()} title="Couldn't load API keys" />
      ) : secrets.isLoading ? (
        <div className="space-y-2">
          {KNOWN_KEYS.map((k) => (
            <Skeleton key={k.key} className="h-[84px] rounded-xl" />
          ))}
        </div>
      ) : (
        <ul className="space-y-2">
          {KNOWN_KEYS.map((meta, i) => (
            <motion.li key={meta.key} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 12) * 0.03 }}>
              <KeyRow meta={meta} state={byKey.get(meta.key)} onOpenComposio={onOpenComposio} />
            </motion.li>
          ))}
          {unknown.map((s, i) => (
            <motion.li key={s.key} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i + KNOWN_KEYS.length, 12) * 0.03 }}>
              <KeyRow meta={{ key: s.key, label: s.key, description: "Custom secret", icon: KeyRound }} state={s} onOpenComposio={onOpenComposio} />
            </motion.li>
          ))}
        </ul>
      )}
    </div>
  );
}

function KeyRow({ meta, state, onOpenComposio }: { meta: KeyMeta; state: SecretRow | undefined; onOpenComposio: () => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [confirm, setConfirm] = useState(false);
  const isSet = !!state?.set;

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: qk.appSecrets });
    if (meta.key === "composio_api_key") void qc.invalidateQueries({ queryKey: qk.composio });
    if (meta.key === "browser_use_api_key") void qc.invalidateQueries({ queryKey: ["browser", "profile-use"] });
  };

  const save = useMutation({
    mutationFn: (v: string) => api.vault.secrets.set(meta.key, v),
    onSuccess: () => {
      toast.success(`${meta.label} saved`);
      setValue("");
      setEditing(false);
      invalidate();
    },
    onError: (e) => toastApiError(e, `Couldn't save ${meta.label}`, qc),
  });
  const remove = useMutation({
    mutationFn: () => api.vault.secrets.delete(meta.key),
    onSuccess: () => {
      toast.success(`${meta.label} removed`);
      invalidate();
    },
    onError: (e) => toastApiError(e, `Couldn't remove ${meta.label}`, qc),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) save.mutate(value.trim());
  };

  return (
    <div className="rounded-xl border bg-card p-4 shadow-card transition hover:border-foreground/15">
      <div className="flex flex-wrap items-start gap-3.5">
        <div className={cn("grid size-10 shrink-0 place-items-center rounded-lg border", isSet ? "bg-card text-foreground shadow-card" : "bg-paper-2 text-muted-foreground")}>
          <meta.icon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium tracking-[-0.01em]">{meta.label}</span>
            {isSet ? (
              <Badge variant="outline" className="h-5 gap-1 border-brand/25 bg-brand-soft text-[10px] text-brand-strong">
                <CircleCheck /> Set{state?.updatedAt ? ` · updated ${formatDistanceToNow(new Date(state.updatedAt), { addSuffix: true })}` : ""}
              </Badge>
            ) : (
              <Badge variant="outline" className="h-5 gap-1 text-[10px] font-normal text-muted-foreground">
                <CircleDashed /> Not set
              </Badge>
            )}
            {meta.optional && !isSet && (
              <Badge variant="secondary" className="h-5 text-[10px] font-normal">
                optional
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{meta.description}</p>
          {meta.link && (
            <button
              type="button"
              onClick={() => void openExternal(meta.link!.href)}
              className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-foreground underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground"
            >
              Get a key at {meta.link.label} <ExternalLink className="size-3" />
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {meta.managedIn === "composio" ? (
            <Button size="sm" variant="outline" onClick={onOpenComposio}>
              Manage in Composio tab <ArrowRight />
            </Button>
          ) : !editing ? (
            <>
              <Button size="sm" variant={isSet ? "outline" : "secondary"} onClick={() => setEditing(true)}>
                {isSet ? <Pencil /> : <KeyRound />} {isSet ? "Replace" : "Set key"}
              </Button>
              {isSet && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={`Remove ${meta.label}`}
                  onClick={() => setConfirm(true)}
                  disabled={remove.isPending}
                >
                  {remove.isPending ? <Spinner /> : <Trash2 />}
                </Button>
              )}
            </>
          ) : null}
        </div>
      </div>
      <AnimatePresence initial={false}>
        {editing && (
          <motion.form
            onSubmit={onSubmit}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-2 pt-3 @xl:flex-row @xl:pl-[3.375rem]">
              <PasswordInput
                aria-label={meta.label}
                placeholder={meta.placeholder ?? "Paste the key"}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoFocus
                groupClassName="flex-1"
                onKeyDown={(e) => e.key === "Escape" && (setEditing(false), setValue(""))}
              />
              <div className="flex gap-2">
                <Button type="submit" className="h-10" disabled={!value.trim() || save.isPending}>
                  {save.isPending ? <Spinner /> : <Check />} Save
                </Button>
                <Button type="button" variant="ghost" className="h-10" onClick={() => (setEditing(false), setValue(""))}>
                  Cancel
                </Button>
              </div>
            </div>
          </motion.form>
        )}
      </AnimatePresence>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Remove ${meta.label}?`}
        description="Features that depend on this key stop working until you add it again."
        confirmLabel="Remove"
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}
