import { useRef, useState, type DragEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ArchiveRestore, CircleCheckBig, Download, FileArchive, HardDriveDownload, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
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
  const { t } = useTranslation("settings");
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
      toast.success(t("backup.export.savedToast"), { description: t("backup.export.savedToastDescription") });
    },
    onError: (e) => toastApiError(e, t("backup.export.failed"), qc),
  });

  return (
    <SettingsGroup
      title={t("backup.export.title")}
      icon={<HardDriveDownload />}
      description={t("backup.export.description")}
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
            <Label htmlFor="bk-pass">{t("backup.passphrase")}</Label>
            <PasswordInput id="bk-pass" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={t("backup.export.minLength")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bk-confirm">{t("backup.export.confirm")}</Label>
            <PasswordInput id="bk-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={mismatch} />
            {mismatch && (
              <p role="alert" className="text-xs text-destructive">
                {t("passwords.passphraseMismatch")}
              </p>
            )}
          </div>
        </div>
        <StrengthMeter password={pass} />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("backup.export.note")}
        </p>
        <div className="divide-y rounded-lg border bg-paper-2 px-4">
          <SettingRow label={t("backup.export.repos")} htmlFor="bk-repos" description={t("backup.export.reposDescription")}>
            <Switch id="bk-repos" checked={repos} onCheckedChange={setRepos} />
          </SettingRow>
          <SettingRow
            label={t("backup.export.browser")}
            htmlFor="bk-browser"
            description={t("backup.export.browserDescription")}
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
                <CircleCheckBig className="size-3.5 shrink-0" /> <span className="truncate">{t("backup.export.saved", { file: done })}</span>
              </motion.p>
            )}
          </AnimatePresence>
          <Button type="submit" className="ml-auto" disabled={!valid || exportMut.isPending}>
            {exportMut.isPending ? <Spinner /> : <Download />}
            {exportMut.isPending ? t("backup.export.encrypting") : t("backup.export.title")}
          </Button>
        </div>
      </form>
    </SettingsGroup>
  );
}

function ImportCard() {
  const { t } = useTranslation(["settings", "common"]);
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
      toast.success(t("backup.restore.restoredToast"), {
        description: t("backup.restore.restoredToastDescription"),
        duration: 12_000,
      });
      for (const warning of res.warnings ?? []) toast.warning(warning, { duration: 20_000 });
      void qc.invalidateQueries();
    },
    onError: (e) => {
      if (e instanceof ApiRequestError && (e.status === 400 || e.status === 401 || e.status === 422)) setError(e.message || t("backup.restore.wrong"));
      else toastApiError(e, t("backup.restore.failed"), qc);
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
    <SettingsGroup title={t("backup.restore.title")} icon={<ArchiveRestore />} description={t("backup.restore.description")}>
      <div className="space-y-4 py-4">
        <AnimatePresence mode="wait">
          {result ? (
            <motion.div key="done" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
              <Callout tone="info" icon={<CircleCheckBig className="text-success" />} title={t("backup.restore.doneTitle")}>
                {t("backup.restore.doneBody")}
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
                aria-label={t("backup.restore.choose")}
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
                      aria-label={t("backup.restore.removeFile")}
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
                    <p className="text-sm font-medium">{t("backup.restore.drop")}</p>
                    <p className="text-xs text-muted-foreground">{t("backup.restore.click")}</p>
                  </>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="rs-pass">{t("backup.passphrase")}</Label>
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
                  {importMut.isPending ? t("backup.restore.restoring") : t("backup.restore.button")}
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("backup.restore.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              <Trans t={t} i18nKey="backup.restore.confirmDescription" values={{ file: file?.name }} components={{ b: <span className="font-medium text-foreground" /> }} />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => importMut.mutate()}>
              {t("backup.restore.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsGroup>
  );
}

export function BackupSection() {
  const { t } = useTranslation("settings");
  return (
    <div className="space-y-5">
      <SectionHeading title={t("backup.title")} description={t("backup.description")} />
      <ExportCard />
      <ImportCard />
    </div>
  );
}
