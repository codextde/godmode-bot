import { useRef, useState, type DragEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ArchiveRestore, CircleCheckBig, Download, FileArchive, HardDriveDownload, Upload, X } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { PasswordInput } from "@/components/vault/password-input";
import { StrengthMeter } from "@/components/vault/strength-meter";
import { toastApiError } from "@/components/vault/vault-utils";
import { ApiRequestError, api } from "@/lib/api";
import { saveBlob } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { Callout, SectionHeading, SettingRow, SettingsGroup } from "./settings-kit";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function ExportCard() {
  const qc = useQueryClient();
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [repos, setRepos] = useState(true);
  const [browser, setBrowser] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const mismatch = confirm.length > 0 && confirm !== pass;
  const valid = pass.length >= 8 && pass === confirm;

  const exportMut = useMutation({
    mutationFn: async () => {
      const blob = await api.backup.export({ passphrase: pass, includeAgentRepos: repos, includeBrowserProfiles: browser });
      const name = `godmode-backup-${new Date().toISOString().slice(0, 10)}.godmode-backup`;
      const saved = await saveBlob(blob, name);
      return { saved, name, size: blob.size };
    },
    onSuccess: ({ saved, name, size }) => {
      if (!saved) return;
      setDone(`${name} · ${formatBytes(size)}`);
      setPass("");
      setConfirm("");
      toast.success("Backup saved", { description: "Store it somewhere safe — and remember its passphrase." });
    },
    onError: (e) => toastApiError(e, "Backup failed", qc),
  });

  return (
    <SettingsGroup
      title="Export backup"
      icon={<HardDriveDownload />}
      description="A single encrypted file with your settings, agents, routines, vault (logins + 2FA) and integrations."
    >
      <form
        className="space-y-4 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) exportMut.mutate();
        }}
      >
        <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="bk-pass">Backup passphrase</Label>
            <PasswordInput id="bk-pass" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="At least 8 characters" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bk-confirm">Confirm passphrase</Label>
            <PasswordInput id="bk-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={mismatch} />
            {mismatch && (
              <p role="alert" className="text-xs text-destructive">
                Passphrases don't match.
              </p>
            )}
          </div>
        </div>
        <StrengthMeter password={pass} />
        <p className="text-xs leading-relaxed text-muted-foreground">
          The file is encrypted with this passphrase (it can differ from your vault passphrase). Without it the backup can't be restored — nobody,
          including us, can recover it.
        </p>
        <div className="divide-y rounded-lg border bg-paper-2 px-4">
          <SettingRow label="Include agent repositories" htmlFor="bk-repos" description="Memory, transcripts and files agents produced.">
            <Switch id="bk-repos" checked={repos} onCheckedChange={setRepos} />
          </SettingRow>
          <SettingRow
            label="Include browser profiles"
            htmlFor="bk-browser"
            description="Logged-in sessions and cookies. Makes the file much larger and more sensitive."
          >
            <Switch id="bk-browser" checked={browser} onCheckedChange={setBrowser} />
          </SettingRow>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <AnimatePresence>
            {done && (
              <motion.p
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                className="flex min-w-0 items-center gap-1.5 text-xs text-success"
              >
                <CircleCheckBig className="size-3.5 shrink-0" /> <span className="truncate">Saved {done}</span>
              </motion.p>
            )}
          </AnimatePresence>
          <Button type="submit" className="ml-auto" disabled={!valid || exportMut.isPending}>
            {exportMut.isPending ? <Spinner /> : <Download />}
            {exportMut.isPending ? "Encrypting…" : "Export backup"}
          </Button>
        </div>
      </form>
    </SettingsGroup>
  );
}

function ImportCard() {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [pass, setPass] = useState("");
  const [dragging, setDragging] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, number> | null>(null);

  const importMut = useMutation({
    mutationFn: () => api.backup.import(file!, pass),
    onSuccess: (res) => {
      setResult(res.counts ?? {});
      setFile(null);
      setPass("");
      toast.success("Backup restored", {
        description: "Vault restored and locked — unlock with the vault passphrase of the backup.",
        duration: 12_000,
      });
      for (const warning of res.warnings ?? []) toast.warning(warning, { duration: 20_000 });
      void qc.invalidateQueries();
    },
    onError: (e) => {
      if (e instanceof ApiRequestError && (e.status === 400 || e.status === 401 || e.status === 422)) setError(e.message || "Wrong passphrase or damaged file.");
      else toastApiError(e, "Restore failed", qc);
    },
  });

  const pick = (f: File | undefined | null) => {
    if (!f) return;
    setFile(f);
    setError(null);
    setResult(null);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer.files?.[0]);
  };

  return (
    <SettingsGroup title="Restore from backup" icon={<ArchiveRestore />} description="Replace everything in this Godmode with the contents of a backup file.">
      <div className="space-y-4 py-4">
        <AnimatePresence mode="wait">
          {result ? (
            <motion.div key="done" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
              <Callout tone="info" icon={<CircleCheckBig className="text-success" />} title="Vault restored and locked">
                Unlock with the vault passphrase of the backup.
                {Object.keys(result).length > 0 && (
                  <span className="mt-2 flex flex-wrap gap-1.5">
                    {Object.entries(result).map(([k, v]) => (
                      <span key={k} className="rounded-[5px] border bg-card px-2 py-0.5 text-[11px] text-foreground">
                        {v} {k}
                      </span>
                    ))}
                  </span>
                )}
              </Callout>
            </motion.div>
          ) : (
            <motion.div key="form" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-4">
              <div
                role="button"
                tabIndex={0}
                aria-label="Choose a backup file"
                onClick={() => inputRef.current?.click()}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                className={cn(
                  "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-7 text-center transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  dragging ? "border-foreground/40 bg-paper-2" : "border-foreground/15 bg-paper-2/60 hover:border-foreground/30 hover:bg-paper-2",
                )}
              >
                <input
                  ref={inputRef}
                  type="file"
                  accept=".godmode-backup,application/octet-stream,application/zip"
                  className="hidden"
                  onChange={(e) => {
                    pick(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                {file ? (
                  <div className="flex items-center gap-3 text-left">
                    <div className="grid size-10 place-items-center rounded-lg border bg-card text-foreground shadow-card">
                      <FileArchive className="size-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{file.name}</p>
                      <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
                    </div>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Remove file"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFile(null);
                      }}
                    >
                      <X />
                    </Button>
                  </div>
                ) : (
                  <>
                    <Upload className="size-6 text-muted-foreground" />
                    <p className="text-sm font-medium">Drop a .godmode-backup file here</p>
                    <p className="text-xs text-muted-foreground">or click to choose</p>
                  </>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="rs-pass">Backup passphrase</Label>
                <PasswordInput
                  id="rs-pass"
                  value={pass}
                  onChange={(e) => {
                    setPass(e.target.value);
                    setError(null);
                  }}
                  aria-invalid={!!error}
                />
                {error && (
                  <p role="alert" className="text-xs text-destructive">
                    {error}
                  </p>
                )}
              </div>
              <div className="flex justify-end">
                <Button variant="destructive" disabled={!file || !pass || importMut.isPending} onClick={() => setConfirmOpen(true)}>
                  {importMut.isPending ? <Spinner /> : <ArchiveRestore />}
                  {importMut.isPending ? "Restoring…" : "Restore backup"}
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace your current data?</AlertDialogTitle>
            <AlertDialogDescription>
              This replaces your current data — agents, routines, logins, 2FA codes, integrations and settings — with the contents of{" "}
              <span className="font-medium text-foreground">{file?.name}</span>. Running tasks are stopped. Consider exporting a backup first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => importMut.mutate()}>
              Replace and restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsGroup>
  );
}

export function BackupSection() {
  return (
    <div className="space-y-5">
      <SectionHeading
        title="Backup & restore"
        description="Move Godmode to a new machine or keep a safety net. Every backup is encrypted with a passphrase you choose."
      />
      <ExportCard />
      <ImportCard />
    </div>
  );
}
