import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Check, ExternalLink, RotateCcw, ShieldCheck, TriangleAlert } from "lucide-react";
import type { ComposioConnectResult, ComposioToolkit } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage } from "@/lib/api";
import { openExternal } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { useAllAgents, useWorkspaces } from "@/lib/hooks";
import { isVaultLocked, toastApiError } from "@/components/vault/vault-utils";
import { toast } from "sonner";
import { ScopePicker, useDefaultScope, type IntegrationScope } from "./scope-picker";
import { ToolkitLogo } from "./toolkit-logo";

const POLL_MS = 2_500;
const TIMEOUT_MS = 5 * 60_000;
const FAILED = new Set(["FAILED", "EXPIRED", "REVOKED", "INACTIVE", "DELETED"]);

type Phase =
  | { kind: "configure" }
  | { kind: "starting" }
  | { kind: "waiting"; result: ComposioConnectResult }
  | { kind: "success" }
  | { kind: "error"; message: string };

/** Connect a Composio toolkit account: choose scope → OAuth in the browser → poll until ACTIVE. */
export function ComposioConnectDialog({ toolkit, onOpenChange }: { toolkit: ComposioToolkit | null; onOpenChange: (open: boolean) => void }) {
  const open = !!toolkit;
  const qc = useQueryClient();
  const defaultScope = useDefaultScope();
  const [scope, setScope] = useState<IntegrationScope>(defaultScope);
  const [phase, setPhase] = useState<Phase>({ kind: "configure" });
  const [lastToolkit, setLastToolkit] = useState<ComposioToolkit | null>(toolkit);
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const cancelled = useRef(false);

  // Reset whenever the dialog opens (render-time adjustment avoids a flash of the previous phase).
  const slug = toolkit?.slug ?? null;
  if (slug !== openedFor) {
    setOpenedFor(slug);
    if (toolkit) {
      setLastToolkit(toolkit);
      setScope(defaultScope);
      setPhase({ kind: "configure" });
    }
  }
  useEffect(() => {
    cancelled.current = !slug;
  }, [slug]);

  const t = toolkit ?? lastToolkit;

  const finish = (ok: boolean, message?: string) => {
    void qc.invalidateQueries({ queryKey: qk.composio });
    void qc.invalidateQueries({ queryKey: qk.mcpServers });
    if (ok) {
      setPhase({ kind: "success" });
      toast.success(`${t?.name ?? "App"} connected`, { description: "Your agents can use it right away." });
    } else setPhase({ kind: "error", message: message ?? "The connection did not complete." });
  };

  // Poll the connection status while waiting for the OAuth round-trip.
  useEffect(() => {
    if (phase.kind !== "waiting") return;
    const { connectedAccountId } = phase.result;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let connectionId: string | null = null;
    let stop = false;

    const tick = async () => {
      if (stop || cancelled.current) return;
      try {
        if (!connectionId) {
          const list = await api.composio.connections();
          qc.setQueryData(qk.composioConnections, list);
          connectionId = list.find((c) => c.connectedAccountId === connectedAccountId)?.id ?? null;
        }
        if (connectionId) {
          const conn = await api.composio.refresh(connectionId);
          const status = conn.status.toUpperCase();
          if (status === "ACTIVE") return finish(true);
          if (FAILED.has(status)) return finish(false, `Composio reports the connection as ${status.toLowerCase()}.`);
        }
      } catch (e) {
        if (isVaultLocked(e)) {
          toastApiError(e, "", qc);
          return finish(false, "The vault was locked.");
        }
        /* transient — keep polling */
      }
      if (stop || cancelled.current) return;
      if (Date.now() - started > TIMEOUT_MS) return finish(false, "Timed out waiting for the sign-in to finish. You can try again.");
      timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, 1_200);
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [phase]);

  const start = async () => {
    if (!t) return;
    setPhase({ kind: "starting" });
    try {
      const result = await api.composio.connect({ toolkit: t.slug, workspaceId: scope.workspaceId, agentId: scope.agentId });
      if (cancelled.current) return;
      if (result.redirectUrl) {
        void openExternal(result.redirectUrl);
        setPhase({ kind: "waiting", result });
      } else if (result.status.toUpperCase() === "ACTIVE") finish(true);
      else setPhase({ kind: "waiting", result });
    } catch (e) {
      if (isVaultLocked(e)) toastApiError(e, "", qc);
      setPhase({ kind: "error", message: errorMessage(e) });
    }
  };

  const close = () => onOpenChange(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-2xl sm:max-w-xl">
        <DialogHeader className="flex-row items-center gap-3 space-y-0 text-left">
          {t && <ToolkitLogo src={t.logo} name={t.name} size="lg" />}
          <div className="min-w-0">
            <DialogTitle>Connect {t?.name}</DialogTitle>
            <DialogDescription className="mt-1 line-clamp-2">{t?.description || "Give your agents access through Composio."}</DialogDescription>
          </div>
        </DialogHeader>

        <AnimatePresence mode="wait" initial={false}>
          {(phase.kind === "configure" || phase.kind === "starting") && (
            <motion.div key="configure" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className="space-y-4">
              <div>
                <p className="mb-2 text-sm font-medium">Who can use this account?</p>
                <ScopePicker value={scope} onChange={setScope} disabled={phase.kind === "starting"} />
              </div>
              <div className="flex items-start gap-2.5 rounded-xl border bg-muted/30 p-3 text-xs text-muted-foreground">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
                {t?.noAuth
                  ? "This app doesn't need a sign-in — it's enabled right away."
                  : `You'll sign in on ${t?.name ?? "the app"}'s own page in your browser. Godmode never sees that password; Composio stores the resulting token.`}
              </div>
            </motion.div>
          )}

          {phase.kind === "waiting" && (
            <motion.div key="waiting" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className="flex flex-col items-center py-4 text-center">
              <div className="relative grid size-16 place-items-center">
                <span className="absolute inset-0 animate-ping rounded-full bg-primary/15" />
                <span className="absolute inset-1 rounded-full bg-primary/10" />
                <Spinner className="relative size-7 text-primary" />
              </div>
              <p className="mt-4 text-sm font-medium">Waiting for you to finish in the browser…</p>
              <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                Sign in to {t?.name} and approve access. This window updates automatically once Composio confirms the connection.
              </p>
              {phase.result.redirectUrl && (
                <button
                  type="button"
                  className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                  onClick={() => void openExternal(phase.result.redirectUrl!)}
                >
                  Browser didn't open? Open the sign-in page again <ExternalLink className="size-3" />
                </button>
              )}
            </motion.div>
          )}

          {phase.kind === "success" && (
            <motion.div key="success" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="flex flex-col items-center py-4 text-center">
              <motion.div
                initial={{ scale: 0, rotate: -30 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: "spring", stiffness: 260, damping: 14 }}
                className="relative grid size-16 place-items-center rounded-full bg-success text-white shadow-lg shadow-success/30"
              >
                <Check className="size-8" strokeWidth={3} />
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <motion.span
                    key={i}
                    className="absolute size-1.5 rounded-full bg-success"
                    initial={{ x: 0, y: 0, opacity: 1 }}
                    animate={{ x: Math.cos((i / 6) * Math.PI * 2) * 44, y: Math.sin((i / 6) * Math.PI * 2) * 44, opacity: 0 }}
                    transition={{ duration: 0.7, delay: 0.15, ease: "easeOut" }}
                  />
                ))}
              </motion.div>
              <p className="mt-4 text-sm font-medium">{t?.name} is connected</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Available to <ScopeSummary scope={scope} /> from their next run.
              </p>
            </motion.div>
          )}

          {phase.kind === "error" && (
            <motion.div key="error" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center py-4 text-center">
              <div className="grid size-14 place-items-center rounded-full bg-destructive/15 text-destructive">
                <TriangleAlert className="size-7" />
              </div>
              <p className="mt-4 text-sm font-medium">Couldn't connect {t?.name}</p>
              <p className="mt-1 max-w-sm text-xs text-muted-foreground">{phase.message}</p>
            </motion.div>
          )}
        </AnimatePresence>

        <DialogFooter>
          {(phase.kind === "configure" || phase.kind === "starting") && (
            <>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button className="bg-gradient-brand text-white shadow-md shadow-glow-a/25 hover:opacity-95" onClick={start} disabled={phase.kind === "starting"}>
                {phase.kind === "starting" ? <Spinner /> : <ArrowRight />}
                {phase.kind === "starting" ? "Starting…" : t?.noAuth ? "Enable" : `Continue to ${t?.name ?? "sign-in"}`}
              </Button>
            </>
          )}
          {phase.kind === "waiting" && (
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
          )}
          {phase.kind === "success" && <Button onClick={close}>Done</Button>}
          {phase.kind === "error" && (
            <>
              <Button variant="ghost" onClick={close}>
                Close
              </Button>
              <Button onClick={() => setPhase({ kind: "configure" })}>
                <RotateCcw /> Try again
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScopeSummary({ scope }: { scope: IntegrationScope }) {
  const { data: workspaces = [] } = useWorkspaces();
  const { data: agents = [] } = useAllAgents();
  if (scope.agentId) return <strong className="font-medium text-foreground">{agents.find((a) => a.id === scope.agentId)?.name ?? "the agent"}</strong>;
  if (scope.workspaceId)
    return <strong className="font-medium text-foreground">agents in {workspaces.find((w) => w.id === scope.workspaceId)?.name ?? "the workspace"}</strong>;
  return <strong className="font-medium text-foreground">every agent</strong>;
}
