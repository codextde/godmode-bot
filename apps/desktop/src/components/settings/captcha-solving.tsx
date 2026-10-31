import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { CircleCheck, CircleDashed, ExternalLink, KeyRound, Pencil, Puzzle, RotateCw, Wallet } from "lucide-react";
import type { BrowserSettings, CaptchaSolver } from "@godmode/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { PasswordInput } from "@/components/vault/password-input";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { openExternal } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { NumberField, SettingRow, SettingsGroup, useSettingsPatch } from "./settings-kit";

const SOLVERS: Record<Exclude<CaptchaSolver, "off">, { label: string; keyUrl: string; site: string; placeholder?: string }> = {
  "2captcha": { label: "2Captcha", keyUrl: "https://2captcha.com/enterpage", site: "2captcha.com" },
  capsolver: { label: "CapSolver", keyUrl: "https://dashboard.capsolver.com", site: "capsolver.com", placeholder: "CAP-…" },
  anticaptcha: { label: "Anti-Captcha", keyUrl: "https://anti-captcha.com/clients/settings/apisetup", site: "anti-captcha.com" },
};

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Settings → Browser: the service agents send CAPTCHAs to, its key and a daily cap. */
export function CaptchaSolving({ browser }: { browser: BrowserSettings }) {
  const qc = useQueryClient();
  const { patchAsync } = useSettingsPatch();
  const status = useQuery({ queryKey: qk.captcha, queryFn: api.browser.captcha, staleTime: 30_000 });
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const solver = browser.captchaSolver;
  const meta = solver === "off" ? null : SOLVERS[solver];
  const hasKey = !!status.data?.hasApiKey && status.data.solver === solver;
  const secretKey = status.data?.solver === solver ? status.data.secretKey : null;

  const balance = useMutation({
    mutationFn: api.browser.captchaBalance,
    onError: (e) => toastApiError(e, "Couldn't check the balance", qc),
  });

  const save = useMutation({
    mutationFn: (key: string) => api.vault.secrets.set(secretKey!, key),
    onSuccess: async () => {
      toast.success(`${meta?.label} key saved`);
      setValue("");
      setEditing(false);
      void qc.invalidateQueries({ queryKey: qk.appSecrets });
      await qc.invalidateQueries({ queryKey: qk.captcha });
      balance.mutate();
    },
    onError: (e) => toastApiError(e, "Couldn't save the key", qc),
  });

  const pick = (next: CaptchaSolver) => {
    setEditing(false);
    setValue("");
    balance.reset();
    patchAsync({ browser: { captchaSolver: next } })
      .catch(() => {})
      .finally(() => void qc.invalidateQueries({ queryKey: qk.captcha }));
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim() && secretKey) save.mutate(value.trim());
  };

  const used = status.data?.solvedToday ?? 0;
  const limit = browser.captchaDailyLimit;

  return (
    <SettingsGroup
      title="CAPTCHA solving"
      icon={<Puzzle />}
      description="When an agent hits a CAPTCHA, Godmode sends it to a solving service and puts the answer into the page. Agents never solve CAPTCHAs themselves."
    >
      <SettingRow
        label="Solving service"
        htmlFor="captcha-solver"
        disabled={!browser.enabled}
        description="Pay as you go, about $1 to $3 per 1,000 CAPTCHAs. Off: agents hand CAPTCHAs to you."
      >
        <Select value={solver} onValueChange={(v) => pick(v as CaptchaSolver)} disabled={!browser.enabled}>
          <SelectTrigger id="captcha-solver" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            <SelectItem value="off">Off</SelectItem>
            <SelectSeparator />
            {Object.entries(SOLVERS).map(([id, s]) => (
              <SelectItem key={id} value={id}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>

      <AnimatePresence initial={false}>
        {meta && (
          <motion.div key="solver" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="divide-y overflow-hidden">
            <div className="py-4">
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5">
                <div className="min-w-0 grow basis-56 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{meta.label} API key</span>
                    {status.isLoading ? null : hasKey ? (
                      <Badge variant="outline" className="h-5 gap-1 border-brand/25 bg-brand-soft text-[10px] text-brand-strong">
                        <CircleCheck /> Set
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="h-5 gap-1 text-[10px] font-normal text-muted-foreground">
                        <CircleDashed /> Not set
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Sealed in your vault; agents never see it.{" "}
                    <button
                      type="button"
                      onClick={() => void openExternal(meta.keyUrl)}
                      className="inline-flex items-center gap-1 font-medium text-foreground underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground"
                    >
                      Get a key at {meta.site} <ExternalLink className="size-3" />
                    </button>
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {hasKey && (
                    <button
                      type="button"
                      onClick={() => balance.mutate()}
                      disabled={balance.isPending}
                      className={cn(
                        "inline-flex h-8 items-center gap-1.5 rounded-lg border bg-paper-2 px-2.5 text-xs tabular-nums transition hover:border-foreground/20",
                        balance.data && balance.data.balance < 1 && "border-warning/40 text-warning",
                      )}
                      aria-label="Check the balance"
                    >
                      <Wallet className="size-3.5 text-muted-foreground" />
                      {balance.isPending ? <Spinner className="size-3" /> : balance.data ? usd(balance.data.balance) : "Balance"}
                      <RotateCw className="size-3 text-muted-foreground" />
                    </button>
                  )}
                  {!editing && (
                    <Button size="sm" variant={hasKey ? "outline" : "secondary"} onClick={() => setEditing(true)} disabled={!secretKey}>
                      {hasKey ? <Pencil /> : <KeyRound />} {hasKey ? "Replace" : "Set key"}
                    </Button>
                  )}
                </div>
              </div>
              <AnimatePresence initial={false}>
                {editing && (
                  <motion.form onSubmit={onSubmit} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                    <div className="flex flex-col gap-2 pt-3 @xl:flex-row">
                      <PasswordInput
                        aria-label={`${meta.label} API key`}
                        placeholder={meta.placeholder ?? "Paste the key"}
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        autoFocus
                        groupClassName="flex-1"
                        onKeyDown={(e) => e.key === "Escape" && (setEditing(false), setValue(""))}
                      />
                      <div className="flex gap-2">
                        <Button type="button" variant="ghost" size="sm" className="h-9" onClick={() => (setEditing(false), setValue(""))}>
                          Cancel
                        </Button>
                        <Button type="submit" size="sm" className="h-9" disabled={!value.trim() || save.isPending}>
                          {save.isPending && <Spinner />} Save key
                        </Button>
                      </div>
                    </div>
                  </motion.form>
                )}
              </AnimatePresence>
            </div>

            <SettingRow
              label="Daily limit"
              htmlFor="captcha-limit"
              description={
                <>
                  Most CAPTCHAs sent to {meta.label} per day, across all agents. 0 means no limit.{" "}
                  <span className="tabular-nums text-foreground">
                    {used} {used === 1 ? "solve" : "solves"} today
                  </span>
                </>
              }
            >
              <div className="flex items-center gap-3">
                {limit > 0 && (
                  <div className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-secondary @xl:block" aria-hidden>
                    <div className={cn("h-full rounded-full bg-brand transition-all calm-motion:transition-[width,background-color]", used >= limit && "bg-warning")} style={{ width: `${Math.min(100, (used / limit) * 100)}%` }} />
                  </div>
                )}
                <NumberField
                  id="captcha-limit"
                  min={0}
                  max={10_000}
                  suffix="per day"
                  value={limit}
                  onCommit={(v) => v !== null && patchAsync({ browser: { captchaDailyLimit: v } }).catch(() => {})}
                />
              </div>
            </SettingRow>

            <p className="py-3.5 text-xs leading-relaxed text-muted-foreground">
              Solves reCAPTCHA v2 and v3, Cloudflare Turnstile and image CAPTCHAs. hCaptcha and Cloudflare &ldquo;Just a moment&rdquo; pages still come to you as a task.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </SettingsGroup>
  );
}
