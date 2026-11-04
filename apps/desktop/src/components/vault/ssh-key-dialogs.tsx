import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SshKeyChange, SshManagedKey } from "@godmode/shared";
import { Segmented } from "@/components/settings/settings-kit";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiRequestError, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { PasswordInput } from "./password-input";

type Algorithm = "ed25519" | "rsa" | "ecdsa";

const NAME = /^[A-Za-z0-9_@+][A-Za-z0-9._@+-]*$/;
const MAX_FILE = 256 * 1024;
const BITS: Record<Exclude<Algorithm, "ed25519">, string[]> = { rsa: ["4096", "3072", "2048"], ecdsa: ["256", "384", "521"] };

function freeName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}_${n}`)) return `${base}_${n}`;
}

function useNameError(name: string, taken: string[]) {
  const { t } = useTranslation("vault");
  const clean = name.trim();
  if (!clean) return null;
  if (taken.includes(clean)) return t("sshKeys.nameTaken");
  if (!NAME.test(clean) || /\.pub$/i.test(clean)) return t("sshKeys.nameInvalid");
  return null;
}

function Shell({
  open,
  onOpenChange,
  title,
  submit,
  pending,
  disabled,
  error,
  onSubmit,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  submit: string;
  pending: boolean;
  disabled?: boolean;
  error?: string | null;
  onSubmit: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation("common");
  const handle = (e: FormEvent) => {
    e.preventDefault();
    if (!pending && !disabled) onSubmit();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="rounded-2xl sm:max-w-md">
        <form onSubmit={handle} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="sr-only">{title}</DialogDescription>
          </DialogHeader>
          {children}
          {error && <p className="text-[13px] text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
              {t("actions.cancel")}
            </Button>
            <Button type="submit" disabled={pending || disabled}>
              {pending && <Spinner />}
              {submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NameField({ value, onChange, error, id, autoFocus }: { value: string; onChange: (value: string) => void; error: string | null; id: string; autoFocus?: boolean }) {
  const { t } = useTranslation("vault");
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{t("sshKeys.name")}</Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off" className="font-mono" aria-invalid={!!error} />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

const invalidate = (qc: ReturnType<typeof useQueryClient>) => void qc.invalidateQueries({ queryKey: qk.sshKeys });

export function GenerateKeyDialog({ open, onOpenChange, taken, onDone }: { open: boolean; onOpenChange: (open: boolean) => void; taken: string[]; onDone: (key: SshManagedKey) => void }) {
  const { t } = useTranslation("vault");
  const qc = useQueryClient();
  const [algorithm, setAlgorithm] = useState<Algorithm>("ed25519");
  const [bits, setBits] = useState("");
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [comment, setComment] = useState("");
  const [passphrase, setPassphrase] = useState("");

  useEffect(() => {
    if (!open) return;
    setAlgorithm("ed25519");
    setBits("");
    setTouched(false);
    setName(freeName("id_ed25519", taken));
    setComment("");
    setPassphrase("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pickAlgorithm = (next: Algorithm) => {
    setAlgorithm(next);
    setBits(next === "ed25519" ? "" : BITS[next][0]!);
    if (!touched) setName(freeName(`id_${next}`, taken));
  };

  const nameError = useNameError(name, taken);
  const make = useMutation({
    mutationFn: () => api.sshKeys.generate({ name: name.trim(), algorithm, bits: bits ? Number(bits) : undefined, comment: comment.trim() || undefined, passphrase: passphrase || undefined }),
    onSuccess: (key) => {
      invalidate(qc);
      onDone(key);
      onOpenChange(false);
    },
  });
  useEffect(() => {
    if (open) make.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      title={t("sshKeys.newKey")}
      submit={t("sshKeys.create")}
      pending={make.isPending}
      disabled={!name.trim() || !!nameError}
      error={make.error ? errorMessage(make.error) : null}
      onSubmit={() => make.mutate()}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          aria-label={t("sshKeys.type")}
          value={algorithm}
          onChange={pickAlgorithm}
          options={[
            { value: "ed25519", label: "Ed25519" },
            { value: "rsa", label: "RSA" },
            { value: "ecdsa", label: "ECDSA" },
          ]}
        />
        {algorithm !== "ed25519" && (
          <Select value={bits} onValueChange={setBits}>
            <SelectTrigger size="sm" className="w-28" aria-label={t("sshKeys.size")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BITS[algorithm].map((b) => (
                <SelectItem key={b} value={b}>
                  {t("sshKeys.bits", { bits: b })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <NameField
        id="ssh-key-name"
        autoFocus
        value={name}
        error={nameError}
        onChange={(v) => {
          setTouched(true);
          setName(v);
        }}
      />
      <div className="grid gap-2">
        <Label htmlFor="ssh-key-comment">{t("sshKeys.comment")}</Label>
        <Input id="ssh-key-comment" value={comment} onChange={(e) => setComment(e.target.value)} spellCheck={false} autoComplete="off" placeholder={t("sshKeys.optional")} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="ssh-key-passphrase">{t("sshKeys.passphrase")}</Label>
        <PasswordInput id="ssh-key-passphrase" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder={t("sshKeys.optional")} />
      </div>
    </Shell>
  );
}

export function ImportKeyDialog({ open, onOpenChange, taken, onDone }: { open: boolean; onOpenChange: (open: boolean) => void; taken: string[]; onDone: (key: SshManagedKey) => void }) {
  const { t } = useTranslation("vault");
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setText("");
    setName(freeName("imported_key", taken));
    setLocalError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const load = async (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    if (file.size > MAX_FILE) {
      setLocalError(t("sshKeys.fileTooBig"));
      return;
    }
    setLocalError(null);
    setText(await file.text());
    const stem = file.name.replace(/\.(pub|pem|key)$/i, "");
    if (NAME.test(stem)) setName(freeName(stem, taken));
  };

  const nameError = useNameError(name, taken);
  const add = useMutation({
    mutationFn: () => api.sshKeys.import({ name: name.trim(), key: text }),
    onSuccess: (key) => {
      invalidate(qc);
      onDone(key);
      onOpenChange(false);
    },
  });
  useEffect(() => {
    if (open) add.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      title={t("sshKeys.importKey")}
      submit={t("sshKeys.import")}
      pending={add.isPending}
      disabled={!text.trim() || !name.trim() || !!nameError}
      error={localError ?? (add.error ? errorMessage(add.error) : null)}
      onSubmit={() => add.mutate()}
    >
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void load(e.dataTransfer.files[0]);
        }}
        className={cn("relative rounded-lg transition", dragging && "ring-[3px] ring-ring/50")}
      >
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("sshKeys.pastePlaceholder")}
          aria-label={t("sshKeys.pastePlaceholder")}
          spellCheck={false}
          autoFocus
          rows={6}
          className="h-36 resize-none font-mono text-[11.5px] leading-relaxed [field-sizing:fixed]"
        />
        <input ref={fileRef} type="file" className="hidden" aria-hidden tabIndex={-1} onChange={(e) => void load(e.target.files?.[0])} />
        {!text && (
          <Button type="button" size="sm" variant="outline" className="absolute right-2 bottom-2" onClick={() => fileRef.current?.click()}>
            <FileUp /> {t("sshKeys.chooseFile")}
          </Button>
        )}
      </div>
      <NameField id="ssh-import-name" value={name} onChange={setName} error={nameError} />
    </Shell>
  );
}

export function EditKeyDialog({ sshKey, onClose, taken, onDone }: { sshKey: SshManagedKey | null; onClose: () => void; taken: string[]; onDone: (change: SshKeyChange) => void }) {
  const { t } = useTranslation("vault");
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");

  useEffect(() => {
    if (!sshKey) return;
    setName(sshKey.name);
    setComment(sshKey.comment);
  }, [sshKey]);

  const nameError = useNameError(name, taken.filter((n) => n !== sshKey?.name));
  const save = useMutation({
    mutationFn: () =>
      api.sshKeys.update(sshKey!.name, {
        name: name.trim() !== sshKey!.name ? name.trim() : undefined,
        comment: comment.trim() !== sshKey!.comment ? comment.trim() : undefined,
      }),
    onSuccess: (change) => {
      invalidate(qc);
      onDone(change);
      onClose();
    },
  });
  useEffect(() => {
    if (sshKey) save.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sshKey]);

  return (
    <Shell
      open={!!sshKey}
      onOpenChange={(next) => !next && onClose()}
      title={t("sshKeys.editKey")}
      submit={t("sshKeys.save")}
      pending={save.isPending}
      disabled={!name.trim() || !!nameError}
      error={save.error ? errorMessage(save.error) : null}
      onSubmit={() => save.mutate()}
    >
      <NameField id="ssh-edit-name" autoFocus value={name} onChange={setName} error={nameError} />
      {sshKey?.publicKey && (
        <div className="grid gap-2">
          <Label htmlFor="ssh-edit-comment">{t("sshKeys.comment")}</Label>
          <Input id="ssh-edit-comment" value={comment} onChange={(e) => setComment(e.target.value)} spellCheck={false} autoComplete="off" />
        </div>
      )}
    </Shell>
  );
}

export function PassphraseDialog({ sshKey, onClose }: { sshKey: SshManagedKey | null; onClose: () => void }) {
  const { t } = useTranslation("vault");
  const qc = useQueryClient();
  const [passphrase, setPassphrase] = useState("");
  const load = useMutation({
    mutationFn: () => api.sshKeys.setLoaded(sshKey!.name, true, passphrase),
    onSuccess: () => {
      invalidate(qc);
      onClose();
    },
    onError: () => setPassphrase(""),
  });
  useEffect(() => {
    if (!sshKey) return;
    setPassphrase("");
    load.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sshKey]);
  const wrong = load.error instanceof ApiRequestError && load.error.code === "ssh_key_bad_passphrase";
  return (
    <Shell
      open={!!sshKey}
      onOpenChange={(next) => !next && onClose()}
      title={t("sshKeys.unlockTitle", { name: sshKey?.name ?? "" })}
      submit={t("sshKeys.load")}
      pending={load.isPending}
      disabled={!passphrase}
      error={load.error ? (wrong ? t("sshKeys.wrongPassphrase") : errorMessage(load.error)) : null}
      onSubmit={() => load.mutate()}
    >
      <div className="grid gap-2">
        <Label htmlFor="ssh-unlock">{t("sshKeys.passphrase")}</Label>
        <PasswordInput id="ssh-unlock" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoFocus />
      </div>
    </Shell>
  );
}
