import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { Eye, Inbox, Lock, ShieldCheck } from "lucide-react";
import type { Credential, CredentialInput, TotpEntry } from "@godmode/shared";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AgentAvatar } from "@/components/common";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useAllAgents, useMissingLogins } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Favicon } from "./favicon";
import { PasswordInput } from "./password-input";
import { PasswordGeneratorButton } from "./password-generator";
import { StrengthMeter } from "./strength-meter";
import { ChipInput } from "./chip-input";
import { WorkspaceSelect } from "./workspace-select";
import { domainFromUrl, normalizeUrl, rootDomain, toastApiError } from "./vault-utils";
import { issuerDomain } from "./use-totp-codes";

export interface CredentialPrefill {
  domain?: string;
  service?: string;
  missingLoginId?: string;
}

const NO_TOTP = "__none__";

const PRETTY: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  paypal: "PayPal",
  openai: "OpenAI",
  hubspot: "HubSpot",
  wordpress: "WordPress",
  dropbox: "Dropbox",
  icloud: "iCloud",
};

function prettyName(domain: string): string {
  if (!domain) return "";
  const label = rootDomain(domain).split(".")[0] ?? "";
  return PRETTY[label] ?? label.charAt(0).toUpperCase() + label.slice(1);
}

function isDomain(s: string) {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s);
}

export function CredentialDialog({
  open,
  onOpenChange,
  credential,
  prefill,
  defaultWorkspaceId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this credential; null/undefined = create */
  credential?: Credential | null;
  prefill?: CredentialPrefill;
  defaultWorkspaceId?: string | null;
  onSaved?: (credential: Credential) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-xl">
        {open && (
          <CredentialForm
            key={credential?.id ?? "new"}
            credential={credential ?? null}
            prefill={prefill}
            defaultWorkspaceId={defaultWorkspaceId ?? null}
            onDone={(c) => {
              onSaved?.(c);
              onOpenChange(false);
            }}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CredentialForm({
  credential,
  prefill,
  defaultWorkspaceId,
  onDone,
  onCancel,
}: {
  credential: Credential | null;
  prefill?: CredentialPrefill;
  defaultWorkspaceId: string | null;
  onDone: (c: Credential) => void;
  onCancel: () => void;
}) {
  const qc = useQueryClient();
  const uid = useId();
  const isEdit = !!credential;

  const prefillDomain = prefill?.domain ? domainFromUrl(prefill.domain) : "";
  const [name, setName] = useState(credential?.name ?? prefill?.service ?? prettyName(prefillDomain));
  const [nameTouched, setNameTouched] = useState(isEdit || !!prefill?.service);
  const [url, setUrl] = useState(credential?.url ?? (prefillDomain ? `https://${prefillDomain}` : ""));
  const [domains, setDomains] = useState<string[]>(credential?.domains ?? (prefillDomain ? [prefillDomain] : []));
  const [domainsTouched, setDomainsTouched] = useState(isEdit);
  const [username, setUsername] = useState(credential?.username ?? "");
  const [password, setPassword] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string | null>(credential ? credential.workspaceId : defaultWorkspaceId);
  const [workspaceTouched, setWorkspaceTouched] = useState(isEdit);
  const [totpId, setTotpId] = useState<string | null>(credential?.totpId ?? null);
  const [tags, setTags] = useState<string[]>(credential?.tags ?? []);
  const [notes, setNotes] = useState("");
  const [notesEditable, setNotesEditable] = useState(!isEdit);
  const [submitted, setSubmitted] = useState(false);

  // Context for "an agent asked for this login"
  const missing = useMissingLogins("open");
  const missingItem = prefill?.missingLoginId ? missing.data?.find((m) => m.id === prefill.missingLoginId) : undefined;
  const { data: agents = [] } = useAllAgents();
  const missingAgent = missingItem?.agentId ? agents.find((a) => a.id === missingItem.agentId) : undefined;

  useEffect(() => {
    if (!missingItem || isEdit) return;
    if (!workspaceTouched && missingItem.workspaceId) setWorkspaceId(missingItem.workspaceId);
    if (!domains.length && missingItem.url) {
      const d = domainFromUrl(missingItem.url);
      if (d) setDomains([d]);
      if (!url) setUrl(missingItem.url);
    }
    // Only when the missing-login record first arrives.
  }, [missingItem?.id]);

  const primaryDomain = domains[0] ?? domainFromUrl(url);

  const totpQuery = useQuery({ queryKey: qk.totpList("all"), queryFn: () => api.totp.list({ workspaceId: "all" }) });
  const totpOptions = useMemo(() => {
    const list = [...(totpQuery.data ?? [])];
    const root = primaryDomain ? rootDomain(primaryDomain) : "";
    const score = (t: TotpEntry) => (t.id === totpId ? 0 : root && rootDomain(issuerDomain(t.issuer)) === root ? 1 : 2);
    return list.sort((a, b) => score(a) - score(b) || a.issuer.localeCompare(b.issuer));
  }, [totpQuery.data, primaryDomain, totpId]);

  const revealNotes = useMutation({
    mutationFn: () => api.credentials.reveal(credential!.id),
    onSuccess: (res) => {
      setNotes(res.notes ?? "");
      setNotesEditable(true);
    },
    onError: (e) => toastApiError(e, "Could not reveal notes", qc),
  });

  const save = useMutation({
    mutationFn: async () => {
      const input: CredentialInput = {
        workspaceId,
        name: name.trim(),
        url: url.trim() ? normalizeUrl(url) : "",
        domains,
        username: username.trim(),
        totpId,
        tags,
      };
      if (password) input.password = password;
      if (notesEditable) input.notes = notes;
      const saved = isEdit ? await api.credentials.update(credential!.id, input) : await api.credentials.create(input);

      // Keep both sides of the login ↔ 2FA link consistent.
      const previousTotp = credential?.totpId ?? null;
      if (totpId !== previousTotp) {
        const all = totpQuery.data ?? [];
        if (totpId) await api.totp.update(totpId, { credentialId: saved.id }).catch(() => undefined);
        const prev = previousTotp ? all.find((t) => t.id === previousTotp) : undefined;
        if (prev && prev.credentialId === saved.id) await api.totp.update(prev.id, { credentialId: null }).catch(() => undefined);
      }
      if (prefill?.missingLoginId) {
        await api.missingLogins.update(prefill.missingLoginId, { status: "resolved", credentialId: saved.id }).catch((e) => {
          toastApiError(e, "Saved, but the inbox item could not be resolved", qc);
        });
      }
      return saved;
    },
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: qk.credentials });
      void qc.invalidateQueries({ queryKey: qk.totp });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
      if (prefill?.missingLoginId) void qc.invalidateQueries({ queryKey: qk.missingLogins });
      toast.success(isEdit ? "Login updated" : "Login saved", {
        description: prefill?.missingLoginId ? "The agent can retry now — the inbox item was resolved." : "Encrypted in your vault.",
      });
      onDone(saved);
    },
    onError: (e) => toastApiError(e, isEdit ? "Could not update login" : "Could not save login", qc),
  });

  const nameError = submitted && !name.trim() ? "Give this login a name." : null;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (!name.trim()) return;
    save.mutate();
  };

  const onUrlChange = (v: string) => {
    setUrl(v);
    const d = domainFromUrl(v);
    if (!domainsTouched) setDomains(d && isDomain(d) ? [d] : []);
    if (!nameTouched) setName(prettyName(d));
  };

  const id = (s: string) => `${uid}-${s}`;

  return (
    <form onSubmit={onSubmit} className="flex max-h-[min(88vh,760px)] flex-col">
      <div className="flex items-start gap-3.5 px-6 pt-6 pb-4">
        <motion.div key={primaryDomain} initial={{ scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
          <Favicon domain={primaryDomain} name={name || "?"} size="lg" />
        </motion.div>
        <div className="min-w-0 pr-8">
          <DialogTitle className="text-lg">{isEdit ? `Edit ${credential!.name}` : "Add login"}</DialogTitle>
          <DialogDescription className="mt-1">
            {isEdit ? "Changes apply to every agent that can use this login." : "Save a website login so your agents can sign in on their own."}
          </DialogDescription>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-5">
        {prefill?.missingLoginId && (
          <div className="flex items-start gap-3 rounded-xl border border-primary/25 bg-primary/5 p-3 text-sm">
            {missingAgent ? <AgentAvatar agent={missingAgent} size="sm" className="mt-0.5" /> : <Inbox className="mt-0.5 size-4 text-primary" />}
            <div className="min-w-0">
              <p className="font-medium">
                {missingAgent ? `${missingAgent.name} needs this login` : "An agent needs this login"}
                {missingItem?.service ? ` for ${missingItem.service}` : prefill.service ? ` for ${prefill.service}` : ""}
              </p>
              {missingItem?.reason && <p className="mt-0.5 text-xs text-muted-foreground">“{missingItem.reason}”</p>}
            </div>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Name" htmlFor={id("name")} error={nameError}>
            <Input
              id={id("name")}
              value={name}
              autoFocus={!isEdit}
              placeholder="GitHub"
              aria-invalid={!!nameError}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
            />
          </FormField>
          <FormField label="Website" htmlFor={id("url")}>
            <Input id={id("url")} value={url} placeholder="https://github.com/login" inputMode="url" autoComplete="off" onChange={(e) => onUrlChange(e.target.value)} />
          </FormField>
        </div>

        <FormField label="Domains" htmlFor={id("domains")} hint="Agents use this login on these sites. Derived from the website — add more if the login works elsewhere.">
          <ChipInput
            id={id("domains")}
            value={domains}
            onChange={(v) => {
              setDomains(v);
              setDomainsTouched(true);
            }}
            normalize={(s) => domainFromUrl(s)}
            validate={isDomain}
            placeholder="github.com"
          />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Username or email" htmlFor={id("username")}>
            <Input id={id("username")} value={username} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="you@example.com" onChange={(e) => setUsername(e.target.value)} />
          </FormField>
          <FormField
            label="Password"
            htmlFor={id("password")}
            hint={isEdit ? (credential!.hasPassword ? "A password is stored. Leave empty to keep it." : "No password stored yet.") : undefined}
          >
            <PasswordInput
              id={id("password")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isEdit && credential!.hasPassword ? "Unchanged — type to replace" : "••••••••••••"}
              groupClassName="h-9"
              trailing={<PasswordGeneratorButton onUse={setPassword} />}
            />
          </FormField>
        </div>
        {password && <StrengthMeter password={password} userInputs={[name, username, primaryDomain]} className="-mt-2" />}

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Available to" htmlFor={id("workspace")} hint="Global logins can be used by agents in every workspace.">
            <WorkspaceSelect
              id={id("workspace")}
              value={workspaceId}
              onChange={(v) => {
                setWorkspaceId(v);
                setWorkspaceTouched(true);
              }}
            />
          </FormField>
          <FormField label="Two-factor code" htmlFor={id("totp")} hint="Linked codes are typed in automatically after the password.">
            <Select value={totpId ?? NO_TOTP} onValueChange={(v) => setTotpId(v === NO_TOTP ? null : v)}>
              <SelectTrigger id={id("totp")} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TOTP}>
                  <span className="text-muted-foreground">No 2FA linked</span>
                </SelectItem>
                {totpOptions.length > 0 && <SelectSeparator />}
                {totpOptions.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    <ShieldCheck className="size-4" />
                    <span className="truncate">
                      {t.issuer}
                      {t.accountName && <span className="text-muted-foreground"> · {t.accountName}</span>}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </div>

        <FormField label="Tags" htmlFor={id("tags")}>
          <ChipInput id={id("tags")} value={tags} onChange={setTags} normalize={(s) => s.trim().toLowerCase()} placeholder="work, billing…" />
        </FormField>

        <FormField label="Notes" htmlFor={id("notes")} hint="Encrypted like the password — e.g. security questions or recovery hints.">
          {notesEditable ? (
            <Textarea id={id("notes")} value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="min-h-20" placeholder="Optional" />
          ) : (
            <div className="flex min-h-20 flex-wrap items-center justify-center gap-2 rounded-md border border-dashed bg-muted/30 p-3 text-sm text-muted-foreground">
              <Lock className="size-4" />
              <span>Notes are hidden.</span>
              <Button type="button" size="xs" variant="outline" onClick={() => revealNotes.mutate()} disabled={revealNotes.isPending}>
                {revealNotes.isPending ? <Spinner className="size-3" /> : <Eye />} Show notes
              </Button>
              <Button type="button" size="xs" variant="ghost" onClick={() => setNotesEditable(true)}>
                Replace
              </Button>
            </div>
          )}
        </FormField>
      </div>

      <div className="flex flex-col-reverse gap-3 border-t bg-muted/30 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="size-3.5 shrink-0" /> Encrypted on this device · agents fill it without seeing it
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending} className="min-w-24">
            {save.isPending && <Spinner />}
            {isEdit ? "Save changes" : "Save login"}
          </Button>
        </div>
      </div>
    </form>
  );
}

function FormField({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 space-y-2", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
