import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { formatDistanceToNow } from "date-fns";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CaptchaSolver } from "@godmode/shared";
import { ArrowRight, AudioLines, Boxes, BrainCircuit, Check, CircleDashed, CircleCheck, Cloud, ExternalLink, KeyRound, Mic, Pencil, Puzzle, ShieldCheck, Sparkles, Trash2, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { PasswordInput } from "@/components/vault/password-input";
import { toastApiError } from "@/components/vault/vault-utils";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/language";
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

export const knownKeys = (): KeyMeta[] => [
  {
    key: "anthropic_api_key",
    label: t("integrations:apiKeys.keyLabel", { name: "Anthropic" }),
    description: t("integrations:apiKeys.descriptions.anthropic"),
    icon: BrainCircuit,
    link: { href: "https://console.anthropic.com/settings/keys", label: "console.anthropic.com" },
    placeholder: "sk-ant-…",
    optional: true,
  },
  {
    key: "zai_api_key",
    label: t("integrations:apiKeys.keyLabel", { name: "Z.ai" }),
    description: t("integrations:apiKeys.descriptions.zai"),
    icon: Sparkles,
    link: { href: "https://z.ai/manage-apikey/apikey-list", label: "z.ai" },
    optional: true,
  },
  {
    key: "openai_api_key",
    label: t("integrations:apiKeys.keyLabel", { name: "OpenAI" }),
    description: t("integrations:apiKeys.descriptions.openai"),
    icon: Mic,
    link: { href: "https://platform.openai.com/api-keys", label: "platform.openai.com" },
    placeholder: "sk-…",
  },
  {
    key: "elevenlabs_api_key",
    label: t("integrations:apiKeys.keyLabel", { name: "ElevenLabs" }),
    description: t("integrations:apiKeys.descriptions.elevenlabs"),
    icon: AudioLines,
    link: { href: "https://elevenlabs.io/app/settings/api-keys", label: "elevenlabs.io" },
  },
  {
    key: "browser_use_api_key",
    label: t("integrations:apiKeys.keyLabel", { name: "browser-use Cloud" }),
    description: t("integrations:apiKeys.descriptions.browserUse"),
    icon: Cloud,
    link: { href: "https://cloud.browser-use.com", label: "cloud.browser-use.com" },
    placeholder: "bu_…",
  },
  ...[
    { key: "twocaptcha_api_key", label: t("integrations:apiKeys.keyLabel", { name: "2Captcha" }), link: { href: "https://2captcha.com/enterpage", label: "2captcha.com" } },
    { key: "capsolver_api_key", label: t("integrations:apiKeys.keyLabel", { name: "CapSolver" }), link: { href: "https://dashboard.capsolver.com", label: "capsolver.com" }, placeholder: "CAP-…" },
    { key: "anticaptcha_api_key", label: t("integrations:apiKeys.keyLabel", { name: "Anti-Captcha" }), link: { href: "https://anti-captcha.com/clients/settings/apisetup", label: "anti-captcha.com" } },
  ].map((k) => ({ ...k, description: t("integrations:apiKeys.descriptions.captcha"), icon: Puzzle, optional: true })),
  {
    key: "composio_api_key",
    label: t("integrations:apiKeys.keyLabel", { name: "Composio" }),
    description: t("integrations:apiKeys.descriptions.composio"),
    icon: Boxes,
    managedIn: "composio",
  },
];

type SecretRow = { key: string; set: boolean; updatedAt: string | null };

const CAPTCHA_SOLVER_OF: Record<string, { id: CaptchaSolver; label: string }> = {
  twocaptcha_api_key: { id: "2captcha", label: "2Captcha" },
  capsolver_api_key: { id: "capsolver", label: "CapSolver" },
  anticaptcha_api_key: { id: "anticaptcha", label: "Anti-Captcha" },
};

/** A solver key saved while CAPTCHA solving is off turns that solver on: a key alone would do nothing. */
async function selectSolverForKey(key: string): Promise<string | null> {
  const solver = CAPTCHA_SOLVER_OF[key];
  if (!solver) return null;
  const settings = await api.settings.get();
  if (settings.browser.captchaSolver !== "off") return null;
  await api.settings.update({ browser: { captchaSolver: solver.id } });
  return solver.label;
}

/** App-level API keys stored in the vault. Values are write-only. */
export function ApiKeysTab({ onOpenComposio, onOpenTools }: { onOpenComposio: () => void; onOpenTools: () => void }) {
  const { t } = useTranslation("integrations");
  const known = knownKeys();
  const secrets = useQuery({ queryKey: qk.appSecrets, queryFn: api.vault.secrets.list });
  const byKey = new Map((secrets.data ?? []).map((s) => [s.key, s] as const));
  const unknown = (secrets.data ?? []).filter((s) => !known.some((k) => k.key === s.key));

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-xl border border-brand/25 bg-brand-soft p-4">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-brand-strong" />
        <div className="text-sm">
          <p className="font-medium">{t("apiKeys.encryptedTitle")}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("apiKeys.encryptedDescription")}</p>
        </div>
      </div>

      <button
        type="button"
        onClick={onOpenTools}
        className="group flex w-full items-center gap-3 rounded-xl border border-dashed bg-card/60 p-4 text-left transition hover:border-foreground/20 hover:bg-card"
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-paper-2">
          <Wrench className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t("apiKeys.agentApiTitle")}</span>
          <span className="block text-xs text-muted-foreground">{t("apiKeys.agentApiDescription")}</span>
        </span>
        <ArrowRight className="size-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground" />
      </button>

      {secrets.isError ? (
        <QueryError error={secrets.error} onRetry={() => secrets.refetch()} title={t("apiKeys.loadError")} />
      ) : secrets.isLoading ? (
        <div className="space-y-2">
          {known.map((k) => (
            <Skeleton key={k.key} className="h-[84px] rounded-xl" />
          ))}
        </div>
      ) : (
        <ul className="space-y-2">
          {known.map((meta, i) => (
            <motion.li key={meta.key} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 12) * 0.03 }}>
              <KeyRow meta={meta} state={byKey.get(meta.key)} onOpenComposio={onOpenComposio} />
            </motion.li>
          ))}
          {unknown.map((s, i) => (
            <motion.li key={s.key} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i + known.length, 12) * 0.03 }}>
              <KeyRow meta={{ key: s.key, label: s.key, description: t("apiKeys.customSecret"), icon: KeyRound }} state={s} onOpenComposio={onOpenComposio} />
            </motion.li>
          ))}
        </ul>
      )}
    </div>
  );
}

function KeyRow({ meta, state, onOpenComposio }: { meta: KeyMeta; state: SecretRow | undefined; onOpenComposio: () => void }) {
  const { t } = useTranslation(["integrations", "common"]);
  const { dateLocale } = useLocale();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [confirm, setConfirm] = useState(false);
  const isSet = !!state?.set;

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: qk.appSecrets });
    if (meta.key === "composio_api_key") void qc.invalidateQueries({ queryKey: qk.composio });
    if (meta.key === "browser_use_api_key") void qc.invalidateQueries({ queryKey: ["browser", "profile-use"] });
    if (CAPTCHA_SOLVER_OF[meta.key]) void qc.invalidateQueries({ queryKey: qk.captcha });
  };

  const save = useMutation({
    mutationFn: async (v: string) => {
      await api.vault.secrets.set(meta.key, v);
      return selectSolverForKey(meta.key).catch(() => null);
    },
    onSuccess: (solver) => {
      toast.success(t("apiKeys.saved", { label: meta.label }), solver ? { description: t("apiKeys.solverSelected", { solver }) } : undefined);
      if (solver) void qc.invalidateQueries({ queryKey: qk.settings });
      setValue("");
      setEditing(false);
      invalidate();
    },
    onError: (e) => toastApiError(e, t("apiKeys.saveFailed", { label: meta.label }), qc),
  });
  const remove = useMutation({
    mutationFn: () => api.vault.secrets.delete(meta.key),
    onSuccess: () => {
      toast.success(t("apiKeys.removed", { label: meta.label }));
      invalidate();
    },
    onError: (e) => toastApiError(e, t("apiKeys.removeFailed", { label: meta.label }), qc),
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
                <CircleCheck />{" "}
                {state?.updatedAt
                  ? t("apiKeys.setUpdated", { ago: formatDistanceToNow(new Date(state.updatedAt), { addSuffix: true, locale: dateLocale }) })
                  : t("apiKeys.set")}
              </Badge>
            ) : (
              <Badge variant="outline" className="h-5 gap-1 text-[10px] font-normal text-muted-foreground">
                <CircleDashed /> {t("apiKeys.notSet")}
              </Badge>
            )}
            {meta.optional && !isSet && (
              <Badge variant="secondary" className="h-5 text-[10px] font-normal">
                {t("common:words.optional")}
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
              {t("apiKeys.getKeyAt", { site: meta.link.label })} <ExternalLink className="size-3" />
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {meta.managedIn === "composio" ? (
            <Button size="sm" variant="outline" onClick={onOpenComposio}>
              {t("apiKeys.manageInComposio")} <ArrowRight />
            </Button>
          ) : !editing ? (
            <>
              <Button size="sm" variant={isSet ? "outline" : "secondary"} onClick={() => setEditing(true)}>
                {isSet ? <Pencil /> : <KeyRound />} {isSet ? t("composioKey.replace") : t("apiKeys.setKey")}
              </Button>
              {isSet && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={t("keyValue.removeAria", { key: meta.label })}
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
                placeholder={meta.placeholder ?? t("apiKeys.pasteKey")}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoFocus
                groupClassName="flex-1"
                onKeyDown={(e) => e.key === "Escape" && (setEditing(false), setValue(""))}
              />
              <div className="flex gap-2">
                <Button type="submit" className="h-10" disabled={!value.trim() || save.isPending}>
                  {save.isPending ? <Spinner /> : <Check />} {t("common:actions.save")}
                </Button>
                <Button type="button" variant="ghost" className="h-10" onClick={() => (setEditing(false), setValue(""))}>
                  {t("common:actions.cancel")}
                </Button>
              </div>
            </div>
          </motion.form>
        )}
      </AnimatePresence>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("mcp.removeTitle", { name: meta.label })}
        description={t("apiKeys.removeDescription")}
        confirmLabel={t("common:actions.remove")}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}
