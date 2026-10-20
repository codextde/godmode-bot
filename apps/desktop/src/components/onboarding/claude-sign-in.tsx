import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import type { ClaudeLoginStatus } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage } from "@/lib/api";
import { cloudContext, isTauri } from "@/lib/core";
import { openExternal } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The dashboard runs away from the computer (a phone, Godmode Cloud): the browser the sign-in opens there is out of reach. */
export const signsInFromAfar = !!cloudContext || (!isTauri && typeof window !== "undefined" && !LOCAL_HOSTS.has(window.location.hostname));

/** Who may sign Claude in: on Godmode Cloud only the computer's owner. */
export const maySignIn = !cloudContext || cloudContext.role === "owner";

/**
 * Claude Code's sign-in on this computer: its state (also whether runs found it signed out) and the steps to sign in.
 * `onSignedIn` runs when a sign-in finishes while the component is on screen, wherever it was started.
 */
export function useClaudeLogin({ onSignedIn }: { onSignedIn?: () => void } = {}) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: qk.claudeLogin,
    queryFn: api.doctor.claudeLogin,
    refetchInterval: (q) => {
      const s = q.state.data as ClaudeLoginStatus | undefined;
      return s?.state === "waiting" ? 1500 : s?.signedOut ? 30_000 : false;
    },
  });
  // A reply may arrive after the event it raced with: it doesn't take away the sign-in link the event brought.
  const set = (s: ClaudeLoginStatus) =>
    qc.setQueryData<ClaudeLoginStatus>(qk.claudeLogin, (old) => (old?.state === "waiting" && s.state === "waiting" && old.url && !s.url ? { ...s, url: old.url } : s));
  // The sign-in this component started (the others only mention it).
  const [mine, setMine] = useState(false);
  const start = useMutation({
    mutationFn: api.doctor.startClaudeLogin,
    onMutate: () => setMine(true),
    onSuccess: (s) => {
      set(s);
      if (s.state !== "waiting") setMine(false);
    },
    onError: (e) => {
      setMine(false);
      toast.error("Could not start the sign-in", { description: errorMessage(e) });
    },
  });
  const cancel = useMutation({ mutationFn: api.doctor.cancelClaudeLogin, onSuccess: set });
  // What the code did arrives as an event (or the next poll); the reply is only "still waiting".
  const submit = useMutation({
    mutationFn: (code: string) => api.doctor.submitClaudeLoginCode(code),
    onError: (e) => toast.error("Could not send the code", { description: errorMessage(e) }),
  });

  const state = data?.state ?? "idle";
  const prev = useRef(state);
  useEffect(() => {
    if (prev.current === "waiting" && state !== "waiting") {
      if (state === "done") {
        toast.success("Signed in to Claude", { id: "claude-signed-in", description: "Your agents can work again." });
        onSignedIn?.();
      }
      setMine(false);
    }
    prev.current = state;
  }, [state, onSignedIn]);

  return { status: data, state, mine: mine && state === "waiting", start, cancel, submit };
}

export type ClaudeLogin = ReturnType<typeof useClaudeLogin>;

/** While the sign-in runs: finish it in the browser, or (no browser window, a phone) open the page and paste its code. */
export function ClaudeSignInSteps({ login, className }: { login: ClaudeLogin; className?: string }) {
  const [code, setCode] = useState("");
  const [manual, setManual] = useState(signsInFromAfar);
  const url = login.status?.url ?? null;
  const send = () => {
    if (!code.trim()) return;
    login.submit.mutate(code.trim(), { onSuccess: () => setCode("") });
  };
  const openPage = () => {
    if (!url) return;
    setManual(true);
    void openExternal(url);
  };

  return (
    <div className={cn("rounded-md border bg-paper-2 p-3 text-xs", className)} aria-live="polite">
      <div className="flex items-center gap-2 font-medium">
        <Spinner className="size-3.5" />
        <span className="min-w-0 flex-1">{signsInFromAfar ? "Sign in on this device" : "Finish signing in in your browser"}</span>
        <Button size="xs" variant="ghost" className="-my-1 -mr-1.5 text-muted-foreground" onClick={() => login.cancel.mutate()} disabled={login.cancel.isPending}>
          Cancel
        </Button>
      </div>
      {signsInFromAfar ? (
        <ol className="mt-2 list-decimal space-y-1.5 pl-4 leading-relaxed text-foreground/85">
          <li>
            <button type="button" disabled={!url} onClick={openPage} className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline disabled:opacity-60">
              {url ? "Open the Claude sign-in page" : "Getting the sign-in page…"} {url ? <ExternalLink className="size-3" /> : <Spinner className="size-3" />}
            </button>
          </li>
          <li>
            Sign in with your Claude account and click <span className="font-medium">Authorize</span>.
          </li>
          <li>Paste the code the page shows:</li>
        </ol>
      ) : (
        <p className="mt-1.5 leading-relaxed text-muted-foreground">
          Sign in with your Claude account and click <span className="font-medium text-foreground">Authorize</span>. This updates by itself.
          {url && !manual && (
            <>
              {" "}
              <button type="button" className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline" onClick={openPage}>
                No browser window? <ExternalLink className="size-3" />
              </button>
            </>
          )}
        </p>
      )}
      {manual && (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Paste the code"
            aria-label="Code from the Claude sign-in page"
            className="h-8 bg-card font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" size="sm" variant="outline" disabled={!code.trim() || login.submit.isPending}>
            {login.submit.isPending && <Spinner />} Continue
          </Button>
        </form>
      )}
    </div>
  );
}
