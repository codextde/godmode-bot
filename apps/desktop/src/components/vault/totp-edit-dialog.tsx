import { useId, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Credential, TotpEntry } from "@godmode/shared";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { useLocale } from "@/i18n/language";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { toast } from "sonner";
import { Favicon } from "./favicon";
import { LinkPicker, type LinkPickerItem } from "./link-picker";
import { WorkspaceSelect } from "./workspace-select";
import { issuerDomain } from "./use-totp-codes";
import { domainFromUrl, rootDomain, toastApiError } from "./vault-utils";

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
  const { t } = useTranslation(["vault", "common"]);
  const { dateLocale } = useLocale();
  const qc = useQueryClient();
  const uid = useId();
  const [issuer, setIssuer] = useState(entry.issuer);
  const [account, setAccount] = useState(entry.accountName);
  const [workspaceId, setWorkspaceId] = useState<string | null>(entry.workspaceId);
  const [credentialId, setCredentialId] = useState<string | null>(entry.credentialId);

  const creds = useQuery({ queryKey: qk.credentialList("all", ""), queryFn: () => api.credentials.list({ workspaceId: "all" }) });
  const loginItems = useMemo((): LinkPickerItem[] => {
    const root = rootDomain(issuerDomain(issuer));
    const matches = (c: Credential) => !!root && (c.domains.some((d) => rootDomain(d) === root) || rootDomain(domainFromUrl(c.url)) === root);
    return [...(creds.data ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ id: c.id, title: c.name, subtitle: c.username, domain: c.domains[0] ?? domainFromUrl(c.url), suggested: matches(c) }));
  }, [creds.data, issuer]);

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
      toast.success(t("totpEdit.updated"));
      onDone();
    },
    onError: (e) => toastApiError(e, t("totpEdit.updateFailed"), qc),
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
          <DialogTitle className="text-lg">{t("totpEdit.title")}</DialogTitle>
          <DialogDescription className="mt-1">{t("totpEdit.description")}</DialogDescription>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={id("issuer")}>{t("totpForm.service")}</Label>
            <Input id={id("issuer")} value={issuer} onChange={(e) => setIssuer(e.target.value)} aria-invalid={!issuer.trim()} autoFocus={!focusLink} />
          </div>
          <div className="space-y-2">
            <Label htmlFor={id("account")}>{t("totpForm.account")}</Label>
            <Input id={id("account")} value={account} onChange={(e) => setAccount(e.target.value)} autoComplete="off" />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor={id("login")}>{t("totpForm.linkedLogin")}</Label>
          <LinkPicker
            id={id("login")}
            value={credentialId}
            onChange={setCredentialId}
            items={loginItems}
            loading={creds.isLoading}
            noneLabel={t("totpForm.notLinked")}
            searchPlaceholder={t("totpForm.searchLogins")}
            noun="login"
            autoFocus={focusLink}
          />
          <p className="text-xs text-muted-foreground">{t("totpForm.linkedLoginHint")}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor={id("ws")}>{t("availableTo")}</Label>
          <WorkspaceSelect id={id("ws")} value={workspaceId} onChange={setWorkspaceId} />
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border bg-paper-2 p-3 text-xs sm:grid-cols-3">
          <Info label={t("totpForm.algorithm")} value={entry.algorithm} />
          <Info label={t("totpForm.digits")} value={String(entry.digits)} />
          <Info label={t("totpForm.period")} value={`${entry.period} s`} />
          <Info label={t("totpEdit.added")} value={format(new Date(entry.createdAt), "PP", { locale: dateLocale })} />
          <Info label={t("totpEdit.lastUsed")} value={entry.lastUsedAt ? formatDistanceToNow(new Date(entry.lastUsedAt), { addSuffix: true, locale: dateLocale }) : t("common:words.never")} />
          <Info label={t("totpEdit.type")} value={t("totpEdit.typeTotp")} />
        </dl>
      </div>
      <div className="flex flex-col-reverse gap-3 border-t bg-paper-2 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5 shrink-0 text-brand-strong" /> {t("totpEdit.secretEncrypted")}
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onDone} disabled={save.isPending}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" disabled={save.isPending || !issuer.trim()}>
            {save.isPending && <Spinner />} {t("saveChanges")}
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
