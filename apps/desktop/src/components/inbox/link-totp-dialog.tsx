import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowRight, Check, Link2, ScanLine, Search, ShieldCheck } from "lucide-react";
import type { Credential, MissingLogin, MissingLoginTotpChoices, TotpEntry } from "@godmode/shared";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Favicon } from "@/components/vault/favicon";
import { issuerDomain } from "@/components/vault/use-totp-codes";
import { domainFromUrl, toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

type SiteLogin = MissingLoginTotpChoices["logins"][number];

const LIMIT = 60;

/** Pick a 2FA code that is already in the vault for the site of a missing-2FA report; Godmode links it to the right login. */
export function LinkTotpDialog({ item, open, onOpenChange }: { item: MissingLogin; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-xl">
        {open && <LinkTotpForm item={item} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function LinkTotpForm({ item, onDone }: { item: MissingLogin; onDone: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [totpId, setTotpId] = useState<string | null>(null);
  const [loginId, setLoginId] = useState<string | null>(null);

  const choices = useQuery({ queryKey: [...qk.missingLogins, item.id, "totp-choices"], queryFn: () => api.missingLogins.totpChoices(item.id) });
  const totp = useQuery({ queryKey: qk.totpList("all"), queryFn: () => api.totp.list({ workspaceId: "all" }) });
  const creds = useQuery({ queryKey: qk.credentialList("all", ""), queryFn: () => api.credentials.list({ workspaceId: "all" }) });

  const host = choices.data?.host ?? domainFromUrl(item.url);
  const logins = choices.data?.logins ?? [];
  const credById = useMemo(() => new Map((creds.data ?? []).map((c) => [c.id, c])), [creds.data]);
  const suggested = useMemo(() => new Set(choices.data?.suggestedTotpIds ?? []), [choices.data]);
  const entries = totp.data ?? [];
  const selectedTotp = entries.find((t) => t.id === (totpId ?? choices.data?.suggestedTotpIds[0])) ?? null;
  const selected = selectedTotp?.id ?? null;
  const login = pickLogin(logins, selectedTotp, loginId);

  const { top, rest, hidden } = useMemo(() => {
    const order = choices.data?.suggestedTotpIds ?? [];
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = entries.filter((t) => {
      if (!tokens.length) return true;
      const linked = t.credentialId ? credById.get(t.credentialId) : undefined;
      const hay = `${t.issuer} ${t.accountName} ${linked?.name ?? ""} ${linked?.domains.join(" ") ?? ""}`.toLowerCase();
      return tokens.every((k) => hay.includes(k));
    });
    const top = hits.filter((t) => suggested.has(t.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    const others = hits.filter((t) => !suggested.has(t.id));
    const room = Math.max(0, LIMIT - top.length);
    return { top, rest: others.slice(0, room), hidden: Math.max(0, others.length - room) };
  }, [entries, query, suggested, credById, choices.data]);

  const link = useMutation({
    mutationFn: () => api.missingLogins.linkTotp(item.id, { totpId: selected!, credentialId: login?.id }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: qk.totp });
      void qc.invalidateQueries({ queryKey: qk.credentials });
      void qc.invalidateQueries({ queryKey: qk.missingLogins });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
      const name = credById.get(res.credentialId)?.name ?? login?.name ?? host;
      toast.success(res.outcome === "domain_added" ? `2FA ready for ${host}` : `2FA linked to ${name}`, {
        description: "Agents type this code in on their next sign-in.",
      });
      onDone();
    },
    onError: (e) => toastApiError(e, "Could not link the 2FA code", qc),
  });

  const importNew = () => {
    onDone();
    navigate("/vault/2fa?import=1");
  };

  const loading = choices.isLoading || totp.isLoading;
  const noLogin = choices.isSuccess && logins.length === 0;
  const preview = selectedTotp && login ? outcomeText(selectedTotp, login, host, credById) : null;

  return (
    <div className="flex max-h-[min(88vh,760px)] flex-col">
      <div className="flex items-start gap-3.5 px-6 pt-6 pb-4">
        <Favicon domain={host} name={item.service || host} size="lg" />
        <div className="min-w-0 pr-8">
          <DialogTitle className="text-lg">Use a saved 2FA code</DialogTitle>
          <DialogDescription className="mt-1">
            Pick the code for <span className="font-medium text-foreground">{host || item.service}</span>. Godmode links it to the right login, so agents fill it in by
            themselves next time.
          </DialogDescription>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-5">
        {logins.length > 1 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Login for {host}</p>
            <div role="radiogroup" aria-label={`Login for ${host}`} className="flex flex-wrap gap-1.5">
              {logins.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  role="radio"
                  aria-checked={login?.id === l.id}
                  onClick={() => setLoginId(l.id)}
                  className={cn(
                    "inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-xs transition",
                    login?.id === l.id ? "border-foreground/70 bg-foreground/[0.04] text-foreground" : "text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                  )}
                >
                  <span className="truncate font-medium">{l.username || l.name}</span>
                  {l.username && <span className="truncate opacity-70">{l.name}</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        {noLogin && (
          <p className="rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-xs text-foreground/85">
            No login is saved for {host} yet. Add the login first, then link its 2FA here.
          </p>
        )}

        <div className="overflow-hidden rounded-xl border">
          <label className="flex h-10 items-center gap-2 border-b px-3">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search 2FA codes by service, account or login…"
              className="h-full w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
              autoFocus
            />
          </label>
          <div role="listbox" aria-label="2FA codes" className="max-h-[min(22rem,46vh)] overflow-y-auto p-1.5">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Spinner /> Loading 2FA codes…
              </div>
            ) : top.length + rest.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">{query ? `No 2FA code matches “${query}”.` : "Your vault has no 2FA codes yet."}</p>
            ) : (
              <>
                {top.length > 0 && <Heading>Suggested for {host}</Heading>}
                {top.map((t) => (
                  <TotpRow key={t.id} entry={t} linked={t.credentialId ? credById.get(t.credentialId) : undefined} selected={t.id === selected} onSelect={setTotpId} />
                ))}
                {rest.length > 0 && <Heading>{top.length ? "All 2FA codes" : query ? "Matches" : "All 2FA codes"}</Heading>}
                {rest.map((t) => (
                  <TotpRow key={t.id} entry={t} linked={t.credentialId ? credById.get(t.credentialId) : undefined} selected={t.id === selected} onSelect={setTotpId} />
                ))}
                {hidden > 0 && <p className="px-2.5 pt-1 pb-2 text-xs text-muted-foreground">{hidden} more. Keep typing to narrow it down.</p>}
              </>
            )}
          </div>
        </div>

        {preview && (
          <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
            <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-brand-strong" />
            <span>{preview}</span>
          </p>
        )}
      </div>

      <div className="flex flex-col-reverse gap-3 border-t bg-paper-2 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
        <Button type="button" variant="ghost" size="sm" className="justify-start text-muted-foreground" onClick={importNew}>
          <ScanLine /> Not there? Import a new code
        </Button>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onDone} disabled={link.isPending}>
            Cancel
          </Button>
          <Button type="button" onClick={() => link.mutate()} disabled={!selected || !login || link.isPending}>
            {link.isPending ? <Spinner /> : <Link2 />} Link 2FA
          </Button>
        </div>
      </div>
    </div>
  );
}

function pickLogin(logins: SiteLogin[], entry: TotpEntry | null, chosen: string | null): SiteLogin | null {
  if (chosen) return logins.find((l) => l.id === chosen) ?? null;
  const same = (a: string, b: string) => !!a.trim() && a.trim().toLowerCase() === b.trim().toLowerCase();
  return (entry && (logins.find((l) => l.totpId === entry.id) ?? logins.find((l) => same(l.username, entry.accountName)))) || logins[0] || null;
}

function outcomeText(entry: TotpEntry, login: SiteLogin, host: string, credById: Map<string, Credential>): string {
  const owner = entry.credentialId && entry.credentialId !== login.id ? credById.get(entry.credentialId) : undefined;
  const who = login.username ? `${login.name} · ${login.username}` : login.name;
  if (entry.credentialId === login.id) return `Already linked to ${who}. This closes the request.`;
  if (!owner) return `Links it to ${who}.`;
  const sameAccount = !!owner.username.trim() && owner.username.trim().toLowerCase() === login.username.trim().toLowerCase();
  const ownerCovers = [...owner.domains, domainFromUrl(owner.url)].some((d) => d && (host === d || host.endsWith(`.${d}`) || d.endsWith(`.${host}`)));
  if (sameAccount || ownerCovers) {
    return ownerCovers
      ? `It stays with ${owner.name}, which already covers ${host}.`
      : `Same account: it stays with ${owner.name} (${owner.domains[0] ?? domainFromUrl(owner.url)}) and ${host} is added to that login, so both sign-ins get the code.`;
  }
  return `Moves it from ${owner.name}${owner.username ? ` · ${owner.username}` : ""} to ${who}.`;
}

function Heading({ children }: { children: ReactNode }) {
  return <p className="px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{children}</p>;
}

function TotpRow({ entry, linked, selected, onSelect }: { entry: TotpEntry; linked: Credential | undefined; selected: boolean; onSelect: (id: string) => void }) {
  const linkedDomain = linked ? (linked.domains[0] ?? domainFromUrl(linked.url)) : "";
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={() => onSelect(entry.id)}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition",
        selected ? "bg-foreground/[0.06] ring-1 ring-foreground/15" : "hover:bg-accent",
      )}
    >
      <Favicon domain={linkedDomain || issuerDomain(entry.issuer)} name={entry.issuer || entry.accountName} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{entry.issuer || entry.accountName}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {entry.issuer && entry.accountName ? `${entry.accountName} · ` : ""}
          {linked ? (
            <>
              <ShieldCheck className="inline size-3 -translate-y-px" /> {linked.name}
              {linkedDomain ? ` (${linkedDomain})` : ""}
            </>
          ) : (
            "Not linked"
          )}
        </span>
      </span>
      <Check className={cn("size-4 shrink-0 text-foreground", selected ? "opacity-100" : "opacity-0")} />
    </button>
  );
}
