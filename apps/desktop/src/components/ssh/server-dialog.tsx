import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, CircleCheck, FileUp, KeyRound, Laptop, RectangleEllipsis, ShieldAlert, ShieldCheck, Trash2, TriangleAlert, X } from "lucide-react";
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
import { keyTypeLabel, parseSshTarget, shortFingerprint } from "./ssh-parts";
import type { SshActions } from "./use-ssh-actions";

const MAX_NAME = 60;
const MAX_KEY_FILE = 64 * 1024;

type KeySource = { kind: "paste" } | { kind: "local"; key: SshLocalKey } | { kind: "generated"; key: SshGeneratedKey };
type TestState = { sig: string; result: SshTestResult } | { sig: string; error: string };

const TOGGLE_ON = "data-[state=on]:bg-secondary data-[state=on]:text-foreground data-[state=on]:ring-1 data-[state=on]:ring-foreground/15 data-[state=on]:ring-inset";

const STAGE_TITLE: Record<SshTestStage, string> = {
  config: "Check the settings",
  connect: "Couldn't reach the server",
  "host-key": "The host key check failed",
  auth: "Sign-in failed",
  command: "Signed in, but the first command failed",
};

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
  return <span className="font-normal text-muted-foreground">(optional)</span>;
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
  if (!name.trim()) errors.name = "Give the server a name";
  if (!host.trim()) errors.host = "Enter a host name or IP address";
  else if (/\s|@/.test(host.trim())) errors.host = "Only the host — the user goes below";
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) errors.port = "1–65535";
  if (!username.trim()) errors.username = "Enter the user to sign in as";
  if (auth === "password" && !password && !(editing && savedLoginPassword)) errors.password = "Enter the password";
  if (auth === "key" && !savedKey) {
    if (publicKeyPasted) errors.key = "That's a public key — use the private key (the file without .pub)";
    else if (!newKeyGiven) errors.key = "Paste, load or generate a private key";
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
    onError: (e) => toastApiError(e, "Couldn't generate a key", qc),
  });

  const create = useMutation({
    mutationFn: (input: SshServerInput) => api.ssh.create(input),
    onSuccess: (created) => {
      actions.put(created);
      toast.success("Server added", { description: "Pick it for a chat with the SSH button, or assign it to an agent." });
      actions.test.mutate({ server: created, silent: true });
      onOpenChange(false);
    },
    onError: (e) => toastApiError(e, "Couldn't add the server", qc),
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
      toast.success("Changes saved");
      if (reconnects) actions.test.mutate({ server: next, silent: true });
      onOpenChange(false);
    },
    onError: (e) => toastApiError(e, "Couldn't save the changes", qc),
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
      toast.error("That file is too big for a private key");
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
            <DialogTitle>{server ? `Edit “${server.name}”` : "Add SSH server"}</DialogTitle>
            <DialogDescription>Godmode signs in for your agents. The password or key is sealed in the vault — the AI never sees it.</DialogDescription>
          </DialogHeader>

          <div ref={bodyRef} className="max-h-[min(40rem,calc(100dvh-15rem))] space-y-5 overflow-y-auto px-6 py-5">
            <Field label="Name" htmlFor="ssh-name" error={err("name")}>
              <Input
                id="ssh-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={MAX_NAME}
                autoFocus
                placeholder="e.g. Production web"
                aria-invalid={!!err("name")}
                aria-describedby={err("name") ? "ssh-name-error" : undefined}
              />
            </Field>

            <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
              <Field label="Host" htmlFor="ssh-host" error={err("host")} hint="Paste user@host:port to fill in all three.">
                <Input
                  id="ssh-host"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  onPaste={(e) => {
                    if (onHostInput(e.clipboardData.getData("text"))) e.preventDefault();
                  }}
                  onBlur={() => onHostInput(host)}
                  placeholder="203.0.113.10 or web-1.example.com"
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="font-mono text-[13px] placeholder:font-sans"
                  aria-invalid={!!err("host")}
                  aria-describedby={err("host") ? "ssh-host-error" : undefined}
                />
              </Field>
              <Field label="Port" htmlFor="ssh-port" error={err("port")}>
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
              <Field label="Username" htmlFor="ssh-user" error={err("username")}>
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
                  Sign in with
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
                    <RectangleEllipsis /> Password
                  </ToggleGroupItem>
                  <ToggleGroupItem value="key" className={cn("flex-1 gap-1.5", TOGGLE_ON)}>
                    <KeyRound /> SSH key
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
            </div>

            <div className="space-y-4 rounded-xl border bg-paper-2/60 p-4">
              {auth === "password" ? (
                <Field label="Password" htmlFor="ssh-password" error={err("password")}>
                  <PasswordInput
                    id="ssh-password"
                    groupClassName="h-9 bg-card"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={editing && savedLoginPassword ? "Saved — leave empty to keep" : "Password for this user"}
                    aria-invalid={!!err("password")}
                    aria-describedby={err("password") ? "ssh-password-error" : undefined}
                  />
                </Field>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-3">
                      <Label htmlFor="ssh-key">Private key</Label>
                      {replacingKey && (
                        <button
                          type="button"
                          onClick={() => {
                            setReplacingKey(false);
                            clearKey();
                          }}
                          className="rounded-sm text-xs text-muted-foreground transition hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                        >
                          Keep the saved key
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
                            {keyTypeLabel(savedKey.type)} key <span className="font-normal text-muted-foreground">· saved in the vault</span>
                          </p>
                          <p className="truncate font-mono text-[11.5px] text-muted-foreground" title={savedKey.fingerprint}>
                            {savedKey.fingerprint}
                          </p>
                        </div>
                        <CopyButton text={savedKey.publicKey} label="Copy public key" className="size-7" />
                        <Button id="ssh-key" type="button" variant="outline" size="sm" onClick={() => setReplacingKey(true)}>
                          Replace key
                        </Button>
                      </div>
                    ) : keySource.kind !== "paste" ? (
                      <div className="flex h-10 items-center gap-2.5 rounded-md border bg-card pr-1 pl-3 shadow-xs">
                        <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-[13px]">
                          {keySource.kind === "local" ? <span className="font-mono">{short(keySource.key.path)}</span> : <span className="font-medium">New key</span>}
                          <span className="text-muted-foreground">
                            {" "}
                            · {keyTypeLabel(keySource.key.type)} · <span className="font-mono">{shortFingerprint(keySource.key.fingerprint, 20)}</span>
                          </span>
                        </span>
                        <Button id="ssh-key" type="button" variant="ghost" size="icon-xs" aria-label="Use another key" className="text-muted-foreground" onClick={clearKey}>
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
                          placeholder={"Paste a private key (OpenSSH, PEM or PuTTY)\n-----BEGIN OPENSSH PRIVATE KEY-----"}
                          spellCheck={false}
                          autoComplete="off"
                          className="max-h-44 min-h-24 bg-card font-mono text-[11.5px] leading-relaxed placeholder:font-sans placeholder:text-[13px]"
                          aria-invalid={!!err("key")}
                          aria-describedby={err("key") ? "ssh-key-error" : undefined}
                        />
                        <div className="flex flex-wrap items-center gap-1.5">
                          <input ref={fileRef} type="file" className="hidden" aria-hidden tabIndex={-1} onChange={(e) => void loadFile(e.target.files?.[0])} />
                          <Button type="button" variant="outline" size="xs" onClick={() => fileRef.current?.click()}>
                            <FileUp /> Load file…
                          </Button>
                          {keys.length > 0 && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button type="button" variant="outline" size="xs">
                                  <Laptop /> From this computer <ChevronDown className="opacity-60" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="start" className="w-80">
                                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Private keys in ~/.ssh</DropdownMenuLabel>
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
                                        {[keyTypeLabel(k.type), shortFingerprint(k.fingerprint, 20), k.encrypted ? "passphrase" : null, k.comment || null].filter(Boolean).join(" · ")}
                                      </span>
                                    </span>
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                          <Button type="button" variant="outline" size="xs" disabled={generate.isPending} onClick={() => generate.mutate()}>
                            {generate.isPending ? <Spinner className="size-3" /> : <KeyRound />} Generate new key
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
                      label={localEncrypted ? "Passphrase" : <>Passphrase <Optional /></>}
                      htmlFor="ssh-passphrase"
                      hint={localEncrypted ? "This key is protected — Godmode needs its passphrase to sign in." : "Only if the key is protected."}
                    >
                      <PasswordInput
                        id="ssh-passphrase"
                        groupClassName="h-9 bg-card"
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                        placeholder={savedKey?.encrypted ? "Saved — leave empty to keep" : undefined}
                      />
                    </Field>
                  )}

                  <Field
                    label={
                      <>
                        Password for sudo <Optional />
                      </>
                    }
                    htmlFor="ssh-sudo"
                    hint="Godmode types it when an agent runs a command with sudo. An agent with a shell on this account could capture it — a narrow NOPASSWD sudo rule is safer."
                  >
                    <PasswordInput
                      id="ssh-sudo"
                      groupClassName="h-9 bg-card"
                      value={sudoPassword}
                      disabled={removeSudo}
                      onChange={(e) => setSudoPassword(e.target.value)}
                      placeholder={removeSudo ? "Removed when you save" : editing && savedLoginPassword ? "Saved — leave empty to keep" : "Only if sudo asks for one"}
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
                            {removeSudo ? "Undo" : "Remove"}
                          </InputGroupButton>
                        )
                      }
                    />
                  </Field>
                </>
              )}
            </div>

            <Field label="Description" htmlFor="ssh-description" hint="Agents read this to know what the server is for and how to work on it.">
              <Textarea
                id="ssh-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={2000}
                placeholder="Production web server — Ubuntu, nginx and Postgres. Deploys go to /srv/app."
                className="max-h-40 min-h-20"
              />
            </Field>

            <AnimatePresence initial={false}>
              {tested && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
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
              {test.isPending ? "Testing…" : "Test connection"}
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || (editing && !changed)}>
                {saving && <Spinner />}
                {server ? "Save changes" : "Add server"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AuthorizeKeyCallout({ publicKey }: { publicKey: string }) {
  const command = `mkdir -p ~/.ssh && echo '${publicKey.trim()}' >> ~/.ssh/authorized_keys`;
  return (
    <div className="space-y-2.5 rounded-lg border bg-card p-3.5 text-xs shadow-xs" role="note">
      <div>
        <p className="text-[13px] font-medium">Add the public key to the server before testing</p>
        <p className="mt-0.5 text-muted-foreground">Sign in another way once (your hosting panel or console) and run this — then Godmode can use the key.</p>
      </div>
      <CodeLine text={command} label="Copy command" />
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1 rounded-sm text-muted-foreground transition outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
          <ChevronDown className="size-3.5 -rotate-90 transition-transform group-open:rotate-0" /> Public key only
        </summary>
        <div className="mt-2">
          <CodeLine text={publicKey.trim()} label="Copy public key" />
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
            <p className="text-[13px] font-medium">The server's host key changed</p>
            <p className="leading-relaxed text-muted-foreground">
              That's expected after a reinstall. If nothing changed on the server, someone may be intercepting the connection — don't trust the new key.
            </p>
            <p className="font-mono text-[11px] break-all text-foreground/85">
              {keyTypeLabel(r.hostKey.type)} {r.hostKey.fingerprint}
            </p>
          </div>
        </div>
        <label htmlFor="ssh-trust-key" className="ml-6 flex cursor-pointer items-center gap-2 text-[13px]">
          <Checkbox id="ssh-trust-key" checked={trustNewKey} onCheckedChange={(v) => onTrustNewKey(v === true)} />
          Trust the new host key
        </label>
      </div>
    );
  }

  if (!r.ok) {
    return (
      <div aria-live="polite" className="flex items-start gap-2.5 rounded-lg border border-destructive/25 bg-destructive/[0.05] px-3 py-2.5 text-xs" role="alert">
        <TriangleAlert className="mt-px size-3.5 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0 space-y-0.5">
          <p className="font-medium text-destructive">{r.stage ? STAGE_TITLE[r.stage] : "Couldn't connect"}</p>
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
          Signed in as <span className="font-mono">{username}</span>
        </span>
        <span className="text-muted-foreground">{[r.latencyMs !== null ? `${r.latencyMs} ms` : null, r.os].filter(Boolean).map((part) => `· ${part}`).join(" ")}</span>
      </p>
      {r.hostKey && (
        <p className="flex items-start gap-1.5 pl-5 text-muted-foreground">
          <span className="min-w-0">
            <span className="font-mono text-[11px] break-all text-foreground/85">
              {keyTypeLabel(r.hostKey.type)} {r.hostKey.fingerprint}
            </span>
            <span className="block">{same ? "Matches the pinned host key." : "Godmode trusts only this host key from now on."}</span>
          </span>
        </p>
      )}
    </div>
  );
}

export function DeleteServerDialog({ server, onClose, actions }: { server: SshServer | null; onClose: () => void; actions: SshActions }) {
  const users = server?.assignments.length ?? 0;
  const secrets = server?.auth === "key" ? (server.hasPassword ? "key and sudo password" : "key") : "password";
  return (
    <AlertDialog open={!!server} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{server?.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Godmode forgets the server and deletes its saved {secrets} from the vault.
            {users === 1 && ` ${server?.assignments[0]?.name || "The agent or chat using it"} loses access to it.`}
            {users > 1 && ` The ${users} agents and chats using it lose access to it.`} The server itself isn't touched.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              if (server) actions.remove.mutate(server);
              onClose();
            }}
          >
            <Trash2 /> Delete server
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
