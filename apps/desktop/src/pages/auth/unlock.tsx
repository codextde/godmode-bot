import { useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useAnimationControls } from "motion/react";
import { ArchiveRestore, ChevronDown, FileArchive, Lock, ShieldCheck, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { AuthLayout, FormError, SubmitButton, shake } from "@/components/onboarding/auth-layout";
import { CopyButton } from "@/components/vault/copy-button";
import { PasswordInput } from "@/components/vault/password-input";
import { ApiRequestError, api, errorMessage } from "@/lib/api";
import { useBootstrap } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

export function unlockError(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 429) return "Too many attempts — wait a minute and try again.";
    if (err.status === 400 || err.status === 401 || err.status === 403) return "That passphrase isn't right.";
  }
  return errorMessage(err);
}

/** Shown when the vault is initialized but locked (auto-lock, manual lock or restart without "remember device"). */
export function UnlockPage() {
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
      toast.success("Vault unlocked", { description: "Your agents can sign in again." });
    } catch (err) {
      setError(unlockError(err));
      void controls.start(shake);
    } finally {
      setBusy(false);
    }
  };

  const dataDir = boot?.dataDir;

  return (
    <AuthLayout
      badge={<Lock />}
      title="Your vault is locked"
      description="Enter your vault passphrase to unlock logins, 2FA codes and API keys for you and your agents."
      footer={
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck className="size-3.5 text-success" />
          Secrets stay encrypted with AES-256-GCM until you unlock.
        </span>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <motion.div animate={controls} className="space-y-2">
          <Label htmlFor="unlock-passphrase">Vault passphrase</Label>
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
            placeholder="Your passphrase"
          />
        </motion.div>
        <FormError message={error} />
        <SubmitButton busy={busy} disabled={!passphrase}>
          Unlock
        </SubmitButton>
      </form>

      <div className="mt-5 border-t pt-4">
        <button
          type="button"
          onClick={() => setForgotOpen((o) => !o)}
          aria-expanded={forgotOpen}
          className="flex w-full items-center justify-between text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Forgot your passphrase?
          <ChevronDown className={cn("size-4 transition-transform", forgotOpen && "rotate-180")} />
        </button>
        <AnimatePresence initial={false}>
          {forgotOpen && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
              <div className="space-y-3 pt-3 text-sm text-muted-foreground">
                <p>
                  Secrets can't be recovered — your passphrase is the only key and it never leaves this machine. You can
                  restore a backup (then unlock with that backup's passphrase) or start over.
                </p>
                <Button variant="outline" size="sm" className="w-full" onClick={() => setRestoreOpen(true)}>
                  <ArchiveRestore /> Restore a backup…
                </Button>
                {dataDir && (
                  <div className="rounded-lg border bg-muted/40 p-3 text-xs">
                    <p>To reset, quit Godmode and delete its data directory. This permanently removes all agents, logins and 2FA codes.</p>
                    <div className="mt-2 flex items-center gap-1 rounded-md bg-background/60 pl-2 font-mono">
                      <span className="min-w-0 flex-1 truncate" title={dataDir}>
                        {dataDir}
                      </span>
                      <CopyButton value={dataDir} label="Copy path" size="icon-xs" />
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
      toast.success("Backup restored", { description: "Vault restored and locked — unlock with the vault passphrase of the backup." });
      onOpenChange(false);
      reset();
      await qc.invalidateQueries();
    } catch (err) {
      setError(err instanceof ApiRequestError && (err.status === 400 || err.status === 401) ? "Wrong backup passphrase or damaged file." : errorMessage(err));
    } finally {
      setBusy(false);
    }
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
            <DialogTitle>Restore a backup</DialogTitle>
            <DialogDescription>
              Replaces everything on this machine with the backup's contents. Afterwards, unlock with the vault passphrase that was active
              when the backup was made.
            </DialogDescription>
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
              "flex items-center gap-3 rounded-xl border border-dashed p-4 text-left text-sm transition-colors hover:border-primary/40 hover:bg-primary/5",
              file && "border-solid border-primary/40 bg-primary/5",
            )}
          >
            <div className="grid size-10 place-items-center rounded-lg bg-muted">{file ? <FileArchive className="size-5 text-primary" /> : <Upload className="size-5" />}</div>
            <div className="min-w-0">
              <p className="truncate font-medium">{file ? file.name : "Choose a .godmode-backup file"}</p>
              <p className="text-xs text-muted-foreground">{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : "Created in Settings → Backup"}</p>
            </div>
          </button>
          <div className="space-y-2">
            <Label htmlFor="restore-passphrase">Backup passphrase</Label>
            <PasswordInput id="restore-passphrase" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="off" />
          </div>
          <FormError message={error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={!file || !passphrase || busy}>
              {busy ? <Spinner /> : <ArchiveRestore />} Replace & restore
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
