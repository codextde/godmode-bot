import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ClipboardPaste, MonitorSmartphone, RefreshCw, TriangleAlert } from "lucide-react";
import { parseRunnerCode, RUNNER_CODE_PREFIX, type RemoteRunner, type RunnerPairingOffer } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { DrawCheck } from "@/components/aicss/Motion";
import { InlineCode } from "@/components/onboarding/doctor-checklist";
import { ExpiryRing } from "@/components/settings/pair-phone-dialog";
import { useNow } from "@/components/vault/use-now";
import { api, errorMessage } from "@/lib/api";
import { useRunners } from "@/lib/hooks";
import { onServerEvent, upsertRunner } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { RunnerHealthPanel, useRunnerHealth } from "./runner-health";
import { CommandBlock, THIS_COMPUTER, THIS_COMPUTER_INLINE, blockingChecks } from "./runner-parts";
import { useRunnerActions } from "./use-runner-actions";

/** An offer is good for ten minutes; the ring empties over that time. */
const OFFER_SECONDS = 600;
const LICENSE_PLACEHOLDER = /GM-X{5}(?:-X{5}){3}/;

type Source = "local" | "website";

/**
 * Add a runner: one command, run on the other Mac, installs Godmode there and pairs it with this computer. The dialog
 * waits for it, then shows the runner getting ready. A pairing code pasted by hand works too.
 */
export function AddRunnerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const { data: runners } = useRunners();
  const [offer, setOffer] = useState<RunnerPairingOffer | null>(null);
  const [paired, setPaired] = useState<RemoteRunner | null>(null);
  const [byCode, setByCode] = useState(false);
  const [source, setSource] = useState<Source>("local");
  const now = useNow(1000);

  const create = useMutation({ mutationFn: api.runners.pairing, onSuccess: setOffer });

  useEffect(() => {
    if (!open) return;
    setPaired(null);
    setOffer(null);
    setByCode(false);
    setSource("local");
    create.mutate();
    const off = onServerEvent((e) => {
      if (e.type === "runner.paired") setPaired(e.runner);
    });
    return () => {
      off();
      void api.runners.cancelPairing().catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const remaining = offer ? Math.max(0, Math.round((new Date(offer.expiresAt).getTime() - now) / 1000)) : 0;
  const expired = !!offer && remaining === 0;

  // A command that ran out is replaced by a fresh one while the dialog waits.
  useEffect(() => {
    if (open && expired && !paired && !create.isPending) create.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, expired, paired]);

  // The list is kept live: the paired runner's connection and health follow it.
  const runner = paired ? (runners?.find((r) => r.id === paired.id) ?? paired) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[640px]">
        <DialogHeader className="shrink-0 border-b px-6 pt-6 pb-5 text-left">
          <DialogTitle className="text-lg font-medium tracking-[-0.02em]">Add a runner</DialogTitle>
          <DialogDescription>Another Mac that does the work of a chat — so it goes on while this one sleeps.</DialogDescription>
        </DialogHeader>

        <AnimatePresence mode="wait" initial={false}>
          {runner ? (
            <motion.div key="paired" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} className="flex min-h-0 flex-1 flex-col">
              <PairedView runner={runner} onDone={() => onOpenChange(false)} />
            </motion.div>
          ) : byCode ? (
            <motion.div key="code" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="min-h-0 flex-1 overflow-y-auto">
              <CodeForm
                now={now}
                onBack={() => setByCode(false)}
                onPaired={(r) => {
                  void upsertRunner(qc, r);
                  setPaired(r);
                }}
              />
            </motion.div>
          ) : (
            <motion.div key="command" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-6">
              <ol className="space-y-5">
                <Step n={1} title="Pick a Mac that stays on">
                  A Mac mini, or a laptop that stays plugged in. It has to reach this computer: on the same network, or through Tailscale.
                </Step>
                <Step n={2} title="Run this in Terminal on the other Mac">
                  {offer && !create.isError ? (
                    <div className={cn("space-y-2.5 transition-opacity", create.isPending && "opacity-40")}>
                      {offer.command ? (
                        <Tabs value={source} onValueChange={(v) => setSource(v as Source)} className="gap-2.5">
                          <TabsList className="grid w-full grid-cols-2">
                            <TabsTrigger value="local">Install from {THIS_COMPUTER_INLINE}</TabsTrigger>
                            <TabsTrigger value="website">Install from usegodmode.com</TabsTrigger>
                          </TabsList>
                          <TabsContent value="local" className="space-y-2.5">
                            <CommandBlock text={offer.command} title="Terminal on the other Mac" />
                            <p>It downloads Godmode from this computer, installs it as a runner and pairs it. The command works once.</p>
                          </TabsContent>
                          <TabsContent value="website" className="space-y-2.5">
                            <WebsiteCommand command={offer.websiteCommand} />
                          </TabsContent>
                        </Tabs>
                      ) : (
                        <WebsiteCommand command={offer.websiteCommand} />
                      )}
                      <div className="flex items-center gap-2 tabular-nums">
                        <ExpiryRing seconds={remaining} total={OFFER_SECONDS} />
                        Works for {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
                        <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => create.mutate()} disabled={create.isPending}>
                          <RefreshCw /> New command
                        </Button>
                      </div>
                    </div>
                  ) : create.isError ? (
                    <div className="rounded-lg border border-destructive/25 bg-destructive/[0.05] p-3.5" role="alert">
                      <p className="text-sm font-medium text-destructive">Couldn't make the install command</p>
                      <p className="mt-1 break-words">{errorMessage(create.error)}</p>
                      <Button variant="outline" size="sm" className="mt-3 text-foreground" onClick={() => create.mutate()}>
                        <RefreshCw /> Try again
                      </Button>
                    </div>
                  ) : (
                    <Skeleton className="h-36 rounded-lg" aria-label="Making the install command" />
                  )}
                </Step>
                <Step n={3} title="It pairs by itself">
                  The runner appears here when the command finishes — usually under a minute. The first time, it also installs Claude Code and a browser.
                </Step>
              </ol>

              {offer && !create.isError && (
                <div className="flex items-center gap-2.5 rounded-lg border bg-paper-2 px-3 py-2.5 text-xs text-muted-foreground" role="status">
                  <MonitorSmartphone className="size-4 shrink-0 text-foreground" />
                  <span className="min-w-0">
                    Waiting for the runner
                    {offer.urls[0] ? (
                      <>
                        {" "}
                        on <span className="font-mono text-[11px] break-all text-foreground">{offer.urls[0].replace(/^https?:\/\//, "")}</span>
                      </>
                    ) : null}
                  </span>
                  <span className="ml-auto flex shrink-0 gap-1" aria-hidden>
                    {[0, 1, 2].map((i) => (
                      <motion.span key={i} className="size-1 rounded-full bg-muted-foreground" animate={{ opacity: [0.25, 1, 0.25] }} transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }} />
                    ))}
                  </span>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                {create.isError ? "Already have a code from the runner?" : "Did the command print a code instead?"}{" "}
                <button
                  type="button"
                  onClick={() => setByCode(true)}
                  className="rounded-sm font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  Enter a pairing code instead
                </button>
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid size-6 shrink-0 place-items-center rounded-full border bg-card text-xs font-medium tabular-nums shadow-card">{n}</span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="text-sm font-medium">{title}</p>
        <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{children}</div>
      </div>
    </li>
  );
}

/** The install command through usegodmode.com, with the license placeholder marked: that part is the human's to fill in. */
function WebsiteCommand({ command }: { command: string }) {
  const match = LICENSE_PLACEHOLDER.exec(command);
  return (
    <>
      <CommandBlock text={command} title="Terminal on the other Mac">
        {match ? (
          <>
            {command.slice(0, match.index)}
            <mark className="rounded-[3px] bg-warning/20 px-0.5 font-medium text-foreground">{match[0]}</mark>
            {command.slice(match.index + match[0].length)}
          </>
        ) : undefined}
      </CommandBlock>
      <p>
        {match ? (
          <>
            Replace the <mark className="rounded-[3px] bg-warning/20 px-1 py-px font-medium text-foreground">highlighted part</mark> with your license key.{" "}
          </>
        ) : null}
        The other Mac downloads Godmode from usegodmode.com, installs it as a runner and pairs it. The command works once.
      </p>
    </>
  );
}

/** The other way to pair: the runner printed a `gmr1.` code (the command couldn't reach this computer, or `godmode runner pair`). */
function CodeForm({ now, onBack, onPaired }: { now: number; onBack: () => void; onPaired: (runner: RemoteRunner) => void }) {
  const [code, setCode] = useState("");
  const pair = useMutation({ mutationFn: (text: string) => api.runners.pair(text), onSuccess: onPaired });

  const text = code.trim();
  const parsed = text ? parseRunnerCode(text) : null;
  const expired = !!parsed && parsed.exp * 1000 < now;
  const problem = !text
    ? null
    : !parsed
      ? `That isn't a pairing code. It starts with \`${RUNNER_CODE_PREFIX}\` — copy all of it, line breaks don't matter.`
      : expired
        ? "This code has expired. Run `godmode runner pair` on the runner for a new one."
        : null;
  const ready = !!parsed && !expired;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready && !pair.isPending) pair.mutate(text);
  };

  return (
    <form onSubmit={submit} className="space-y-4 px-6 py-6">
      <div>
        <p className="text-sm font-medium">Paste the runner's pairing code</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          <InlineCode text="When the install command can't reach this computer, it prints a code. `godmode runner pair` on the runner prints a new one any time." />
        </p>
      </div>
      <Textarea
        value={code}
        onChange={(e) => {
          setCode(e.target.value);
          pair.reset();
        }}
        rows={5}
        autoFocus
        spellCheck={false}
        autoComplete="off"
        aria-label="Pairing code"
        aria-invalid={!!problem || undefined}
        placeholder={`${RUNNER_CODE_PREFIX}…`}
        className="max-h-48 font-mono text-[12px] break-all md:text-[12px]"
      />
      <div aria-live="polite">
        {problem ? (
          <p className="text-xs leading-relaxed text-destructive">
            <InlineCode text={problem} />
          </p>
        ) : pair.isError ? (
          <div className="flex items-start gap-2.5 rounded-lg border border-destructive/25 bg-destructive/[0.05] px-3 py-2.5 text-xs" role="alert">
            <TriangleAlert className="mt-px size-3.5 shrink-0 text-destructive" aria-hidden />
            <div className="min-w-0 space-y-0.5">
              <p className="font-medium text-destructive">Couldn't pair with {parsed?.name ?? "the runner"}</p>
              <p className="leading-relaxed break-words text-destructive/85">{errorMessage(pair.error)}</p>
            </div>
          </div>
        ) : parsed ? (
          <p className="flex items-center gap-2 rounded-lg border bg-paper-2 px-3 py-2.5 text-xs text-muted-foreground">
            <MonitorSmartphone className="size-4 shrink-0 text-foreground" aria-hidden />
            <span className="min-w-0">
              Pairs with <span className="font-medium text-foreground">{parsed.name}</span> at{" "}
              <span className="font-mono text-[11px] break-all text-foreground/85">
                {parsed.addresses[0] ?? parsed.hostname}:{parsed.port}
              </span>
            </span>
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={onBack}>
          <ArrowLeft /> Back to the install command
        </Button>
        <Button type="submit" disabled={!ready || pair.isPending}>
          {pair.isPending ? <Spinner /> : <ClipboardPaste />}
          {pair.isPending ? "Pairing…" : "Pair runner"}
        </Button>
      </div>
    </form>
  );
}

/** After pairing: the runner sets itself up, and the checks turn green one by one while the human watches. */
function PairedView({ runner, onDone }: { runner: RemoteRunner; onDone: () => void }) {
  const actions = useRunnerActions();
  const health = useRunnerHealth(runner);
  const online = runner.state === "online";
  const ready = online && !!health.data && blockingChecks(health.data).length === 0;

  return (
    <>
      <div className="flex shrink-0 items-start gap-4 px-6 pt-6 pb-5">
        <div className="grid size-11 shrink-0 place-items-center rounded-full bg-brand-soft text-brand-strong">
          <DrawCheck className="size-6" />
        </div>
        <div className="min-w-0">
          <h3 className="text-base font-medium tracking-[-0.01em]">{runner.name} is paired</h3>
          <p className="mt-1 text-sm text-muted-foreground" aria-live="polite">
            {ready
              ? `It's ready. Start a chat and pick ${runner.name} where it says “${THIS_COMPUTER}”.`
              : online
                ? "It's getting ready: your agents and logins are copied over, and it installs Claude Code and a browser. That takes a few minutes the first time."
                : `Godmode is connecting to it. If that takes long, check that ${runner.name} is awake and on the same network.`}
          </p>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto border-t bg-paper-2/40">
        <RunnerHealthPanel runner={runner} actions={actions} className="px-6 py-5" />
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-6 py-4">
        <p className="min-w-0 flex-1 basis-48 text-xs text-muted-foreground">
          {ready ? "You find it under Runners from now on." : "You can close this — it carries on by itself, and Runners shows how far it is."}
        </p>
        <Button onClick={onDone}>Done</Button>
      </div>
    </>
  );
}
