import { useState, useSyncExternalStore, type FormEvent } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { ApiRequestError, api, errorMessage, setGrantRejectedHandler } from "@/lib/api";
import { PasswordInput } from "./password-input";

/**
 * Reveal grants: revealing a password, giving an agent "reveal" access, making that the default or remembering the
 * vault key on this device needs the vault passphrase again. The core answers with a grant valid for 10 minutes;
 * it's cached here in memory (never persisted) and sent as a header. One dialog, mounted once
 * (`<VaultGrantDialog />` in main.tsx), serves every `ensureGrant()` call.
 */

/** Don't hand out a grant that is about to expire mid-request. */
const EXPIRY_MARGIN_MS = 15_000;
const MAX_GRANT_MS = 10 * 60_000;

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
let pending: { promise: Promise<string>; resolve: (grant: string) => void; reject: (err: Error) => void } | null = null;
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

function validCachedGrant(): string | undefined {
  if (cached && cached.expiresAt - Date.now() > EXPIRY_MARGIN_MS) return cached.grant;
  cached = null;
  return undefined;
}

/** A valid grant: the cached one, or ask for the passphrase. Rejects (see `isGrantCancelled`) if the user cancels. */
function ensureGrant(): Promise<string> {
  const grant = validCachedGrant();
  if (grant) return Promise.resolve(grant);
  if (!pending) {
    let resolve!: (grant: string) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    pending = { promise, resolve, reject };
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
export function useVaultGrant(): () => Promise<string> {
  return ensureGrant;
}

/**
 * Run a request that may need a grant: sends the cached grant if there is one; if the core answers
 * `grant_required`, asks for the passphrase and tries once more.
 */
export async function withGrant<T>(fn: (grant: string | undefined) => Promise<T>): Promise<T> {
  try {
    return await fn(validCachedGrant());
  } catch (err) {
    if (!(err instanceof ApiRequestError && err.code === "grant_required")) throw err;
    cached = null;
    return fn(await ensureGrant());
  }
}

/** The passphrase prompt behind `ensureGrant()`. Mount once. */
export function VaultGrantDialog() {
  const open = useSyncExternalStore(subscribe, () => pending !== null);
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = (grant: string | null) => {
    setPassphrase("");
    setError(null);
    settle(grant);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!passphrase || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.vault.grant(passphrase);
      const expiresAt = Math.min(Date.parse(res.expiresAt) || 0, Date.now() + MAX_GRANT_MS);
      cached = { grant: res.grant, expiresAt };
      close(res.grant);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && close(null)}>
      <DialogContent className="rounded-2xl sm:max-w-sm">
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="size-5 text-brand-strong" /> Confirm it's you
            </DialogTitle>
            <DialogDescription>Enter your vault passphrase to show secrets in plain text. You won't be asked again for 10 minutes.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="vault-grant-passphrase">Vault passphrase</Label>
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
              Cancel
            </Button>
            <Button type="submit" disabled={!passphrase || busy}>
              {busy && <Spinner />} Confirm
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
