import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import type { ClaudeLoginStatus } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { writeClipboard } from "@/components/vault/clipboard";
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
 * Puts the sign-in link on the clipboard. On this computer the core writes it: the desktop webview only lets the page
 * copy during a click, and the link arrives seconds after it. From afar only this device's clipboard is of any use.
 */
async function copySignInLink(url: string, clicked: boolean): Promise<boolean> {
  const viaCore = async () => !signsInFromAfar && !!(await api.doctor.copyClaudeLoginLink().catch(() => null))?.ok;
  const viaPage = () =>
    writeClipboard(url).then(
      () => true,
      () => false,
    );
  return clicked ? (await viaPage()) || viaCore() : (await viaCore()) || viaPage();
}

/** The last link copied without a click: every hook on screen sees it arrive, one copy is enough. */
let autoCopied: string | null = null;

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

  // The sign-in this component started copies its link as soon as it arrives.
  const url = state === "waiting" ? (data?.url ?? null) : null;
  const [copied, setCopied] = useState<{ url: string; ok: boolean } | null>(null);
  const ownsLink = mine && state === "waiting";
  useEffect(() => {
    if (!ownsLink || !url || autoCopied === url) return;
    autoCopied = url;
    void copySignInLink(url, false).then((ok) => setCopied({ url, ok }));
  }, [ownsLink, url]);
  const copy = async () => {
    if (!url) return;
    const ok = await copySignInLink(url, true);
    setCopied({ url, ok });
    if (ok) toast.success("Sign-in link copied", { id: "claude-link-copied" });
    else toast.error("Could not copy the link", { description: "Open the sign-in page instead." });
  };
  const link = { url, copied: copied?.url === url ? copied.ok : null, copy };

  return { status: data, state, mine: ownsLink, start, cancel, submit, link };
}

export type ClaudeLogin = ReturnType<typeof useClaudeLogin>;

/**
 * While the sign-in runs: approve it in the browser that opened. The link is on the clipboard for when no window
 * opened (or on a phone): that page shows a code to paste back here.
 */
export function ClaudeSignInSteps({ login, className }: { login: ClaudeLogin; className?: string }) {
  const id = useId();
  const [code, setCode] = useState("");
  const { url, copied, copy } = login.link;
  const send = () => {
    if (!code.trim()) return;
    login.submit.mutate(code.trim(), { onSuccess: () => setCode("") });
  };
  const openPage = () => {
    if (url) void openExternal(url);
  };

  return (
    <div className={cn("rounded-lg border bg-paper-2 p-3 text-xs", className)} aria-live="polite">
      <div className="flex items-center gap-2 text-[13px] font-medium">
        <Spinner className="size-3.5" />
        <span className="min-w-0 flex-1">{signsInFromAfar ? "Sign in on this device" : "Finish signing in in your browser"}</span>
        <Button type="button" size="xs" variant="ghost" className="-my-1 -mr-1.5 text-muted-foreground" onClick={() => login.cancel.mutate()} disabled={login.cancel.isPending}>
          Cancel
        </Button>
      </div>
      <p className="mt-1 leading-relaxed text-muted-foreground">
        {signsInFromAfar ? "Open the sign-in page, sign in with your Claude account and click " : "Sign in with your Claude account and click "}
        <span className="font-medium text-foreground">Authorize</span>.{signsInFromAfar ? " Then paste the code it shows below." : " This updates by itself."}
      </p>

      <div className="mt-2.5 rounded-md border bg-card p-2.5">
        {!url ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Spinner className="size-3" /> Getting the sign-in link…
          </p>
        ) : (
          <>
            {copied ? (
              <p className="flex items-start gap-2 leading-relaxed">
                <Check className="mt-px size-3.5 shrink-0 text-success" aria-hidden />
                <span>
                  <span className="font-medium">Sign-in link copied.</span>{" "}
                  <span className="text-muted-foreground">
                    {signsInFromAfar ? "Paste it into a browser on this device if the page did not open." : "No browser window opened? Paste it into your browser."}
                  </span>
                </span>
              </p>
            ) : (
              <p className="leading-relaxed text-muted-foreground">
                {signsInFromAfar ? "Open the page here, or copy the link into another browser." : "No browser window opened? Open the page, or copy the link into your browser."}
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button type="button" size="xs" variant={signsInFromAfar ? "default" : "outline"} className="h-7 px-2.5" onClick={openPage}>
                <ExternalLink /> Open sign-in page
              </Button>
              <Button type="button" size="xs" variant="outline" className="h-7 px-2.5" onClick={() => void copy()}>
                <Copy /> {copied ? "Copy again" : "Copy link"}
              </Button>
            </div>
          </>
        )}
      </div>

      {url && (
        <form
          className="mt-2.5 space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <label htmlFor={id} className="block text-muted-foreground">
            {signsInFromAfar ? "Code from the sign-in page" : "Got a code from the sign-in page? Paste it here."}
          </label>
          <div className="flex gap-2">
            <Input
              id={id}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Paste the code"
              className="h-8 bg-card font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
            <Button type="submit" size="sm" variant="outline" disabled={!code.trim() || login.submit.isPending}>
              {login.submit.isPending && <Spinner />} Continue
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
