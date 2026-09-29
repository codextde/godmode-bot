import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
  { icon: <KeyRound />, text: "Your passphrase derives the encryption key (scrypt). It is never stored or sent anywhere." },
  { icon: <LockKeyhole />, text: "Every password, 2FA secret and API key is encrypted individually with AES-256-GCM." },
  { icon: <EyeOff />, text: "Agents fill secrets straight into the browser — the AI model never sees them unless you allow it." },
];

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
  if (vault.initialized && vault.unlocked)
    return (
      <div>
        <StepHeader eyebrow="Vault" title="Your vault is ready." description="It's unlocked and encrypted on this machine." />
        <StepCard>
          <div className="flex items-center gap-3 rounded-lg border border-brand/25 bg-brand-soft p-4 text-sm">
            <CircleCheck className="size-5 shrink-0 text-brand-strong" />
            Logins, 2FA codes and API keys you add are encrypted with your passphrase.
          </div>
          <StepFooter onBack={onBack}>
            <SubmitButton busy={false} type="button" onClick={() => onDone("existing")} className="w-auto px-6">
              Continue
            </SubmitButton>
          </StepFooter>
        </StepCard>
      </div>
    );
  if (vault.initialized) return <UnlockInline onDone={() => onDone("unlocked")} onBack={onBack} />;
  return <CreateVault userName={userName} onDone={() => onDone("created")} onBack={onBack} />;
}

function CreateVault({ userName, onDone, onBack }: { userName: string; onDone: () => void; onBack: () => void }) {
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
        eyebrow="Vault"
        title={
          <>
            Create your vault.
            <span className="block text-foreground/35">Sealed on this machine.</span>
          </>
        }
        description="The vault holds website logins, 2FA secrets and API keys so your agents can sign in without interrupting you."
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
              <span className="pt-0.5 text-foreground/85">{g.text}</span>
            </motion.li>
          ))}
        </ul>

        <NewSecretFields
          idPrefix="vault-passphrase"
          label="Vault passphrase"
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
            <span className="font-medium">It can't be recovered.</span>{" "}
            <span className="text-muted-foreground">Store it in your password manager — without it, the vault can only be reset.</span>
          </p>
        </div>

        <label htmlFor="vault-remember" className="mt-3 flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition-colors hover:bg-accent/40">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand-strong" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Remember on this device</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
              Recommended so automations run unattended. The vault key is kept in your operating system's keychain and the vault unlocks
              automatically on this machine. Turn off to type the passphrase after every restart.
            </span>
          </span>
          <Switch id="vault-remember" checked={remember} onCheckedChange={setRemember} className="mt-0.5" />
        </label>

        <div className="mt-4">
          <FormError message={error} />
        </div>

        <StepFooter onBack={onBack}>
          <SubmitButton busy={busy} disabled={!valid} className="w-auto px-6">
            Create vault
          </SubmitButton>
        </StepFooter>
      </StepCard>
    </form>
  );
}

function UnlockInline({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
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
      <StepHeader eyebrow="Vault" title="Unlock your vault." description="A vault already exists on this machine. Enter its passphrase to continue setting up." />
      <StepCard>
        <motion.div animate={controls} className="space-y-2">
          <Label htmlFor="onboarding-unlock">Vault passphrase</Label>
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
            Unlock
          </SubmitButton>
        </StepFooter>
      </StepCard>
    </form>
  );
}
