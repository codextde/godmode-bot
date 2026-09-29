import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ExternalLink, RefreshCw, Smartphone } from "lucide-react";
import type { MobileDevice, MobilePairingOffer } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { DrawCheck } from "@/components/aicss/Motion";
import { api, errorMessage } from "@/lib/api";
import { openExternal } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { onServerEvent } from "@/lib/realtime";
import { useNow } from "@/components/vault/use-now";
import { cn } from "@/lib/utils";
import { QrCode } from "./qr-code";

export const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";

export function PairPhoneDialog({ open, onOpenChange, tailnet }: { open: boolean; onOpenChange: (open: boolean) => void; tailnet: string | null }) {
  const qc = useQueryClient();
  const [offer, setOffer] = useState<MobilePairingOffer | null>(null);
  const [paired, setPaired] = useState<MobileDevice | null>(null);
  const now = useNow(1000);

  const create = useMutation({
    mutationFn: api.mobile.pairing,
    onSuccess: (o) => {
      setOffer(o);
      void qc.invalidateQueries({ queryKey: qk.mobile });
    },
  });

  useEffect(() => {
    if (!open) return;
    setPaired(null);
    setOffer(null);
    create.mutate();
    const off = onServerEvent((e) => {
      if (e.type === "mobile.paired") setPaired(e.device);
    });
    return () => {
      off();
      void api.mobile.cancelPairing().catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const remaining = offer ? Math.max(0, Math.round((new Date(offer.expiresAt).getTime() - now) / 1000)) : 0;
  const expired = !!offer && remaining === 0;

  useEffect(() => {
    if (open && expired && !paired && !create.isPending) create.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, expired, paired]);

  const address = offer?.urls[0]?.replace(/^https?:\/\//, "");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[640px]">
        <DialogHeader className="border-b px-6 pt-6 pb-5 text-left">
          <DialogTitle className="text-lg font-medium tracking-[-0.02em]">Connect your phone</DialogTitle>
          <DialogDescription>Scan the code with the Godmode app. It works once and only for a few minutes.</DialogDescription>
        </DialogHeader>

        <AnimatePresence mode="wait" initial={false}>
          {paired ? (
            <motion.div
              key="paired"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex flex-col items-center px-6 pt-10 pb-8 text-center"
            >
              <div className="grid size-14 place-items-center rounded-full bg-brand-soft text-brand-strong">
                <DrawCheck className="size-7" />
              </div>
              <h3 className="mt-5 text-lg font-medium tracking-[-0.02em]">{paired.name} is connected</h3>
              <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
                Chats, agents and live screens are on your phone now. You can remove it anytime in this list.
              </p>
              <Button className="mt-7" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </motion.div>
          ) : (
            <motion.div key="code" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid gap-6 px-6 py-6 sm:grid-cols-[256px_1fr]">
              <div className="flex flex-col items-center gap-3">
                <div className="relative grid size-64 place-items-center rounded-2xl border bg-white p-3 shadow-card">
                  {offer && !create.isError ? (
                    <QrCode value={offer.link} label="Pairing code for the Godmode app" className={cn("size-full transition-opacity", create.isPending && "opacity-30")} />
                  ) : create.isError ? (
                    <div className="px-4 text-center">
                      <p className="text-sm font-medium text-[#1c1c1c]">No code yet</p>
                      <p className="mt-1 text-xs leading-relaxed text-[#75716a]">{errorMessage(create.error)}</p>
                    </div>
                  ) : (
                    <Spinner className="text-[#75716a]" />
                  )}
                </div>
                {offer && !create.isError ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
                    <ExpiryRing seconds={remaining} total={300} />
                    Expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
                    <Button variant="ghost" size="xs" className="-mr-2 text-muted-foreground" onClick={() => create.mutate()} disabled={create.isPending}>
                      <RefreshCw /> New code
                    </Button>
                  </div>
                ) : create.isError ? (
                  <Button variant="outline" size="sm" onClick={() => create.mutate()}>
                    <RefreshCw /> Try again
                  </Button>
                ) : null}
              </div>

              <div className="flex min-w-0 flex-col">
                <ol className="space-y-4">
                  <Step n={1} title="Get Tailscale on your phone">
                    Sign in with the same account as this computer{tailnet ? <> ({tailnet})</> : null}. Your phone reaches Godmode through it, never
                    over the internet.{" "}
                    <button type="button" className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-2 hover:underline" onClick={() => void openExternal(TAILSCALE_DOWNLOAD)}>
                      Download <ExternalLink className="size-3" />
                    </button>
                  </Step>
                  <Step n={2} title="Open the Godmode app">
                    Tap <span className="font-medium text-foreground">Scan QR code</span>, or point your camera app at the code.
                  </Step>
                  <Step n={3} title="Scan this code">
                    The phone gets its own key. This code can't be used again.
                  </Step>
                </ol>
                <div className="mt-auto flex items-center gap-2.5 rounded-lg border bg-paper-2 px-3 py-2.5 text-xs text-muted-foreground">
                  <Smartphone className="size-4 shrink-0 text-foreground" />
                  <span className="min-w-0">
                    Waiting for your phone
                    {address ? (
                      <>
                        {" "}
                        on <span className="font-mono text-[11px] text-foreground">{address}</span>
                      </>
                    ) : null}
                  </span>
                  <span className="ml-auto flex gap-1" aria-hidden>
                    {[0, 1, 2].map((i) => (
                      <motion.span
                        key={i}
                        className="size-1 rounded-full bg-muted-foreground"
                        animate={{ opacity: [0.25, 1, 0.25] }}
                        transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
                      />
                    ))}
                  </span>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid size-6 shrink-0 place-items-center rounded-full border bg-card text-xs font-medium tabular-nums shadow-card">{n}</span>
      <div className="min-w-0 pt-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{children}</p>
      </div>
    </li>
  );
}

function ExpiryRing({ seconds, total }: { seconds: number; total: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 -rotate-90" aria-hidden>
      <circle cx="8" cy="8" r={r} fill="none" className="stroke-border" strokeWidth="2" />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        className="stroke-brand transition-[stroke-dashoffset] duration-1000 ease-linear"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.min(1, seconds / total))}
      />
    </svg>
  );
}
