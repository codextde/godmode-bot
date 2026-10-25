/**
 * Trying a guessed 2FA entry on a login's site: which entries a chat already tried for a login, and a watcher that
 * decides from the page whether the site took the code (the code field is gone, no error, still on the login's
 * site). Only one guess per chat and login is watched at a time; a new guess means the last one failed.
 */
import type { OtpProbe } from "../browser/fill";

export type TrialOutcome = "accepted" | "rejected" | "timeout" | "superseded";

interface Trial {
  tried: Set<string>;
  watch: { totpId: string; cancel: () => void } | null;
  touchedAt: number;
}

const trials = new Map<string, Trial>();
const TRIAL_TTL_MS = 60 * 60_000;

const keyOf = (conversationId: string, credentialId: string) => `${conversationId}:${credentialId}`;

function trialFor(conversationId: string, credentialId: string): Trial {
  const now = Date.now();
  for (const [k, t] of trials) if (now - t.touchedAt > TRIAL_TTL_MS && !t.watch) trials.delete(k);
  const key = keyOf(conversationId, credentialId);
  let t = trials.get(key);
  if (!t) trials.set(key, (t = { tried: new Set(), watch: null, touchedAt: now }));
  t.touchedAt = now;
  return t;
}

/** Entries this chat already tried for the login (they failed or are being checked). */
export function triedTotp(conversationId: string, credentialId: string): ReadonlySet<string> {
  return trialFor(conversationId, credentialId).tried;
}

export interface WatchOptions {
  probe: () => Promise<OtpProbe | null>;
  /** The page is still on the login's site. */
  onSite: (url: string) => boolean;
  /** Called once when the site took the code. */
  onAccepted: () => void;
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * Start checking whether the site takes the guessed entry's code. Cancels the watch of an earlier guess for the
 * same login (the agent asking again means that one was wrong). Resolves when the outcome is known.
 */
export function watchTotpGuess(conversationId: string, credentialId: string, totpId: string, opts: WatchOptions): Promise<TrialOutcome> {
  const trial = trialFor(conversationId, credentialId);
  trial.watch?.cancel();
  trial.tried.add(totpId);
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 1200;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;
  const watch = {
    totpId,
    cancel: () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      wake?.();
    },
  };
  trial.watch = watch;
  const pause = () =>
    new Promise<void>((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, intervalMs);
    });

  return (async (): Promise<TrialOutcome> => {
    const deadline = Date.now() + timeoutMs;
    let clear = 0;
    try {
      while (Date.now() < deadline) {
        await pause();
        if (cancelled) return "superseded";
        const page = await opts.probe();
        if (cancelled) return "superseded";
        if (!page) continue;
        if (!opts.onSite(page.url)) return "rejected";
        if (page.otpField && page.error) return "rejected";
        if (page.otpField || page.error) {
          clear = 0;
          continue;
        }
        // Two clean looks in a row, so a page that is just re-rendering its form doesn't count.
        if (++clear >= 2) {
          opts.onAccepted();
          trial.tried.delete(totpId);
          return "accepted";
        }
      }
      return "timeout";
    } finally {
      if (trial.watch === watch) trial.watch = null;
    }
  })();
}

/** For tests. */
export function resetTotpTrials(): void {
  for (const t of trials.values()) t.watch?.cancel();
  trials.clear();
}
