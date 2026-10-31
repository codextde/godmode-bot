import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { motion, useAnimationControls } from "motion/react";
import { CircleCheck, EyeOff, KeyRound, LockKeyhole, ShieldCheck, TriangleAlert } from "lucide-react";
import type { VaultStatus } from "@godmode/shared";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PasswordInput } from "@/components/vault/password-input";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { FormError, SubmitButton, shake, unlockError } from "./auth-layout";
import { NewSecretFields, StepCard, StepFooter, StepHeader, secretValid } from "./step-kit";

const MIN_PASSPHRASE = 8;

const GUARANTEES = [
  { icon: <KeyRound />, textKey: "vault.guarantees.key" },
  { icon: <LockKeyhole />, textKey: "vault.guarantees.encryption" },
  { icon: <EyeOff />, textKey: "vault.guarantees.fill" },
] as const;

export function VaultStep({
  vault,
  userName,
  onDone,
  onBack,
}: {
  vault: VaultStatus;
  userName: string;
  onDone: (result: "created" | "unlocked" | "existing") => void;
  onBack: () => void;
}) {
  const { t } = useTranslation(["onboarding", "common"]);
  if (vault.initialized && vault.unlocked)
    return (
      <div>
        <StepHeader eyebrow={t("vault.eyebrow")} title={t("vault.readyTitle")} description={t("vault.readyDescription")} />
        <StepCard>
          <div className="flex items-center gap-3 rounded-lg border border-brand/25 bg-brand-soft p-4 text-sm">
            <CircleCheck className="size-5 shrink-0 text-brand-strong" />
            {t("vault.readyBody")}
          </div>
          <StepFooter onBack={onBack}>
            <SubmitButton busy={false} type="button" onClick={() => onDone("existing")} className="w-auto px-6">
              {t("common:actions.continue")}
            </SubmitButton>
          </StepFooter>
        </StepCard>
      </div>
    );
  if (vault.initialized) return <UnlockInline onDone={() => onDone("unlocked")} onBack={onBack} />;
  return <CreateVault userName={userName} onDone={() => onDone("created")} onBack={onBack} />;
}

function CreateVault({ userName, onDone, onBack }: { userName: string; onDone: () => void; onBack: () => void }) {
  const { t } = useTranslation("onboarding");
  const qc = useQueryClient();
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = secretValid(passphrase, confirm, MIN_PASSPHRASE);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const status = await api.vault.setup({ passphrase, rememberDevice: remember, userName: userName.trim() || undefined });
      qc.setQueryData(qk.vaultStatus, status);
      await qc.invalidateQueries({ queryKey: qk.bootstrap });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <StepHeader
        eyebrow={t("vault.eyebrow")}
        title={
          <>
            {t("vault.createTitle")}
            <span className="block text-foreground/35">{t("vault.createSubtitle")}</span>
          </>
        }
        description={t("vault.createDescription")}
      />
      <StepCard>
        <ul className="mb-6 divide-y overflow-hidden rounded-xl border bg-paper-2">
          {GUARANTEES.map((g, i) => (
            <motion.li
              key={i}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.05 + i * 0.06 }}
              className="flex items-start gap-3 px-3.5 py-3 text-sm"
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-md border border-brand/25 bg-brand-soft text-brand-strong [&_svg]:size-3.5">
                {g.icon}
              </span>
              <span className="pt-0.5 text-foreground/85">{t(g.textKey)}</span>
            </motion.li>
          ))}
        </ul>

        <NewSecretFields
          idPrefix="vault-passphrase"
          label={t("vault.passphrase")}
          value={passphrase}
          confirm={confirm}
          onChange={setPassphrase}
          onConfirmChange={setConfirm}
          minLength={MIN_PASSPHRASE}
          userInputs={[userName, "godmode", "vault"]}
          autoFocus
        />

        <div className="mt-5 flex items-start gap-3 rounded-lg border border-warning/25 bg-warning/[0.07] p-3.5 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <p>
            <span className="font-medium">{t("vault.noRecovery")}</span>{" "}
            <span className="text-muted-foreground">{t("vault.noRecoveryHint")}</span>
          </p>
        </div>

        <label htmlFor="vault-remember" className="mt-3 flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition-colors hover:bg-accent/40">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand-strong" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{t("vault.remember")}</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
              {t("vault.rememberHint")}
            </span>
          </span>
          <Switch id="vault-remember" checked={remember} onCheckedChange={setRemember} className="mt-0.5" />
        </label>

        <div className="mt-4">
          <FormError message={error} />
        </div>

        <StepFooter onBack={onBack}>
          <SubmitButton busy={busy} disabled={!valid} className="w-auto px-6">
            {t("vault.create")}
          </SubmitButton>
        </StepFooter>
      </StepCard>
    </form>
  );
}

function UnlockInline({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const { t } = useTranslation("onboarding");
  const qc = useQueryClient();
  const controls = useAnimationControls();
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!passphrase || busy) return;
    setBusy(true);
    setError(null);
    try {
      const status = await api.vault.unlock(passphrase);
      qc.setQueryData(qk.vaultStatus, status);
      await qc.invalidateQueries({ queryKey: qk.bootstrap });
      onDone();
    } catch (err) {
      setError(unlockError(err));
      void controls.start(shake);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <StepHeader eyebrow={t("vault.eyebrow")} title={t("vault.unlockTitle")} description={t("vault.unlockDescription")} />
      <StepCard>
        <motion.div animate={controls} className="space-y-2">
          <Label htmlFor="onboarding-unlock">{t("vault.passphrase")}</Label>
          <PasswordInput
            id="onboarding-unlock"
            autoFocus
            autoComplete="current-password"
            value={passphrase}
            onChange={(e) => {
              setPassphrase(e.target.value);
              setError(null);
            }}
            aria-invalid={!!error}
          />
        </motion.div>
        <div className="mt-4">
          <FormError message={error} />
        </div>
        <StepFooter onBack={onBack}>
          <SubmitButton busy={busy} disabled={!passphrase} className="w-auto px-6">
            {t("vault.unlock")}
          </SubmitButton>
        </StepFooter>
      </StepCard>
    </form>
  );
}
