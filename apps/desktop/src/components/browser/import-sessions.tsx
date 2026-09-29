import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { AppWindow, ArrowLeft, ArrowRight, Check, Cookie, FileJson, KeyRound, Plus, RefreshCw, ShieldCheck, Upload } from "lucide-react";
import type { BrowserProfile, ChromeImportResult, LocalChromeProfile } from "@godmode/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { NoChromeProfiles } from "./no-chrome-profiles";
import { DrawCheck } from "@/components/aicss/Motion";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ChipInput } from "@/components/vault/chip-input";
import { domainFromUrl, toastApiError } from "@/components/vault/vault-utils";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

const SUGGESTED_DOMAINS = ["google.com", "github.com", "linkedin.com", "notion.so", "slack.com"];

/** Import cookies/sessions from local Chrome (or a cookie JSON) into a Godmode browser profile. */
export function ImportSessionsCard({
  profiles,
  defaultId,
  targetId,
  onTargetChange,
}: {
  profiles: BrowserProfile[];
  defaultId: string | null;
  targetId: string | null;
  onTargetChange: (id: string) => void;
}) {
  const target = profiles.find((p) => p.id === targetId) ?? null;
  return (
    <section className="@container rounded-xl border bg-card p-5 shadow-card">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg border bg-card text-foreground shadow-card">
            <Cookie className="size-[18px]" />
          </div>
          <div>
            <h2 className="text-[15px] leading-snug font-medium tracking-[-0.01em]">Import sessions</h2>
            <p className="mt-0.5 max-w-md text-xs text-muted-foreground">
              Continue where Chrome left off — copy your logged-in sessions so agents don't have to sign in again.
            </p>
          </div>
        </div>
        {profiles.length > 0 && (
          <div className="flex items-center gap-2">
            <Label htmlFor="import-target" className="text-xs text-muted-foreground">
              Into
            </Label>
            <Select value={targetId ?? undefined} onValueChange={onTargetChange}>
              <SelectTrigger id="import-target" size="sm" className="w-44">
                <SelectValue placeholder="Choose profile" />
              </SelectTrigger>
              <SelectContent>
                {profiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                    {p.id === defaultId && <span className="text-muted-foreground"> · default</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {!target ? (
        <p className="rounded-lg border border-dashed bg-paper-2/60 p-6 text-center text-sm text-muted-foreground">Create a browser profile first.</p>
      ) : (
        <Tabs defaultValue="chrome">
          <TabsList variant="line" className="mb-3">
            <TabsTrigger value="chrome">
              <AppWindow /> From Chrome
            </TabsTrigger>
            <TabsTrigger value="json">
              <FileJson /> Cookies JSON
            </TabsTrigger>
          </TabsList>
          <TabsContent value="chrome">
            <ChromeWizard target={target} />
          </TabsContent>
          <TabsContent value="json">
            <JsonImport target={target} />
          </TabsContent>
        </Tabs>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

type Step = 1 | 2 | 3;

function ChromeWizard({ target }: { target: BrowserProfile }) {
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>(1);
  const [source, setSource] = useState<LocalChromeProfile | null>(null);
  const [domains, setDomains] = useState<string[]>([]);
  const [result, setResult] = useState<ChromeImportResult | null>(null);

  const chrome = useQuery({ queryKey: qk.chromeProfiles, queryFn: api.browser.chromeProfiles, staleTime: 60_000 });

  const importMut = useMutation({
    mutationFn: () => api.browser.import(target.id, { sourcePath: source!.path, domains: domains.length ? domains : undefined }),
    onSuccess: (res) => {
      setResult(res);
      setStep(3);
      void qc.invalidateQueries({ queryKey: qk.browserProfiles });
    },
    onError: (e) => toastApiError(e, "Import failed", qc),
  });

  const reset = () => {
    setStep(1);
    setResult(null);
    setDomains([]);
  };

  // Changing the target profile restarts the flow.
  useEffect(reset, [target.id]);

  return (
    <div>
      <Stepper step={step} />
      <AnimatePresence mode="wait" initial={false}>
        {step === 1 && (
          <motion.div key="s1" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.18 }}>
            {chrome.isLoading ? (
              <div className="grid grid-cols-1 gap-2 @lg:grid-cols-2">
                {Array.from({ length: 2 }).map((_, i) => (
                  <Skeleton key={i} className="h-[68px] rounded-xl" />
                ))}
              </div>
            ) : chrome.isError ? (
              <div className="rounded-lg border border-destructive/25 bg-destructive/[0.05] p-4 text-sm">
                <p className="font-medium text-destructive">Couldn't look for Chrome profiles</p>
                <p className="mt-1 text-muted-foreground">{errorMessage(chrome.error)}</p>
                <Button size="sm" variant="outline" className="mt-3" onClick={() => chrome.refetch()}>
                  <RefreshCw /> Try again
                </Button>
              </div>
            ) : !chrome.data?.length ? (
              <NoChromeProfiles
                onRetry={() => chrome.refetch()}
                retrying={chrome.isFetching}
                footer="You can also import a cookie export in the “Cookies JSON” tab."
              />
            ) : (
              <div className="grid grid-cols-1 gap-2 @lg:grid-cols-2" role="radiogroup" aria-label="Chrome profile to import from">
                {chrome.data.map((p, i) => (
                  <ChromeProfileCard key={p.path} profile={p} index={i} selected={source?.path === p.path} onSelect={() => setSource(p)} />
                ))}
              </div>
            )}
            <div className="mt-4 flex justify-end">
              <Button onClick={() => setStep(2)} disabled={!source}>
                Next <ArrowRight />
              </Button>
            </div>
          </motion.div>
        )}

        {step === 2 && source && (
          <motion.div key="s2" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.18 }} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="import-domains">Only these sites (optional)</Label>
              <ChipInput
                id="import-domains"
                value={domains}
                onChange={setDomains}
                normalize={(s) => domainFromUrl(s)}
                validate={(s) => s.includes(".")}
                placeholder="Leave empty to import every site — or type a domain and press Enter"
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Suggestions:</span>
                {SUGGESTED_DOMAINS.filter((d) => !domains.includes(d)).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDomains((cur) => [...cur, d])}
                    className="inline-flex h-6 items-center gap-1 rounded-md border bg-card px-2 text-xs text-muted-foreground transition hover:border-foreground/25 hover:text-foreground"
                  >
                    <Plus className="size-3" /> {d}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-lg border bg-paper-2 p-3 text-xs text-muted-foreground">
              <KeyRound className="mt-0.5 size-4 shrink-0 text-foreground" />
              <p>
                On macOS you may see a Keychain prompt — allow access so Godmode can decrypt Chrome cookies. Cookies stay on this machine and are only
                copied into <span className="font-medium text-foreground">{target.name}</span>.
              </p>
            </div>
            <div className="flex items-center justify-between gap-2">
              <Button variant="ghost" onClick={() => setStep(1)}>
                <ArrowLeft /> Back
              </Button>
              <Button onClick={() => importMut.mutate()} disabled={importMut.isPending}>
                {importMut.isPending ? <Spinner /> : <Upload />}
                {importMut.isPending ? "Importing…" : domains.length ? `Import ${domains.length} site${domains.length === 1 ? "" : "s"}` : "Import all sessions"}
              </Button>
            </div>
          </motion.div>
        )}

        {step === 3 && result && (
          <motion.div key="s3" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
            <ImportResultView result={result} source={source ? `${source.browser} — ${source.name}` : "cookie file"} onAgain={reset} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  const steps = ["Choose profile", "Pick sites", "Done"];
  return (
    <ol className="mb-4 flex items-center gap-2 text-xs" aria-label="Import progress">
      {steps.map((label, i) => {
        const n = (i + 1) as Step;
        const done = step > n;
        const active = step === n;
        return (
          <li key={label} className="flex items-center gap-2" aria-current={active ? "step" : undefined}>
            <span
              className={cn(
                "grid size-5 place-items-center rounded-[5px] border font-mono text-[10px] font-medium transition-colors",
                done && "border-brand/25 bg-brand-soft text-brand-strong",
                active && "border-primary bg-primary text-primary-foreground",
                !done && !active && "text-muted-foreground",
              )}
            >
              {done ? <Check className="size-3" /> : n}
            </span>
            <span className={cn("hidden @md:inline", active ? "font-medium text-foreground" : "text-muted-foreground")}>{label}</span>
            {i < steps.length - 1 && <span className={cn("h-px w-6 bg-border", done && "bg-brand/50")} />}
          </li>
        );
      })}
    </ol>
  );
}

function ChromeProfileCard({ profile: p, index, selected, onSelect }: { profile: LocalChromeProfile; index: number; selected: boolean; onSelect: () => void }) {
  return (
    <motion.button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index, 12) * 0.03 }}
      className={cn(
        "relative flex items-center gap-3 rounded-lg border bg-card p-3 text-left shadow-card transition outline-none",
        "hover:border-foreground/15 hover:shadow-float focus-visible:ring-[3px] focus-visible:ring-ring/50",
        selected && "border-foreground/40 bg-paper-2 ring-1 ring-foreground/10 hover:border-foreground/40",
      )}
    >
      <div className={cn("grid size-9 shrink-0 place-items-center rounded-lg border text-foreground", selected ? "bg-card shadow-card" : "bg-paper-2")}>
        <AppWindow className="size-[18px]" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{p.name}</div>
        <div className="truncate text-xs text-muted-foreground">{p.email ?? "Not signed in"}</div>
        <div className="truncate text-[11px] text-muted-foreground/80">
          {p.browser} · <span className="font-mono">{p.profileDir}</span>
        </div>
      </div>
      <span
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded-full border transition",
          selected ? "border-primary bg-primary text-primary-foreground" : "border-input",
        )}
        aria-hidden
      >
        {selected && <Check className="size-3" />}
      </span>
    </motion.button>
  );
}

function ImportResultView({ result, source, onAgain }: { result: ChromeImportResult; source: string; onAgain: () => void }) {
  const shown = result.domains.slice(0, 24);
  const more = result.domains.length - shown.length;
  const ok = result.imported > 0;
  return (
    <div className="flex flex-col items-center py-2 text-center">
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}
        className={cn(
          "grid size-14 place-items-center rounded-xl border",
          ok ? "border-brand/25 bg-brand-soft text-brand-strong" : "bg-paper-2 text-muted-foreground",
        )}
      >
        {ok ? <DrawCheck className="size-7" /> : <Cookie className="size-7" />}
      </motion.div>
      <h3 className="mt-3 text-base font-medium tracking-[-0.01em]">
        {ok ? `Imported ${result.imported.toLocaleString()} cookie${result.imported === 1 ? "" : "s"}` : "No cookies imported"}
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        From {source}
        {result.skipped > 0 && ` · ${result.skipped.toLocaleString()} skipped (expired or not matching)`}
      </p>
      <Badge variant="outline" className="mt-2 font-mono text-[10px] font-normal text-muted-foreground">
        method: {result.method}
      </Badge>
      {shown.length > 0 && (
        <div className="mt-4 flex max-w-lg flex-wrap justify-center gap-1.5">
          {shown.map((d, i) => (
            <motion.span
              key={d}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.15 + Math.min(i, 20) * 0.02 }}
              className="inline-flex h-6 items-center rounded-[5px] border bg-card px-2 text-xs text-foreground"
            >
              {d}
            </motion.span>
          ))}
          {more > 0 && <span className="inline-flex h-6 items-center rounded-[5px] bg-secondary px-2 text-xs text-muted-foreground">+{more} more</span>}
        </div>
      )}
      {ok && (
        <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5 text-brand-strong" /> Agents using this profile are now signed in to these sites.
        </p>
      )}
      <Button variant="outline" size="sm" className="mt-4" onClick={onAgain}>
        <RefreshCw /> Import more
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function JsonImport({ target }: { target: BrowserProfile }) {
  const qc = useQueryClient();
  const [json, setJson] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<ChromeImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const trimmed = json.trim();
  const parseError = useMemo(() => {
    if (!trimmed) return null;
    try {
      JSON.parse(trimmed);
      return null;
    } catch {
      return "This isn't valid JSON yet.";
    }
  }, [trimmed]);

  const importMut = useMutation({
    mutationFn: () => api.browser.import(target.id, { cookiesJson: trimmed }),
    onSuccess: (res) => {
      setResult(res);
      void qc.invalidateQueries({ queryKey: qk.browserProfiles });
    },
    onError: (e) => toastApiError(e, "Import failed", qc),
  });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      toast.error("Can't read this file", { description: "Cookie files larger than 20 MB aren't supported." });
      return;
    }
    setJson(await file.text());
    setFileName(file.name);
  };

  if (result) {
    return (
      <ImportResultView
        result={result}
        source={fileName ?? "pasted JSON"}
        onAgain={() => {
          setResult(null);
          setJson("");
          setFileName(null);
        }}
      />
    );
  }

  return (
    <div
      className="space-y-3"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void onFile(e.dataTransfer.files[0]);
      }}
    >
      <p className="text-xs text-muted-foreground">
        Paste cookies exported by <span className="font-mono">profile-use</span>, a cookie-editor extension or a Playwright <span className="font-mono">storage_state</span>{" "}
        file — or drop the file here.
      </p>
      <Textarea
        aria-label="Cookies JSON"
        value={json}
        onChange={(e) => {
          setJson(e.target.value);
          setFileName(null);
        }}
        placeholder='[{ "name": "session", "value": "…", "domain": ".example.com", "path": "/" }]'
        spellCheck={false}
        aria-invalid={!!parseError}
        className="max-h-64 min-h-36 font-mono text-xs"
      />
      {parseError && <p className="text-xs text-destructive">{parseError}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            <FileJson /> Choose file…
          </Button>
          {fileName && <span className="max-w-48 truncate text-xs text-muted-foreground">{fileName}</span>}
        </div>
        <Button onClick={() => importMut.mutate()} disabled={!trimmed || !!parseError || importMut.isPending}>
          {importMut.isPending ? <Spinner /> : <Upload />} Import into {target.name}
        </Button>
      </div>
    </div>
  );
}
