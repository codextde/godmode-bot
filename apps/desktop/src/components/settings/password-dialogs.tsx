import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, LockKeyhole } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { PasswordInput } from "@/components/vault/password-input";
import { StrengthMeter } from "@/components/vault/strength-meter";
import { ApiRequestError, api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { Callout } from "./settings-kit";

function FieldError({ children }: { children?: string | null }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-xs text-destructive">
      {children}
    </p>
  );
}

/** Change the vault passphrase (re-wraps the data key; secrets themselves are not re-encrypted). */
export function ChangePassphraseDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const reset = () => {
    setCurrent("");
    setNext("");
    setConfirm("");
    setTouched(false);
    setServerError(null);
  };

  const mutation = useMutation({
    mutationFn: () => api.vault.changePassphrase(current, next),
    onSuccess: () => {
      toast.success("Vault passphrase changed", { description: "Use the new passphrase next time you unlock." });
      void qc.invalidateQueries({ queryKey: qk.vaultStatus });
      reset();
      onOpenChange(false);
    },
    onError: (e) => {
      if (e instanceof ApiRequestError && (e.status === 401 || e.status === 403 || e.status === 400)) setServerError(e.message || "Current passphrase is incorrect");
      else setServerError(errorMessage(e));
    },
  });

  const nextError = next.length > 0 && next.length < 8 ? "Use at least 8 characters." : next && next === current ? "Choose a passphrase different from the current one." : null;
  const confirmError = touched && confirm !== next ? "Passphrases don't match." : null;
  const valid = current.length > 0 && next.length >= 8 && next === confirm && next !== current;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (valid) mutation.mutate();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <LockKeyhole className="size-5 text-foreground" /> Change vault passphrase
            </DialogTitle>
            <DialogDescription>Your logins and 2FA secrets stay encrypted — only the key that protects them is re-wrapped.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="cp-current">Current passphrase</Label>
            <PasswordInput
              id="cp-current"
              autoComplete="current-password"
              autoFocus
              value={current}
              onChange={(e) => {
                setCurrent(e.target.value);
                setServerError(null);
              }}
              aria-invalid={!!serverError}
            />
            <FieldError>{serverError}</FieldError>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cp-next">New passphrase</Label>
            <PasswordInput id="cp-next" value={next} onChange={(e) => setNext(e.target.value)} aria-invalid={!!nextError} />
            <StrengthMeter password={next} />
            <FieldError>{nextError}</FieldError>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cp-confirm">Confirm new passphrase</Label>
            <PasswordInput
              id="cp-confirm"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onBlur={() => confirm && setTouched(true)}
              aria-invalid={!!confirmError}
            />
            <FieldError>{confirmError}</FieldError>
          </div>
          <Callout tone="warning" title="There is no recovery">
            If you forget this passphrase, your secrets can't be decrypted — only a backup can bring them back.
          </Callout>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || mutation.isPending}>
              {mutation.isPending && <Spinner />} Change passphrase
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Set or change the password for the remote web dashboard. */
export function DashboardPasswordDialog({
  open,
  onOpenChange,
  hasPassword,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasPassword: boolean;
}) {
  const qc = useQueryClient();
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [touched, setTouched] = useState(false);

  const reset = () => {
    setPw("");
    setConfirm("");
    setTouched(false);
  };

  const mutation = useMutation({
    mutationFn: () => api.auth.setPassword(pw),
    onSuccess: () => {
      toast.success(hasPassword ? "Dashboard password changed" : "Dashboard password set", {
        description: "Other signed-in dashboard sessions will need to sign in again.",
      });
      void qc.invalidateQueries({ queryKey: qk.settings });
      void qc.invalidateQueries({ queryKey: qk.authStatus });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
      reset();
      onOpenChange(false);
    },
    onError: (e) => toast.error("Could not set the password", { description: errorMessage(e) }),
  });

  const pwError = pw.length > 0 && pw.length < 10 ? "Use at least 10 characters." : null;
  const confirmError = touched && confirm !== pw ? "Passwords don't match." : null;
  const valid = pw.length >= 10 && pw === confirm;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (valid) mutation.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-5 text-foreground" /> {hasPassword ? "Change dashboard password" : "Set dashboard password"}
            </DialogTitle>
            <DialogDescription>
              Protects the browser dashboard served by <code className="rounded-[4px] bg-secondary px-1 font-mono text-[11px]">godmode serve</code>. This is
              separate from your vault passphrase — use a different one.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="dp-new">New password</Label>
            <PasswordInput id="dp-new" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} aria-invalid={!!pwError} />
            <StrengthMeter password={pw} />
            <FieldError>{pwError}</FieldError>
          </div>
          <div className="space-y-2">
            <Label htmlFor="dp-confirm">Confirm password</Label>
            <PasswordInput
              id="dp-confirm"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onBlur={() => confirm && setTouched(true)}
              aria-invalid={!!confirmError}
            />
            <FieldError>{confirmError}</FieldError>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || mutation.isPending}>
              {mutation.isPending && <Spinner />} {hasPassword ? "Change password" : "Set password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
