import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { AppWindow, CircleCheck, Cookie, Info, UserRound } from "lucide-react";
import type { ChromeImportResult, LocalChromeProfile } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";
import { isMac } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { NoChromeProfiles } from "@/components/browser/no-chrome-profiles";
import { DrawCheck } from "@/components/aicss/Motion";
import { FormError, SubmitButton } from "./auth-layout";
import { StepCard, StepFooter, StepHeader } from "./step-kit";

export function BrowserStep({ onDone, onBack }: { onDone: (imported: number | null) => void; onBack: () => void }) {
  const chrome = useQuery({ queryKey: qk.chromeProfiles, queryFn: api.browser.chromeProfiles, retry: false });
  const [selected, setSelected] = useState<string | null>(null);
  const [result, setResult] = useState<ChromeImportResult | null>(null);

  const importMut = useMutation({
    mutationFn: async (profile: LocalChromeProfile) => {
      const profiles = await api.browser.profiles();
      const target = profiles.find((p) => p.isDefault) ?? profiles.find((p) => !p.workspaceId) ?? profiles[0];
      if (!target) throw new Error("No Godmode browser profile exists yet — try again from the Browser page later.");
      return api.browser.import(target.id, { sourcePath: profile.path });
    },
    onSuccess: setResult,
  });

  const profiles = chrome.data ?? [];
  const chosen = profiles.find((p) => p.path === selected) ?? null;

  return (
    <div>
      <StepHeader
        eyebrow="Browser sessions · optional"
        title="Continue where Chrome left off."
        description="Import your Chrome sign-ins into Godmode's own browser so agents start already logged in to the sites you use."
      />
      <StepCard>
        <AnimatePresence mode="wait" initial={false}>
          {result ? (
            <motion.div
              key="result"
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              className="rounded-xl border border-success/25 bg-success/[0.06] p-5"
            >
              <div className="flex items-center gap-3">
                <motion.div
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: "spring", stiffness: 300, damping: 20 }}
                  className="grid size-9 shrink-0 place-items-center rounded-lg border border-success/25 bg-card text-success shadow-card"
                >
                  <DrawCheck className="size-5" />
                </motion.div>
                <div>
                  <p className="font-medium">
                    Imported {result.imported.toLocaleString()} cookies from {result.domains.length.toLocaleString()} sites
                  </p>
                  {result.skipped > 0 && <p className="text-xs text-muted-foreground">{result.skipped.toLocaleString()} expired or unsupported cookies skipped.</p>}
                </div>
              </div>
              {result.domains.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {result.domains.slice(0, 18).map((d) => (
                    <span key={d} className="rounded-[5px] border bg-card px-1.5 py-0.5 text-xs text-muted-foreground">
                      {d}
                    </span>
                  ))}
                  {result.domains.length > 18 && <span className="px-1 text-xs text-muted-foreground">+{result.domains.length - 18} more</span>}
                </div>
              )}
            </motion.div>
          ) : (
            <motion.div key="pick" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              {chrome.isLoading ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Skeleton className="h-[72px] rounded-lg" />
                  <Skeleton className="h-[72px] rounded-lg" />
                </div>
              ) : chrome.isError ? (
                <div className="flex items-start gap-3 rounded-xl border border-dashed bg-paper-2/60 p-5 text-sm">
                  <AppWindow className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="font-medium">Couldn't look for Chrome profiles</p>
                    <p className="mt-1 text-muted-foreground">{errorMessage(chrome.error)} You can import sessions later from the Browser page.</p>
                  </div>
                </div>
              ) : profiles.length === 0 ? (
                <NoChromeProfiles onRetry={() => chrome.refetch()} retrying={chrome.isFetching} footer="Or skip — you can import sessions later from the Browser page." />
              ) : (
                <div role="radiogroup" aria-label="Chrome profile" className="grid gap-2 sm:grid-cols-2">
                  {profiles.map((p, i) => {
                    const active = p.path === selected;
                    return (
                      <motion.button
                        key={p.path}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: Math.min(i, 12) * 0.03 }}
                        onClick={() => setSelected(p.path)}
                        className={cn(
                          "flex items-center gap-3 rounded-lg border bg-card p-3.5 text-left transition hover:border-foreground/20 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                          active && "border-foreground/40 bg-paper-2 ring-[3px] ring-foreground/[0.06]",
                        )}
                      >
                        <div className="grid size-10 shrink-0 place-items-center rounded-full border bg-secondary text-muted-foreground">
                          <UserRound className="size-5" />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{p.name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {p.browser}
                            {p.email ? ` · ${p.email}` : ` · ${p.profileDir}`}
                          </p>
                        </div>
                        {active && <CircleCheck className="ml-auto size-4 shrink-0 text-foreground" />}
                      </motion.button>
                    );
                  })}
                </div>
              )}
              <div className="mt-4 flex items-start gap-2.5 rounded-lg bg-paper-2 p-3 text-xs leading-relaxed text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  Cookies are copied into Godmode's browser on this machine and never uploaded.
                  {isMac && " macOS may ask for Keychain access — allow it so Chrome's cookies can be decrypted."}
                </span>
              </div>
              {importMut.isError && (
                <div className="mt-3">
                  <FormError message={errorMessage(importMut.error)} />
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        <StepFooter onBack={onBack}>
          {result ? (
            <SubmitButton busy={false} type="button" onClick={() => onDone(result.imported)} className="w-auto px-6">
              Continue
            </SubmitButton>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={() => onDone(null)}>
                Skip for now
              </Button>
              <SubmitButton
                busy={importMut.isPending}
                disabled={!chosen}
                type="button"
                onClick={() => chosen && importMut.mutate(chosen)}
                className="w-auto px-6"
              >
                <Cookie /> {importMut.isPending ? "Importing…" : "Import sessions"}
              </SubmitButton>
            </>
          )}
        </StepFooter>
      </StepCard>
    </div>
  );
}
