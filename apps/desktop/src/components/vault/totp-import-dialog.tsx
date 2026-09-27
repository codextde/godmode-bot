import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { Camera, ChevronDown, CircleCheck, ImagePlus, Keyboard, Lock, ScanQrCode, Smartphone, TriangleAlert } from "lucide-react";
import type { TotpImportResult } from "@godmode/shared";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { api } from "@/lib/api";
import { isOtpUri, parseOtpUri } from "@/lib/qr";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { CameraScanner } from "./camera-scanner";
import { Favicon } from "./favicon";
import { OtpPreviewList, useParsedUris } from "./otp-preview-list";
import { PasteHint, QrDropZone, useQrImages } from "./qr-drop-zone";
import { TotpManualForm } from "./totp-manual-form";
import { issuerDomain } from "./use-totp-codes";
import { WorkspaceSelect } from "./workspace-select";
import { toastApiError } from "./vault-utils";

type Tab = "images" | "camera" | "manual";

export function TotpImportDialog({
  open,
  onOpenChange,
  defaultWorkspaceId,
  initialTab = "images",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultWorkspaceId: string | null;
  initialTab?: Tab;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-2xl">
        {open && <ImportFlow defaultWorkspaceId={defaultWorkspaceId} initialTab={initialTab} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function ImportFlow({ defaultWorkspaceId, initialTab, onClose }: { defaultWorkspaceId: string | null; initialTab: Tab; onClose: () => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [workspaceId, setWorkspaceId] = useState<string | null>(defaultWorkspaceId);
  const images = useQrImages();
  const [direct, setDirect] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [result, setResult] = useState<TotpImportResult | null>(null);

  const allFound = useMemo(() => {
    const set = new Set<string>();
    for (const img of images.items) for (const f of img.found) if (isOtpUri(f)) set.add(f);
    for (const d of direct) set.add(d);
    return set;
  }, [images.items, direct]);
  const uris = useMemo(() => [...allFound].filter((u) => !excluded.has(u)), [allFound, excluded]);
  const known = useMemo(() => new Set(uris), [uris]);
  const { accountCount } = useParsedUris(uris);
  const decoding = images.items.some((i) => i.status === "decoding");

  const addDirect = (uri: string) => {
    setExcluded((prev) => {
      if (!prev.has(uri)) return prev;
      const next = new Set(prev);
      next.delete(uri);
      return next;
    });
    setDirect((prev) => (prev.includes(uri) ? prev : [...prev, uri]));
  };

  // Paste screenshots (or otpauth links) anywhere in the dialog.
  useEffect(() => {
    if (result || tab === "manual") return;
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
        .map((i) => i.getAsFile())
        .filter((f): f is File => !!f);
      if (files.length) {
        e.preventDefault();
        images.addFiles(files);
        setTab("images");
        return;
      }
      const text = e.clipboardData?.getData("text")?.trim();
      if (text && isOtpUri(text)) {
        e.preventDefault();
        addDirect(text);
        toast.success("Link added to the import list");
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [result, tab, images.addFiles]);

  // Files dropped anywhere on the dialog (outside the drop zone) must not navigate the webview.
  useEffect(() => {
    if (result) return;
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      if (e.dataTransfer?.files?.length && images.addFiles(e.dataTransfer.files) > 0) setTab("images");
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [result, images.addFiles]);

  const doImport = useMutation({
    mutationFn: () => api.totp.import({ workspaceId, uris }),
    onSuccess: (res) => {
      setResult(res);
      void qc.invalidateQueries({ queryKey: qk.totp });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
      if (res.imported.length) toast.success(`Imported ${res.imported.length} ${res.imported.length === 1 ? "account" : "accounts"}`);
    },
    onError: (e) => toastApiError(e, "Import failed", qc),
  });

  const reset = () => {
    images.clear();
    setDirect([]);
    setExcluded(new Set());
    setResult(null);
    setTab("images");
  };

  return (
    <div className="flex max-h-[min(90vh,860px)] flex-col">
      <div className="flex items-start gap-3.5 px-6 pt-6 pb-4">
        <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-gradient-brand text-white shadow-lg shadow-glow-a/25">
          <ScanQrCode className="size-5" />
        </div>
        <div className="min-w-0 pr-8">
          <DialogTitle className="text-lg">Import 2FA codes</DialogTitle>
          <DialogDescription className="mt-1">
            Scan QR codes from Google Authenticator, another authenticator app, or a site's 2FA setup page.
          </DialogDescription>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-5">
        {result ? (
          <ImportResultView result={result} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-muted/30 px-3 py-2.5">
              <Label htmlFor="totp-import-scope" className="shrink-0 text-xs text-muted-foreground">
                Save to
              </Label>
              <WorkspaceSelect id="totp-import-scope" value={workspaceId} onChange={setWorkspaceId} className="h-8 w-56 bg-background/60" />
              <span className="text-[11px] text-muted-foreground">{workspaceId ? "Only agents in this workspace can use them." : "Agents in every workspace can use them."}</span>
            </div>

            <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="images">
                  <ImagePlus /> Screenshots
                </TabsTrigger>
                <TabsTrigger value="camera">
                  <Camera /> Camera
                </TabsTrigger>
                <TabsTrigger value="manual">
                  <Keyboard /> Setup key
                </TabsTrigger>
              </TabsList>
              <TabsContent value="images" className="space-y-4 pt-3">
                <QrDropZone items={images.items} onFiles={images.addFiles} onRemove={images.remove} />
                {images.items.length === 0 && <PasteHint />}
                <GoogleAuthenticatorGuide defaultOpen={images.items.length === 0 && direct.length === 0} />
              </TabsContent>
              <TabsContent value="camera" className="pt-3">
                <CameraScanner known={known} onCode={addDirect} />
              </TabsContent>
              <TabsContent value="manual" className="pt-3">
                <TotpManualForm workspaceId={workspaceId} onCreated={onClose} />
              </TabsContent>
            </Tabs>

            {tab !== "manual" && (
              <OtpPreviewList
                uris={uris}
                onRemove={(uri) =>
                  setExcluded((prev) => {
                    const next = new Set(prev);
                    next.add(uri);
                    return next;
                  })
                }
              />
            )}
          </>
        )}
      </div>

      {(result || tab !== "manual") && (
        <div className="flex flex-col-reverse gap-3 border-t bg-muted/30 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="size-3.5 shrink-0" /> QR codes are decoded on this device · secrets go straight into your encrypted vault
          </p>
          <div className="flex justify-end gap-2">
            {result ? (
              <>
                <Button variant="ghost" onClick={reset}>
                  Import more
                </Button>
                <Button onClick={onClose}>Done</Button>
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={onClose} disabled={doImport.isPending}>
                  Cancel
                </Button>
                <Button onClick={() => doImport.mutate()} disabled={uris.length === 0 || doImport.isPending || decoding} className="min-w-32">
                  {doImport.isPending || decoding ? <Spinner /> : null}
                  {decoding ? "Scanning…" : accountCount > 0 ? `Import ${accountCount} ${accountCount === 1 ? "account" : "accounts"}` : "Import"}
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function GoogleAuthenticatorGuide({ defaultOpen }: { defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const steps = [
    "Open Google Authenticator on your phone.",
    "Tap the menu (⋮ or ☰) → Transfer accounts → Export accounts.",
    "Select the accounts and tap Next — one or more QR codes appear.",
    "Screenshot every QR code (swipe to the next one) and drop the screenshots here — or point the Camera tab at them.",
  ];
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border bg-card/50">
      <CollapsibleTrigger asChild>
        <button type="button" className="flex w-full items-center gap-2.5 px-3.5 py-3 text-left text-sm font-medium">
          <Smartphone className="size-4 text-primary" />
          <span className="flex-1">Moving from Google Authenticator?</span>
          <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="space-y-2.5 px-3.5 pb-3.5">
          {steps.map((s, i) => (
            <li key={i} className="flex gap-3 text-sm">
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/12 text-[11px] font-semibold text-primary">{i + 1}</span>
              <span className="text-foreground/85">{s}</span>
            </li>
          ))}
        </ol>
        <p className="border-t px-3.5 py-2.5 text-xs text-muted-foreground">
          Other apps (Authy, 1Password, Microsoft Authenticator…) and most websites also show a QR code when you set up 2FA — screenshots of those work too.
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function skippedLabel(item: TotpImportResult["skipped"][number]): string {
  if (item.label) return item.label;
  const p = parseOtpUri(item.uri);
  if (p.kind === "otpauth") return p.preview.account ? `${p.preview.issuer} · ${p.preview.account}` : p.preview.issuer;
  if (p.kind === "migration") return "Google Authenticator export";
  return "Unknown code";
}

function ImportResultView({ result }: { result: TotpImportResult }) {
  const ok = result.imported.length > 0;
  return (
    <div className="space-y-5">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center pt-2 text-center">
        <motion.div
          initial={{ scale: 0.4, rotate: -20 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 14 }}
          className={cn(
            "grid size-14 place-items-center rounded-full text-white shadow-lg",
            ok ? "bg-success shadow-success/30" : "bg-warning shadow-warning/30",
          )}
        >
          {ok ? <CircleCheck className="size-7" /> : <TriangleAlert className="size-7" />}
        </motion.div>
        <h3 className="mt-3 text-base font-semibold">
          {ok ? `Imported ${result.imported.length} ${result.imported.length === 1 ? "account" : "accounts"}` : "Nothing was imported"}
        </h3>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {ok ? "Your agents can now complete two-factor sign-ins for these accounts. Link each code to its login so it's typed in automatically." : "Every code was skipped — see why below."}
        </p>
      </motion.div>

      {ok && (
        <div className="divide-y overflow-hidden rounded-xl border bg-card/60">
          {result.imported.map((t, i) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i, 12) * 0.03 }}
              className="flex items-center gap-3 px-3 py-2.5"
            >
              <Favicon domain={issuerDomain(t.issuer)} name={t.issuer} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{t.issuer}</p>
                {t.accountName && <p className="truncate text-xs text-muted-foreground">{t.accountName}</p>}
              </div>
              <CircleCheck className="size-4 text-success" />
            </motion.div>
          ))}
        </div>
      )}

      {result.skipped.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Skipped ({result.skipped.length})</p>
          <div className="divide-y overflow-hidden rounded-xl border border-warning/25 bg-warning/5">
            {result.skipped.map((s, i) => (
              <div key={`${s.uri}-${i}`} className="flex items-start gap-3 px-3 py-2.5">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{skippedLabel(s)}</p>
                  <p className="text-xs text-muted-foreground">{s.reason}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
