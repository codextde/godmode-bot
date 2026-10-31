import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, LockKeyhole } from "lucide-react";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
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
  const { t } = useTranslation(["settings", "common"]);
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
      toast.success(t("passwords.passphraseChanged"), { description: t("passwords.passphraseChangedDescription") });
      void qc.invalidateQueries({ queryKey: qk.vaultStatus });
      reset();
      onOpenChange(false);
    },
    onError: (e) => {
      if (e instanceof ApiRequestError && (e.status === 401 || e.status === 403 || e.status === 400)) setServerError(e.message || t("passwords.incorrect"));
      else setServerError(errorMessage(e));
    },
  });

  const nextError = next.length > 0 && next.length < 8 ? t("passwords.minLength", { count: 8 }) : next && next === current ? t("passwords.different") : null;
  const confirmError = touched && confirm !== next ? t("passwords.passphraseMismatch") : null;
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
              <LockKeyhole className="size-5 text-foreground" /> {t("passwords.changeTitle")}
            </DialogTitle>
            <DialogDescription>{t("passwords.changeDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="cp-current">{t("passwords.current")}</Label>
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
            <Label htmlFor="cp-next">{t("passwords.new")}</Label>
            <PasswordInput id="cp-next" value={next} onChange={(e) => setNext(e.target.value)} aria-invalid={!!nextError} />
            <StrengthMeter password={next} />
            <FieldError>{nextError}</FieldError>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cp-confirm">{t("passwords.confirm")}</Label>
            <PasswordInput
              id="cp-confirm"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onBlur={() => confirm && setTouched(true)}
              aria-invalid={!!confirmError}
            />
            <FieldError>{confirmError}</FieldError>
          </div>
          <Callout tone="warning" title={t("passwords.noRecovery")}>
            {t("passwords.noRecoveryBody")}
          </Callout>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" disabled={!valid || mutation.isPending}>
              {mutation.isPending && <Spinner />} {t("passwords.changeButton")}
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
  const { t } = useTranslation(["settings", "common"]);
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
      toast.success(hasPassword ? t("passwords.dashboardChanged") : t("passwords.dashboardSet"), {
        description: t("passwords.dashboardSessions"),
      });
      void qc.invalidateQueries({ queryKey: qk.settings });
      void qc.invalidateQueries({ queryKey: qk.authStatus });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
      reset();
      onOpenChange(false);
    },
    onError: (e) => toast.error(t("passwords.setError"), { description: errorMessage(e) }),
  });

  const pwError = pw.length > 0 && pw.length < 10 ? t("passwords.minLength", { count: 10 }) : null;
  const confirmError = touched && confirm !== pw ? t("passwords.passwordMismatch") : null;
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
              <KeyRound className="size-5 text-foreground" /> {hasPassword ? t("passwords.dashboardChangeTitle") : t("passwords.dashboardSetTitle")}
            </DialogTitle>
            <DialogDescription>
              <Trans t={t} i18nKey="passwords.dashboardDescription" values={{ command: "godmode serve" }} components={{ code: <code className="rounded-[4px] bg-secondary px-1 font-mono text-[11px]" /> }} />
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="dp-new">{t("passwords.newPassword")}</Label>
            <PasswordInput id="dp-new" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} aria-invalid={!!pwError} />
            <StrengthMeter password={pw} />
            <FieldError>{pwError}</FieldError>
          </div>
          <div className="space-y-2">
            <Label htmlFor="dp-confirm">{t("passwords.confirmPassword")}</Label>
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
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" disabled={!valid || mutation.isPending}>
              {mutation.isPending && <Spinner />} {hasPassword ? t("passwords.changePassword") : t("passwords.setPassword")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
