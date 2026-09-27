import { useId, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { KeyRound, ShieldCheck } from "lucide-react";
import type { Credential, TotpEntry } from "@godmode/shared";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { toast } from "sonner";
import { Favicon } from "./favicon";
import { WorkspaceSelect } from "./workspace-select";
import { issuerDomain } from "./use-totp-codes";
import { domainFromUrl, rootDomain, toastApiError } from "./vault-utils";

const NO_LOGIN = "__none__";

export function TotpEditDialog({
  entry,
  focusLink,
  onOpenChange,
}: {
  entry: TotpEntry | null;
  focusLink?: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={!!entry} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-lg">
        {entry && <EditForm key={entry.id} entry={entry} focusLink={!!focusLink} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function EditForm({ entry, focusLink, onDone }: { entry: TotpEntry; focusLink: boolean; onDone: () => void }) {
  const qc = useQueryClient();
  const uid = useId();
  const [issuer, setIssuer] = useState(entry.issuer);
  const [account, setAccount] = useState(entry.accountName);
  const [workspaceId, setWorkspaceId] = useState<string | null>(entry.workspaceId);
  const [credentialId, setCredentialId] = useState<string | null>(entry.credentialId);

  const creds = useQuery({ queryKey: qk.credentialList("all", ""), queryFn: () => api.credentials.list({ workspaceId: "all" }) });
  const options = useMemo(() => {
    const root = rootDomain(issuerDomain(issuer));
    const score = (c: Credential) => (c.id === credentialId ? 0 : c.domains.some((d) => rootDomain(d) === root) || rootDomain(domainFromUrl(c.url)) === root ? 1 : 2);
    return [...(creds.data ?? [])].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
  }, [creds.data, issuer, credentialId]);

  const save = useMutation({
    mutationFn: async () => {
      const updated = await api.totp.update(entry.id, { issuer: issuer.trim(), accountName: account.trim(), workspaceId, credentialId });
      // Keep both sides of the login ↔ 2FA link consistent.
      if (credentialId !== entry.credentialId) {
        if (credentialId) await api.credentials.update(credentialId, { totpId: entry.id }).catch(() => undefined);
        const prev = entry.credentialId ? creds.data?.find((c) => c.id === entry.credentialId) : undefined;
        if (prev && prev.totpId === entry.id) await api.credentials.update(prev.id, { totpId: null }).catch(() => undefined);
      }
      return updated;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.totp });
      void qc.invalidateQueries({ queryKey: qk.credentials });
      toast.success("2FA code updated");
      onDone();
    },
    onError: (e) => toastApiError(e, "Could not update 2FA code", qc),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!issuer.trim()) return;
    save.mutate();
  };

  const id = (s: string) => `${uid}-${s}`;

  return (
    <form onSubmit={onSubmit} className="flex max-h-[min(88vh,720px)] flex-col">
      <div className="flex items-start gap-3.5 px-6 pt-6 pb-4">
        <Favicon domain={issuerDomain(issuer)} name={issuer || "?"} size="lg" />
        <div className="min-w-0 pr-8">
          <DialogTitle className="text-lg">Edit 2FA code</DialogTitle>
          <DialogDescription className="mt-1">The secret itself can't be viewed or changed — re-import the QR code to replace it.</DialogDescription>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={id("issuer")}>Service</Label>
            <Input id={id("issuer")} value={issuer} onChange={(e) => setIssuer(e.target.value)} aria-invalid={!issuer.trim()} autoFocus={!focusLink} />
          </div>
          <div className="space-y-2">
            <Label htmlFor={id("account")}>Account</Label>
            <Input id={id("account")} value={account} onChange={(e) => setAccount(e.target.value)} autoComplete="off" />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor={id("login")}>Linked login</Label>
          <Select value={credentialId ?? NO_LOGIN} onValueChange={(v) => setCredentialId(v === NO_LOGIN ? null : v)}>
            <SelectTrigger id={id("login")} className="w-full" autoFocus={focusLink}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_LOGIN}>
                <span className="text-muted-foreground">Not linked</span>
              </SelectItem>
              {options.length > 0 && <SelectSeparator />}
              {options.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  <KeyRound className="size-4" />
                  <span className="truncate">
                    {c.name}
                    {c.username && <span className="text-muted-foreground"> · {c.username}</span>}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">When an agent signs in with the linked login, Godmode types this code in right after the password.</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor={id("ws")}>Available to</Label>
          <WorkspaceSelect id={id("ws")} value={workspaceId} onChange={setWorkspaceId} />
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border bg-paper-2 p-3 text-xs sm:grid-cols-3">
          <Info label="Algorithm" value={entry.algorithm} />
          <Info label="Digits" value={String(entry.digits)} />
          <Info label="Period" value={`${entry.period} s`} />
          <Info label="Added" value={format(new Date(entry.createdAt), "PP")} />
          <Info label="Last used" value={entry.lastUsedAt ? formatDistanceToNow(new Date(entry.lastUsedAt), { addSuffix: true }) : "Never"} />
          <Info label="Type" value="Time-based (TOTP)" />
        </dl>
      </div>
      <div className="flex flex-col-reverse gap-3 border-t bg-paper-2 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5 shrink-0 text-brand-strong" /> Secret stays encrypted in your vault
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onDone} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending || !issuer.trim()}>
            {save.isPending && <Spinner />} Save changes
          </Button>
        </div>
      </div>
    </form>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  );
}
