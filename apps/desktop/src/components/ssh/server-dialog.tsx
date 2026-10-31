import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, CircleCheck, FileUp, KeyRound, Laptop, RectangleEllipsis, ShieldAlert, ShieldCheck, Trash2, TriangleAlert, X } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { SshAuthMethod, SshGeneratedKey, SshHostKey, SshLocalKey, SshServer, SshServerInput, SshServerPatch, SshTestResult, SshTestStage } from "@godmode/shared";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { InputGroupButton } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CopyButton } from "@/components/chat/copy-button";
import { useShortPath } from "@/components/chat/folder-picker";
import { PasswordInput } from "@/components/vault/password-input";
import { toastApiError } from "@/components/vault/vault-utils";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { EASE_OUT } from "@/lib/motion";
import { keyTypeLabel, parseSshTarget, shortFingerprint } from "./ssh-parts";
import type { SshActions } from "./use-ssh-actions";

const MAX_NAME = 60;
const MAX_KEY_FILE = 64 * 1024;

type KeySource = { kind: "paste" } | { kind: "local"; key: SshLocalKey } | { kind: "generated"; key: SshGeneratedKey };
type TestState = { sig: string; result: SshTestResult } | { sig: string; error: string };

const TOGGLE_ON = "data-[state=on]:bg-secondary data-[state=on]:text-foreground data-[state=on]:ring-1 data-[state=on]:ring-foreground/15 data-[state=on]:ring-inset";

const STAGE_TITLE = {
  config: "dialog.stage.config",
  connect: "dialog.stage.connect",
  "host-key": "dialog.stage.hostKey",
  auth: "dialog.stage.auth",
  command: "dialog.stage.command",
} as const satisfies Record<SshTestStage, string>;

function looksLikePublicKey(text: string): boolean {
  const t = text.trim();
  return /^(ssh-|ecdsa-|sk-)\S+\s+AAAA/.test(t) || /BEGIN (SSH2 )?PUBLIC KEY/.test(t);
}

function Field({ label, htmlFor, hint, error, children, className }: { label: ReactNode; htmlFor: string; hint?: ReactNode; error?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="text-xs text-destructive">
          {error}
        </p>
      ) : (
        hint && <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

function Optional() {
  const { t } = useTranslation("common");
  return <span className="font-normal text-muted-foreground">({t("words.optional")})</span>;
}

/** Add or edit an SSH server: address, sign-in (password or key), a connection test that pins the host key. */
export function ServerDialog({
  open,
  server,
  onOpenChange,
  actions,
}: {
  open: boolean;
  /** null = add a new server. */
  server: SshServer | null;
  onOpenChange: (open: boolean) => void;
  actions: SshActions;
}) {
  const { t } = useTranslation(["ssh", "common"]);
  const qc = useQueryClient();
  const short = useShortPath();
  const fileRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [auth, setAuth] = useState<SshAuthMethod>("password");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [keySource, setKeySource] = useState<KeySource>({ kind: "paste" });
  const [replacingKey, setReplacingKey] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [sudoPassword, setSudoPassword] = useState("");
  const [removeSudo, setRemoveSudo] = useState(false);
  const [description, setDescription] = useState("");
  const [trustNewKey, setTrustNewKey] = useState(false);
  const [testState, setTestState] = useState<TestState | null>(null);
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(server?.name ?? "");
    setHost(server?.host ?? "");
    setPort(String(server?.port ?? 22));
    setUsername(server?.username ?? "");
    setAuth(server?.auth ?? "password");
    setPassword("");
    setPrivateKey("");
    setFileName(null);
    setKeySource({ kind: "paste" });
    setReplacingKey(false);
    setPassphrase("");
    setSudoPassword("");
    setRemoveSudo(false);
    setDescription(server?.description ?? "");
    setTrustNewKey(false);
    setTestState(null);
    setShowErrors(false);
    // Only when the dialog opens: realtime list updates must not reset what the user typed.
  }, [open, server?.id]);

  const localKeys = useQuery({
    queryKey: qk.sshLocalKeys,
    queryFn: api.ssh.localKeys,
    enabled: open && auth === "key",
    staleTime: 30_000,
    retry: false,
  });

  const editing = !!server;
  const savedKey = server?.key && !replacingKey ? server.key : null;
  const savedLoginPassword = !!server?.hasPassword;
  const portNum = Number(port);
  const newKeyGiven = keySource.kind !== "paste" || privateKey.trim() !== "";
  const publicKeyPasted = keySource.kind === "paste" && looksLikePublicKey(privateKey);

  const secrets = (): Partial<SshServerInput> => {
    const out: Partial<SshServerInput> = {};
    if (auth === "password") {
      if (password) out.password = password;
      return out;
    }
    if (!savedKey) {
      if (keySource.kind === "local") out.privateKeyPath = keySource.key.path;
      else out.privateKey = keySource.kind === "generated" ? keySource.key.privateKey : privateKey;
      if (passphrase || server?.key) out.passphrase = passphrase;
    } else if (passphrase) out.passphrase = passphrase;
    if (sudoPassword) out.password = sudoPassword;
    else if (removeSudo && savedLoginPassword) out.password = "";
    return out;
  };

  const errors: Partial<Record<"name" | "host" | "port" | "username" | "password" | "key", string>> = {};
  if (!name.trim()) errors.name = t("dialog.errors.name");
  if (!host.trim()) errors.host = t("dialog.errors.host");
  else if (/\s|@/.test(host.trim())) errors.host = t("dialog.errors.hostOnly");
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) errors.port = "1–65535";
  if (!username.trim()) errors.username = t("dialog.errors.username");
  if (auth === "password" && !password && !(editing && savedLoginPassword)) errors.password = t("dialog.errors.password");
  if (auth === "key" && !savedKey) {
    if (publicKeyPasted) errors.key = t("dialog.errors.publicKey");
    else if (!newKeyGiven) errors.key = t("dialog.errors.keyMissing");
  }
  const connectionErrors = { ...errors };
  delete connectionErrors.name;
  const valid = Object.keys(errors).length === 0;
  const err = (k: keyof typeof errors) => (showErrors ? errors[k] : undefined);

  const sig = JSON.stringify([host.trim(), portNum, username.trim(), auth, secrets()]);
  const tested = testState?.sig === sig ? testState : null;
  const result = tested && "result" in tested ? tested.result : null;
  const seenKey = result?.hostKey ?? null;
  const pinKey: SshHostKey | null = seenKey && ((result?.ok && !result.hostKeyChanged) || (result?.hostKeyChanged && trustNewKey)) ? seenKey : null;

  const baseInput = (): SshServerInput => ({
    name: name.trim() || host.trim(),
    host: host.trim(),
    port: portNum,
    username: username.trim(),
    auth,
    description: description.trim(),
    ...secrets(),
  });

  const test = useMutation({
    mutationFn: ({ input }: { input: SshServerInput; sig: string }) => api.ssh.try({ ...input, id: server?.id }),
    onSuccess: (res, { sig: s }) => {
      setTrustNewKey(false);
      setTestState({ sig: s, result: res });
    },
    onError: (e, { sig: s }) => setTestState({ sig: s, error: errorMessage(e) }),
  });
  const revealResult = () => bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });

  const runTest = () => {
    if (Object.keys(connectionErrors).length > 0) {
      setShowErrors(true);
      return;
    }
    const input = baseInput();
    if (trustNewKey && seenKey) input.hostKey = seenKey;
    test.mutate({ input, sig });
  };

  const generate = useMutation({
    mutationFn: () => api.ssh.generateKey(`godmode-${(name.trim() || host.trim() || "server").toLowerCase().replace(/[^a-z0-9.-]+/g, "-")}`),
    onSuccess: (key) => {
      setKeySource({ kind: "generated", key });
      setPrivateKey("");
      setFileName(null);
      setPassphrase("");
    },
    onError: (e) => toastApiError(e, t("dialog.generateFailed"), qc),
  });

  const create = useMutation({
    mutationFn: (input: SshServerInput) => api.ssh.create(input),
    onSuccess: (created) => {
      actions.put(created);
      toast.success(t("dialog.added"), { description: t("dialog.addedDescription") });
      actions.test.mutate({ server: created, silent: true });
      onOpenChange(false);
    },
    onError: (e) => toastApiError(e, t("dialog.addFailed"), qc),
  });

  const patch: SshServerPatch = {};
  if (server) {
    const input = baseInput();
    if (input.name !== server.name) patch.name = input.name;
    if (input.host !== server.host) patch.host = input.host;
    if (input.port !== server.port) patch.port = input.port;
    if (input.username !== server.username) patch.username = input.username;
    if (input.auth !== server.auth) patch.auth = input.auth;
    if (input.description !== server.description) patch.description = input.description;
    Object.assign(patch, secrets());
    if (pinKey && (pinKey.fingerprint !== server.hostKey?.fingerprint || pinKey.type !== server.hostKey?.type)) patch.hostKey = pinKey;
  }
  const changed = Object.keys(patch).length > 0;
  const reconnects = ["host", "port", "username", "auth", "password", "privateKey", "privateKeyPath", "passphrase", "hostKey"].some((k) => k in patch);

  const update = useMutation({
    mutationFn: ({ id, patch: p }: { id: string; patch: SshServerPatch }) => api.ssh.update(id, p),
    onSuccess: (next) => {
      actions.put(next);
      toast.success(t("dialog.saved"));
      if (reconnects) actions.test.mutate({ server: next, silent: true });
      onOpenChange(false);
    },
    onError: (e) => toastApiError(e, t("dialog.saveFailed"), qc),
  });

  const saving = create.isPending || update.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) {
      setShowErrors(true);
      const first = (["name", "host", "port", "username", "password", "key"] as const).find((k) => errors[k]);
      const target = { name: "ssh-name", host: "ssh-host", port: "ssh-port", username: "ssh-user", password: "ssh-password", key: "ssh-key" }[first ?? "name"];
      document.getElementById(target)?.focus();
      return;
    }
    if (saving) return;
    if (server) {
      if (changed) update.mutate({ id: server.id, patch });
      else onOpenChange(false);
    } else create.mutate({ ...baseInput(), ...(pinKey ? { hostKey: pinKey } : {}) });
  };

  const onHostInput = (text: string) => {
    const parsed = parseSshTarget(text);
    if (!parsed) return false;
    setHost(parsed.host);
    if (parsed.username) setUsername(parsed.username);
    if (parsed.port) setPort(String(parsed.port));
    return true;
  };

  const loadFile = async (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    if (file.size > MAX_KEY_FILE) {
      toast.error(t("dialog.fileTooBig"));
      return;
    }
    const text = await file.text();
    setKeySource({ kind: "paste" });
    setPrivateKey(text);
    setFileName(file.name);
  };

  const clearKey = () => {
    setKeySource({ kind: "paste" });
    setPrivateKey("");
    setFileName(null);
    setPassphrase("");
  };

  const keys = localKeys.data ?? [];
  const localEncrypted = keySource.kind === "local" && keySource.key.encrypted;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-xl">
        <form onSubmit={submit} noValidate className="min-w-0">
          <DialogHeader className="border-b bg-paper-2 px-6 pt-6 pb-5">
            <DialogTitle>{server ? t("dialog.titleEdit", { name: server.name }) : t("dialog.titleAdd")}</DialogTitle>
            <DialogDescription>{t("dialog.description")}</DialogDescription>
          </DialogHeader>

          <div ref={bodyRef} className="max-h-[min(40rem,calc(100dvh-15rem))] space-y-5 overflow-y-auto px-6 py-5">
            <Field label={t("dialog.name")} htmlFor="ssh-name" error={err("name")}>
              <Input
                id="ssh-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={MAX_NAME}
                autoFocus
                placeholder={t("dialog.namePlaceholder")}
                aria-invalid={!!err("name")}
                aria-describedby={err("name") ? "ssh-name-error" : undefined}
              />
            </Field>

            <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
              <Field label={t("dialog.host")} htmlFor="ssh-host" error={err("host")} hint={t("dialog.hostHint")}>
                <Input
                  id="ssh-host"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  onPaste={(e) => {
                    if (onHostInput(e.clipboardData.getData("text"))) e.preventDefault();
                  }}
                  onBlur={() => onHostInput(host)}
                  placeholder={t("dialog.hostPlaceholder")}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="font-mono text-[13px] placeholder:font-sans"
                  aria-invalid={!!err("host")}
                  aria-describedby={err("host") ? "ssh-host-error" : undefined}
                />
              </Field>
              <Field label={t("dialog.port")} htmlFor="ssh-port" error={err("port")}>
                <Input
                  id="ssh-port"
                  value={port}
                  onChange={(e) => setPort(e.target.value.replace(/\D/g, "").slice(0, 5))}
                  inputMode="numeric"
                  autoComplete="off"
                  className="font-mono text-[13px] tabular-nums"
                  aria-invalid={!!err("port")}
                  aria-describedby={err("port") ? "ssh-port-error" : undefined}
                />
              </Field>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t("dialog.username")} htmlFor="ssh-user" error={err("username")}>
                <Input
                  id="ssh-user"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="root"
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="font-mono text-[13px] placeholder:font-sans"
                  aria-invalid={!!err("username")}
                  aria-describedby={err("username") ? "ssh-user-error" : undefined}
                />
              </Field>
              <div className="space-y-1.5">
                <span id="ssh-auth-label" className="block text-sm leading-none font-medium">
                  {t("dialog.signInWith")}
                </span>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={auth}
                  onValueChange={(v) => v && setAuth(v as SshAuthMethod)}
                  aria-labelledby="ssh-auth-label"
                  className="w-full"
                >
                  <ToggleGroupItem value="password" className={cn("flex-1 gap-1.5", TOGGLE_ON)}>
                    <RectangleEllipsis /> {t("dialog.password")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="key" className={cn("flex-1 gap-1.5", TOGGLE_ON)}>
                    <KeyRound /> {t("dialog.sshKey")}
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
            </div>

            <div className="space-y-4 rounded-xl border bg-paper-2/60 p-4">
              {auth === "password" ? (
                <Field label={t("dialog.password")} htmlFor="ssh-password" error={err("password")}>
                  <PasswordInput
                    id="ssh-password"
                    groupClassName="h-9 bg-card"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={editing && savedLoginPassword ? t("dialog.savedKeepPlaceholder") : t("dialog.passwordPlaceholder")}
                    aria-invalid={!!err("password")}
                    aria-describedby={err("password") ? "ssh-password-error" : undefined}
                  />
                </Field>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-3">
                      <Label htmlFor="ssh-key">{t("dialog.privateKey")}</Label>
                      {replacingKey && (
                        <button
                          type="button"
                          onClick={() => {
                            setReplacingKey(false);
                            clearKey();
                          }}
                          className="rounded-sm text-xs text-muted-foreground transition hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                        >
                          {t("dialog.keepSavedKey")}
                        </button>
                      )}
                    </div>

                    {savedKey ? (
                      <div className="flex items-center gap-3 rounded-lg border bg-card p-3 shadow-xs">
                        <div className="grid size-9 shrink-0 place-items-center rounded-md border bg-paper-2 text-muted-foreground">
                          <KeyRound className="size-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">
                            <Trans t={t} i18nKey="dialog.savedKey" values={{ type: keyTypeLabel(savedKey.type) }} components={{ muted: <span className="font-normal text-muted-foreground" /> }} />
                          </p>
                          <p className="truncate font-mono text-[11.5px] text-muted-foreground" title={savedKey.fingerprint}>
                            {savedKey.fingerprint}
                          </p>
                        </div>
                        <CopyButton text={savedKey.publicKey} label={t("dialog.copyPublicKey")} className="size-7" />
                        <Button id="ssh-key" type="button" variant="outline" size="sm" onClick={() => setReplacingKey(true)}>
                          {t("dialog.replaceKey")}
                        </Button>
                      </div>
                    ) : keySource.kind !== "paste" ? (
                      <div className="flex h-10 items-center gap-2.5 rounded-md border bg-card pr-1 pl-3 shadow-xs">
                        <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-[13px]">
                          {keySource.kind === "local" ? <span className="font-mono">{short(keySource.key.path)}</span> : <span className="font-medium">{t("dialog.newKey")}</span>}
                          <span className="text-muted-foreground">
                            {" "}
                            · {keyTypeLabel(keySource.key.type)} · <span className="font-mono">{shortFingerprint(keySource.key.fingerprint, 20)}</span>
                          </span>
                        </span>
                        <Button id="ssh-key" type="button" variant="ghost" size="icon-xs" aria-label={t("dialog.useAnotherKey")} className="text-muted-foreground" onClick={clearKey}>
                          <X />
                        </Button>
                      </div>
                    ) : (
                      <>
                        <Textarea
                          id="ssh-key"
                          value={privateKey}
                          onChange={(e) => {
                            setPrivateKey(e.target.value);
                            setFileName(null);
                          }}
                          onDragOver={(e) => {
                            if (e.dataTransfer.types.includes("Files")) e.preventDefault();
                          }}
                          onDrop={(e) => {
                            const file = e.dataTransfer.files?.[0];
                            if (!file) return;
                            e.preventDefault();
                            void loadFile(file);
                          }}
                          placeholder={`${t("dialog.keyPlaceholder")}\n-----BEGIN OPENSSH PRIVATE KEY-----`}
                          spellCheck={false}
                          autoComplete="off"
                          className="max-h-44 min-h-24 bg-card font-mono text-[11.5px] leading-relaxed placeholder:font-sans placeholder:text-[13px]"
                          aria-invalid={!!err("key")}
                          aria-describedby={err("key") ? "ssh-key-error" : undefined}
                        />
                        <div className="flex flex-wrap items-center gap-1.5">
                          <input ref={fileRef} type="file" className="hidden" aria-hidden tabIndex={-1} onChange={(e) => void loadFile(e.target.files?.[0])} />
                          <Button type="button" variant="outline" size="xs" onClick={() => fileRef.current?.click()}>
                            <FileUp /> {t("dialog.loadFile")}
                          </Button>
                          {keys.length > 0 && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button type="button" variant="outline" size="xs">
                                  <Laptop /> {t("dialog.fromThisComputer")} <ChevronDown className="opacity-60" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="start" className="w-80">
                                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t("dialog.localKeys")}</DropdownMenuLabel>
                                {keys.map((k) => (
                                  <DropdownMenuItem
                                    key={k.path}
                                    onSelect={() => {
                                      setKeySource({ kind: "local", key: k });
                                      setPrivateKey("");
                                      setFileName(null);
                                      setPassphrase("");
                                    }}
                                    className="items-start gap-2.5 py-2"
                                  >
                                    <KeyRound className="mt-0.5" />
                                    <span className="min-w-0 flex-1">
                                      <span className="block truncate font-mono text-[12.5px]">{k.name}</span>
                                      <span className="block truncate text-[11px] text-muted-foreground">
                                        {[keyTypeLabel(k.type), shortFingerprint(k.fingerprint, 20), k.encrypted ? t("dialog.passphraseTag") : null, k.comment || null].filter(Boolean).join(" · ")}
                                      </span>
                                    </span>
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                          <Button type="button" variant="outline" size="xs" disabled={generate.isPending} onClick={() => generate.mutate()}>
                            {generate.isPending ? <Spinner className="size-3" /> : <KeyRound />} {t("dialog.generateKey")}
                          </Button>
                          {fileName && <span className="max-w-40 truncate text-xs text-muted-foreground">{fileName}</span>}
                        </div>
                      </>
                    )}
                    {err("key") && (
                      <p id="ssh-key-error" className="text-xs text-destructive">
                        {err("key")}
                      </p>
                    )}
                  </div>

                  {keySource.kind === "generated" && !savedKey && <AuthorizeKeyCallout publicKey={keySource.key.publicKey} />}

                  {keySource.kind !== "generated" && (!savedKey || savedKey.encrypted) && (
                    <Field
                      label={localEncrypted ? t("dialog.passphrase") : <>{t("dialog.passphrase")} <Optional /></>}
                      htmlFor="ssh-passphrase"
                      hint={localEncrypted ? t("dialog.passphraseHintLocal") : t("dialog.passphraseHint")}
                    >
                      <PasswordInput
                        id="ssh-passphrase"
                        groupClassName="h-9 bg-card"
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                        placeholder={savedKey?.encrypted ? t("dialog.savedKeepPlaceholder") : undefined}
                      />
                    </Field>
                  )}

                  <Field
                    label={
                      <>
                        {t("dialog.sudoPassword")} <Optional />
                      </>
                    }
                    htmlFor="ssh-sudo"
                    hint={t("dialog.sudoHint")}
                  >
                    <PasswordInput
                      id="ssh-sudo"
                      groupClassName="h-9 bg-card"
                      value={sudoPassword}
                      disabled={removeSudo}
                      onChange={(e) => setSudoPassword(e.target.value)}
                      placeholder={removeSudo ? t("dialog.sudoRemovedPlaceholder") : editing && savedLoginPassword ? t("dialog.savedKeepPlaceholder") : t("dialog.sudoPlaceholder")}
                      trailing={
                        editing &&
                        savedLoginPassword && (
                          <InputGroupButton
                            size="xs"
                            className="text-muted-foreground"
                            onClick={() => {
                              setRemoveSudo((r) => !r);
                              setSudoPassword("");
                            }}
                          >
                            {removeSudo ? t("common:actions.undo") : t("common:actions.remove")}
                          </InputGroupButton>
                        )
                      }
                    />
                  </Field>
                </>
              )}
            </div>

            <Field label={t("common:words.description")} htmlFor="ssh-description" hint={t("dialog.descriptionHint")}>
              <Textarea
                id="ssh-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={2000}
                placeholder={t("dialog.descriptionPlaceholder")}
                className="max-h-40 min-h-20"
              />
            </Field>

            <AnimatePresence initial={false}>
              {tested && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: EASE_OUT }}
                  onAnimationComplete={revealResult}
                  className="overflow-hidden"
                >
                  <TestResultPanel
                    state={tested}
                    username={username.trim()}
                    pinned={server?.hostKey ?? null}
                    trustNewKey={trustNewKey}
                    onTrustNewKey={setTrustNewKey}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <DialogFooter className="border-t bg-paper-2 px-6 py-4 sm:justify-between">
            <Button type="button" variant="outline" onClick={runTest} disabled={test.isPending}>
              {test.isPending ? <Spinner /> : <ShieldCheck />}
              {test.isPending ? t("status.testing") : t("dialog.testConnection")}
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                {t("common:actions.cancel")}
              </Button>
              <Button type="submit" disabled={saving || (editing && !changed)}>
                {saving && <Spinner />}
                {server ? t("dialog.saveChanges") : t("dialog.addServer")}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AuthorizeKeyCallout({ publicKey }: { publicKey: string }) {
  const { t } = useTranslation("ssh");
  const command = `mkdir -p ~/.ssh && echo '${publicKey.trim()}' >> ~/.ssh/authorized_keys`;
  return (
    <div className="space-y-2.5 rounded-lg border bg-card p-3.5 text-xs shadow-xs" role="note">
      <div>
        <p className="text-[13px] font-medium">{t("authorize.title")}</p>
        <p className="mt-0.5 text-muted-foreground">{t("authorize.description")}</p>
      </div>
      <CodeLine text={command} label={t("authorize.copyCommand")} />
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1 rounded-sm text-muted-foreground transition outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
          <ChevronDown className="size-3.5 -rotate-90 transition-transform group-open:rotate-0" /> {t("authorize.publicKeyOnly")}
        </summary>
        <div className="mt-2">
          <CodeLine text={publicKey.trim()} label={t("authorize.copyPublicKey")} />
        </div>
      </details>
    </div>
  );
}

function CodeLine({ text, label }: { text: string; label: string }) {
  return (
    <div className="flex items-start gap-1 rounded-md border bg-paper-2 py-1 pr-1 pl-2.5">
      <code className="min-w-0 flex-1 py-0.5 font-mono text-[11px] leading-relaxed break-all text-foreground/85">{text}</code>
      <CopyButton text={text} label={label} className="size-6 shrink-0" />
    </div>
  );
}

function TestResultPanel({
  state,
  username,
  pinned,
  trustNewKey,
  onTrustNewKey,
}: {
  state: TestState;
  username: string;
  pinned: SshHostKey | null;
  trustNewKey: boolean;
  onTrustNewKey: (v: boolean) => void;
}) {
  const { t } = useTranslation("ssh");
  if ("error" in state) {
    return (
      <div aria-live="polite" className="flex items-start gap-2.5 rounded-lg border border-destructive/25 bg-destructive/[0.05] px-3 py-2.5 text-xs" role="alert">
        <TriangleAlert className="mt-px size-3.5 shrink-0 text-destructive" aria-hidden />
        <p className="min-w-0 leading-relaxed break-words text-destructive">{state.error}</p>
      </div>
    );
  }
  const r = state.result;

  if (r.hostKeyChanged && r.hostKey) {
    return (
      <div aria-live="polite" className="space-y-2.5 rounded-lg border border-warning/30 bg-warning/[0.07] px-3 py-3 text-xs" role="alert">
        <div className="flex items-start gap-2.5">
          <ShieldAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
          <div className="min-w-0 space-y-1">
            <p className="text-[13px] font-medium">{t("result.hostKeyChangedTitle")}</p>
            <p className="leading-relaxed text-muted-foreground">
              {t("result.hostKeyChangedBody")}
            </p>
            <p className="font-mono text-[11px] break-all text-foreground/85">
              {keyTypeLabel(r.hostKey.type)} {r.hostKey.fingerprint}
            </p>
          </div>
        </div>
        <label htmlFor="ssh-trust-key" className="ml-6 flex cursor-pointer items-center gap-2 text-[13px]">
          <Checkbox id="ssh-trust-key" checked={trustNewKey} onCheckedChange={(v) => onTrustNewKey(v === true)} />
          {t("result.trustNewKey")}
        </label>
      </div>
    );
  }

  if (!r.ok) {
    return (
      <div aria-live="polite" className="flex items-start gap-2.5 rounded-lg border border-destructive/25 bg-destructive/[0.05] px-3 py-2.5 text-xs" role="alert">
        <TriangleAlert className="mt-px size-3.5 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0 space-y-0.5">
          <p className="font-medium text-destructive">{r.stage ? t(STAGE_TITLE[r.stage]) : t("result.couldNotConnect")}</p>
          {r.error && <p className="leading-relaxed break-words text-destructive/85">{r.error}</p>}
        </div>
      </div>
    );
  }

  const same = !!pinned && !!r.hostKey && pinned.fingerprint === r.hostKey.fingerprint;
  return (
    <div aria-live="polite" className="space-y-1.5 rounded-lg border border-success/25 bg-success/[0.05] px-3 py-2.5 text-xs">
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <CircleCheck className="size-3.5 shrink-0 text-success" aria-hidden />
        <span className="font-medium">
          <Trans t={t} i18nKey="result.signedInAs" values={{ user: username }} components={{ mono: <span className="font-mono" /> }} />
        </span>
        <span className="text-muted-foreground">{[r.latencyMs !== null ? `${r.latencyMs} ms` : null, r.os].filter(Boolean).map((part) => `· ${part}`).join(" ")}</span>
      </p>
      {r.hostKey && (
        <p className="flex items-start gap-1.5 pl-5 text-muted-foreground">
          <span className="min-w-0">
            <span className="font-mono text-[11px] break-all text-foreground/85">
              {keyTypeLabel(r.hostKey.type)} {r.hostKey.fingerprint}
            </span>
            <span className="block">{same ? t("result.matchesPinned") : t("result.trustsOnly")}</span>
          </span>
        </p>
      )}
    </div>
  );
}

export function DeleteServerDialog({ server, onClose, actions }: { server: SshServer | null; onClose: () => void; actions: SshActions }) {
  const { t } = useTranslation(["ssh", "common"]);
  const users = server?.assignments.length ?? 0;
  const body = server?.auth === "key" ? (server.hasPassword ? t("deleteDialog.bodyKeyAndSudo") : t("deleteDialog.bodyKey")) : t("deleteDialog.bodyPassword");
  return (
    <AlertDialog open={!!server} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("deleteDialog.title", { name: server?.name })}</AlertDialogTitle>
          <AlertDialogDescription>
            {body}
            {users === 1 &&
              ` ${server?.assignments[0]?.name ? t("deleteDialog.oneUser", { name: server.assignments[0].name }) : t("deleteDialog.oneUserFallback")}`}
            {users > 1 && ` ${t("deleteDialog.manyUsers", { n: users })}`} {t("deleteDialog.untouched")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              if (server) actions.remove.mutate(server);
              onClose();
            }}
          >
            <Trash2 /> {t("deleteDialog.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
