import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Fingerprint, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { ApiRequestError, api, errorMessage, setGrantRejectedHandler, type VaultGrant } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { PasswordInput } from "./password-input";

/**
 * Reveal grants: revealing a password, giving an agent "reveal" access, making that the default or remembering the
 * vault key on this device needs the vault passphrase again, or the finger where Touch ID is on. The core answers with
 * a grant valid for 10 minutes; it's cached here in memory (never persisted) and sent as a header. One dialog, mounted
 * once (`<VaultGrantDialog />` in main.tsx), serves every `ensureGrant()` call. With Touch ID the system prompt comes
 * first and the dialog only shows when that didn't settle it, since the prompt offers no password of its own.
 */

/** Don't hand out a grant that is about to expire mid-request. */
const EXPIRY_MARGIN_MS = 15_000;
const MAX_GRANT_MS = 10 * 60_000;
/** A helper or primary that doesn't answer must not leave the click without a response. */
const TOUCH_ID_STATUS_MS = 2_000;

class GrantCancelledError extends Error {
  constructor() {
    super("Passphrase confirmation cancelled");
    this.name = "GrantCancelledError";
  }
}

/** The user closed the passphrase prompt: callers should silently abort. */
export function isGrantCancelled(err: unknown): boolean {
  return err instanceof GrantCancelledError;
}

let cached: { grant: string; expiresAt: number } | null = null;
let pending: { promise: Promise<string>; resolve: (grant: string) => void; reject: (err: Error) => void; reason?: string } | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

setGrantRejectedHandler(() => {
  cached = null;
});

function keepGrant(res: VaultGrant): string {
  cached = { grant: res.grant, expiresAt: Math.min(Date.parse(res.expiresAt) || 0, Date.now() + MAX_GRANT_MS) };
  return res.grant;
}

function validCachedGrant(): string | undefined {
  if (cached && cached.expiresAt - Date.now() > EXPIRY_MARGIN_MS) return cached.grant;
  cached = null;
  return undefined;
}

/** A valid grant: the cached one, or ask for the passphrase. Rejects (see `isGrantCancelled`) if the user cancels. */
function ensureGrant(reason?: string): Promise<string> {
  const grant = validCachedGrant();
  if (grant) return Promise.resolve(grant);
  if (!pending) {
    let resolve!: (grant: string) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    pending = { promise, resolve, reject, reason };
    notify();
  }
  return pending.promise;
}

function settle(grant: string | null) {
  const current = pending;
  pending = null;
  notify();
  if (!current) return;
  if (grant) current.resolve(grant);
  else current.reject(new GrantCancelledError());
}

/** `ensureGrant()` asks for the vault passphrase once and caches the resulting grant until it expires. */
export function useVaultGrant(): (reason?: string) => Promise<string> {
  return ensureGrant;
}

/**
 * Run a request that may need a grant: sends the cached grant if there is one; if the core answers
 * `grant_required`, asks for the passphrase and tries once more.
 */
export async function withGrant<T>(fn: (grant: string | undefined) => Promise<T>, reason?: string): Promise<T> {
  try {
    return await fn(validCachedGrant());
  } catch (err) {
    if (!(err instanceof ApiRequestError && err.code === "grant_required")) throw err;
    cached = null;
    return fn(await ensureGrant(reason));
  }
}

/** The finger, then the passphrase prompt, behind `ensureGrant()`. Mount once. */
export function VaultGrantDialog() {
  const { t } = useTranslation(["vault", "common", "auth"]);
  const qc = useQueryClient();
  const current = useSyncExternalStore(subscribe, () => pending);
  const [shownFor, setShownFor] = useState<typeof pending>(null);
  const [touchIdReady, setTouchIdReady] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const askedFor = useRef<typeof pending>(null);

  const close = (grant: string | null) => {
    setPassphrase("");
    setError(null);
    setShownFor(null);
    settle(grant);
  };

  const touchIdFailed = (err: unknown) => {
    const code = err instanceof ApiRequestError ? err.code : undefined;
    if (code === "touch_id_cancelled" || code === "touch_id_busy") return;
    if (code === "touch_id_invalid") {
      setTouchIdReady(false);
      void qc.invalidateQueries({ queryKey: qk.touchId });
    }
    setError(t(code === "touch_id_invalid" ? "auth:unlock.touchIdInvalid" : code === "touch_id_failed" ? "auth:unlock.touchIdFailed" : "auth:unlock.touchIdUnavailable"));
  };

  useEffect(() => {
    if (!current || askedFor.current === current) return;
    askedFor.current = current;
    void (async () => {
      const touchId = await Promise.race([
        api.vault.touchId.status().catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), TOUCH_ID_STATUS_MS)),
      ]);
      const ready = !!touchId?.enabled && touchId.available;
      setTouchIdReady(ready);
      if (ready) {
        try {
          close(keepGrant(await api.vault.touchId.grant()));
          return;
        } catch (err) {
          touchIdFailed(err);
        }
      }
      setShownFor(current);
    })();
  }, [current]);

  const confirmWithTouchId = async () => {
    setBusy(true);
    setError(null);
    try {
      close(keepGrant(await api.vault.touchId.grant()));
    } catch (err) {
      touchIdFailed(err);
    }
    setBusy(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!passphrase || busy) return;
    setBusy(true);
    setError(null);
    try {
      close(keepGrant(await api.vault.grant(passphrase)));
    } catch (err) {
      setError(errorMessage(err));
    }
    setBusy(false);
  };

  return (
    <Dialog open={!!current && shownFor === current} onOpenChange={(o) => !o && !busy && close(null)}>
      <DialogContent className="rounded-2xl sm:max-w-sm">
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="size-5 text-brand-strong" /> {t("grant.title")}
            </DialogTitle>
            <DialogDescription>
              {current?.reason ?? t(touchIdReady ? "grant.touchIdReason" : "grant.defaultReason")} {t("grant.notAgain")}
            </DialogDescription>
          </DialogHeader>
          {touchIdReady && (
            <div className="space-y-4">
              <Button type="button" className="w-full" disabled={busy} onClick={() => void confirmWithTouchId()}>
                {busy ? <Spinner /> : <Fingerprint />} {t("grant.touchId")}
              </Button>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                {t("common:words.or")}
                <span className="h-px flex-1 bg-border" />
              </div>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="vault-grant-passphrase">{t("grant.passphrase")}</Label>
            <PasswordInput
              id="vault-grant-passphrase"
              autoComplete="current-password"
              autoFocus
              value={passphrase}
              onChange={(e) => {
                setPassphrase(e.target.value);
                setError(null);
              }}
              aria-invalid={!!error}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => close(null)}>
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" variant={touchIdReady ? "outline" : "default"} disabled={!passphrase || busy}>
              {busy && !touchIdReady && <Spinner />} {t("common:actions.confirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
