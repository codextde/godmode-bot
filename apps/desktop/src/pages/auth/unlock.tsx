import { useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useAnimationControls } from "motion/react";
import { ArchiveRestore, ChevronDown, FileArchive, Lock, ShieldCheck, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { AuthLayout, FormError, SubmitButton, shake, unlockError } from "@/components/onboarding/auth-layout";
import { CopyButton } from "@/components/vault/copy-button";
import { PasswordInput } from "@/components/vault/password-input";
import { ApiRequestError, api, errorMessage } from "@/lib/api";
import { useBootstrap } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useLocale } from "@/i18n/language";

/** Shown when the vault is initialized but locked (auto-lock, manual lock or restart without "remember device"). */
export function UnlockPage() {
  const { t } = useTranslation("auth");
  const qc = useQueryClient();
  const { data: boot } = useBootstrap();
  const controls = useAnimationControls();
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!passphrase || busy) return;
    setBusy(true);
    setError(null);
    try {
      const status = await api.vault.unlock(passphrase);
      qc.setQueryData(qk.vaultStatus, status);
      setPassphrase("");
      await qc.invalidateQueries({ queryKey: qk.bootstrap });
      toast.success(t("unlock.unlockedToast"), { description: t("unlock.unlockedToastDescription") });
    } catch (err) {
      setError(unlockError(err));
      void controls.start(shake);
    }
    setBusy(false);
  };

  const dataDir = boot?.dataDir;

  return (
    <AuthLayout
      badge={<Lock />}
      title={
        <>
          {t("unlock.title")}
          <span className="block text-foreground/35">{t("unlock.subtitle")}</span>
        </>
      }
      description={t("unlock.description")}
      footer={
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck className="size-3.5 text-brand-strong" />
          {t("unlock.footer")}
        </span>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <motion.div animate={controls} className="space-y-2">
          <Label htmlFor="unlock-passphrase">{t("unlock.passphraseLabel")}</Label>
          <PasswordInput
            id="unlock-passphrase"
            autoFocus
            autoComplete="current-password"
            value={passphrase}
            onChange={(e) => {
              setPassphrase(e.target.value);
              setError(null);
            }}
            aria-invalid={!!error}
            placeholder={t("unlock.passphrasePlaceholder")}
          />
        </motion.div>
        <FormError message={error} />
        <SubmitButton busy={busy} disabled={!passphrase}>
          {t("unlock.unlock")}
        </SubmitButton>
      </form>

      <div className="mt-5 border-t pt-4">
        <button
          type="button"
          onClick={() => setForgotOpen((o) => !o)}
          aria-expanded={forgotOpen}
          className="flex w-full items-center justify-between text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("unlock.forgot")}
          <ChevronDown className={cn("size-4 transition-transform", forgotOpen && "rotate-180")} />
        </button>
        <AnimatePresence initial={false}>
          {forgotOpen && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
              <div className="space-y-3 pt-3 text-sm text-muted-foreground">
                <p>
                  {t("unlock.forgotDescription")}
                </p>
                <Button variant="outline" size="sm" className="w-full" onClick={() => setRestoreOpen(true)}>
                  <ArchiveRestore /> {t("unlock.restoreBackupMenu")}
                </Button>
                {dataDir && (
                  <div className="rounded-lg border bg-paper-2 p-3 text-xs">
                    <p>{t("unlock.resetHint")}</p>
                    <div className="mt-2 flex items-center gap-1 rounded-md border bg-card pl-2 font-mono">
                      <span className="min-w-0 flex-1 truncate" title={dataDir}>
                        {dataDir}
                      </span>
                      <CopyButton value={dataDir} label={t("unlock.copyPath")} size="icon-xs" />
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <RestoreBackupDialog open={restoreOpen} onOpenChange={setRestoreOpen} />
    </AuthLayout>
  );
}

function RestoreBackupDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation(["auth", "common"]);
  const { intlLocale } = useLocale();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setFile(null);
    setPassphrase("");
    setError(null);
  };

  const restore = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || !passphrase || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.backup.import(file, passphrase);
      toast.success(t("restore.restoredToast"), { description: t("restore.restoredToastDescription") });
      onOpenChange(false);
      reset();
      await qc.invalidateQueries();
    } catch (err) {
      setError(err instanceof ApiRequestError && (err.status === 400 || err.status === 401) ? t("restore.wrongPassphrase") : errorMessage(err));
    }
    setBusy(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="rounded-2xl sm:max-w-md">
        <form onSubmit={restore} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t("restore.title")}</DialogTitle>
            <DialogDescription>{t("restore.description")}</DialogDescription>
          </DialogHeader>
          <input
            ref={inputRef}
            type="file"
            accept=".godmode-backup,application/octet-stream"
            className="sr-only"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className={cn(
              "flex items-center gap-3 rounded-lg border border-dashed p-4 text-left text-sm transition-colors hover:border-foreground/25 hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
              file && "border-solid border-foreground/20 bg-paper-2",
            )}
          >
            <div className="grid size-10 shrink-0 place-items-center rounded-lg border bg-card text-foreground shadow-card">
              {file ? <FileArchive className="size-5" /> : <Upload className="size-5" />}
            </div>
            <div className="min-w-0">
              <p className="truncate font-medium">{file ? file.name : t("restore.chooseFile")}</p>
              <p className="text-xs text-muted-foreground">{file ? t("restore.size", { size: (file.size / 1024 / 1024).toLocaleString(intlLocale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }) : t("restore.createdIn")}</p>
            </div>
          </button>
          <div className="space-y-2">
            <Label htmlFor="restore-passphrase">{t("restore.passphraseLabel")}</Label>
            <PasswordInput id="restore-passphrase" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="off" />
          </div>
          <FormError message={error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" variant="destructive" disabled={!file || !passphrase || busy}>
              {busy ? <Spinner /> : <ArchiveRestore />} {t("restore.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
