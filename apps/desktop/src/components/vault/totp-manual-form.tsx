import { useId, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, KeyRound } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import type { TotpAlgorithm, TotpEntry } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { isValidBase32, normalizeBase32, parseOtpUri } from "@/lib/qr";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { PasswordInput } from "./password-input";
import { toastApiError } from "./vault-utils";

/** Enter a 2FA secret by hand (the "Can't scan it?" key most sites show next to the QR code). */
export function TotpManualForm({ workspaceId, onCreated }: { workspaceId: string | null; onCreated: (entry: TotpEntry) => void }) {
  const { t } = useTranslation("vault");
  const qc = useQueryClient();
  const uid = useId();
  const [issuer, setIssuer] = useState("");
  const [account, setAccount] = useState("");
  const [secret, setSecret] = useState("");
  const [algorithm, setAlgorithm] = useState<TotpAlgorithm>("SHA1");
  const [digits, setDigits] = useState(6);
  const [period, setPeriod] = useState(30);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const normalized = normalizeBase32(secret);
  const secretError = !secret.trim()
    ? t("totpManual.secretMissing")
    : !isValidBase32(secret)
      ? t("totpManual.secretInvalid")
      : null;
  const issuerError = !issuer.trim() ? t("totpManual.issuerMissing") : null;

  const create = useMutation({
    mutationFn: () =>
      api.totp.create({ workspaceId, issuer: issuer.trim(), accountName: account.trim(), secret: normalized, algorithm, digits, period }),
    onSuccess: (entry) => {
      void qc.invalidateQueries({ queryKey: qk.totp });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
      toast.success(t("totpManual.added", { name: entry.issuer }), { description: t("totpManual.addedDescription") });
      onCreated(entry);
    },
    onError: (e) => toastApiError(e, t("totpManual.addFailed"), qc),
  });

  /** Pasting a full otpauth:// link fills every field at once. */
  const onSecretChange = (value: string) => {
    if (/^otpauth:\/\//i.test(value.trim())) {
      const p = parseOtpUri(value);
      const s = /[?&]secret=([^&]+)/i.exec(value)?.[1];
      if (p.kind === "otpauth" && s) {
        setIssuer(p.preview.issuer === "Unknown" ? issuer : p.preview.issuer);
        setAccount(p.preview.account);
        setAlgorithm((["SHA1", "SHA256", "SHA512"].includes(p.preview.algorithm) ? p.preview.algorithm : "SHA1") as TotpAlgorithm);
        setDigits(p.preview.digits === 8 ? 8 : 6);
        setPeriod(p.preview.period || 30);
        setSecret(s.replace(/%20/g, ""));
        if (p.preview.algorithm !== "SHA1" || p.preview.digits !== 6 || p.preview.period !== 30) setAdvancedOpen(true);
        toast.success(t("totpManual.filledFromLink"));
        return;
      }
    }
    setSecret(value);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (secretError || issuerError) return;
    create.mutate();
  };

  const id = (s: string) => `${uid}-${s}`;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={id("issuer")}>{t("totpForm.service")}</Label>
          <Input id={id("issuer")} value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="GitHub" autoFocus aria-invalid={submitted && !!issuerError} />
          {submitted && issuerError && <p className="text-xs text-destructive">{issuerError}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor={id("account")}>{t("totpForm.account")}</Label>
          <Input id={id("account")} value={account} onChange={(e) => setAccount(e.target.value)} placeholder={t("totpManual.accountPlaceholder")} autoComplete="off" />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={id("secret")}>{t("totpManual.setupKey")}</Label>
        <PasswordInput
          id={id("secret")}
          value={secret}
          onChange={(e) => onSecretChange(e.target.value)}
          placeholder="JBSW Y3DP EHPK 3PXP…"
          leading={<KeyRound className="size-4" />}
          aria-invalid={submitted && !!secretError}
        />
        {submitted && secretError ? (
          <p className="text-xs text-destructive">{secretError}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            <Trans t={t} i18nKey="totpManual.setupKeyHint" components={{ code: <code className="font-mono" /> }} />
          </p>
        )}
      </div>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <button type="button" className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
            {t("totpManual.advanced")}
            <ChevronDown className={cn("size-3.5 transition-transform", advancedOpen && "rotate-180")} />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor={id("alg")}>{t("totpForm.algorithm")}</Label>
              <Select value={algorithm} onValueChange={(v) => setAlgorithm(v as TotpAlgorithm)}>
                <SelectTrigger id={id("alg")} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SHA1">{t("totpManual.withDefault", { value: "SHA-1" })}</SelectItem>
                  <SelectItem value="SHA256">SHA-256</SelectItem>
                  <SelectItem value="SHA512">SHA-512</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={id("digits")}>{t("totpForm.digits")}</Label>
              <Select value={String(digits)} onValueChange={(v) => setDigits(Number(v))}>
                <SelectTrigger id={id("digits")} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="6">{t("totpManual.withDefault", { value: "6" })}</SelectItem>
                  <SelectItem value="8">8</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={id("period")}>{t("totpForm.period")}</Label>
              <Select value={String(period)} onValueChange={(v) => setPeriod(Number(v))}>
                <SelectTrigger id={id("period")} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="30">{t("totpManual.withDefault", { value: "30 s" })}</SelectItem>
                  <SelectItem value="60">60 s</SelectItem>
                  {period !== 30 && period !== 60 && <SelectItem value={String(period)}>{period} s</SelectItem>}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t("totpManual.advancedHint")}</p>
        </CollapsibleContent>
      </Collapsible>

      <div className="flex justify-end">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending && <Spinner />} {t("totpManual.submit")}
        </Button>
      </div>
    </form>
  );
}
