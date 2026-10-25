import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowRight, Link2, X } from "lucide-react";
import type { Credential, TotpEntry } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Favicon } from "./favicon";
import { issuerDomain } from "./use-totp-codes";
import { domainFromUrl, toastApiError } from "./vault-utils";

const DISMISS_KEY = "godmode-totp-autolink-dismissed";

const pairKey = (p: { credentialId: string; totpId: string }) => `${p.credentialId}:${p.totpId}`;

/** "Stripe:dan@x.de" without an issuer reads as service "Stripe", account "dan@x.de". */
function entryLabel(t: TotpEntry): { service: string; account: string } {
  if (t.issuer) return { service: t.issuer, account: t.accountName };
  const i = t.accountName.indexOf(":");
  return i > 0 ? { service: t.accountName.slice(0, i), account: t.accountName.slice(i + 1) } : { service: t.accountName, account: "" };
}

function loadDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/** Logins and 2FA codes that clearly belong together, linked in one click. Agents also link them on their own once a guessed code works. */
export function TotpAutoLinkPanel({ entries, credById }: { entries: TotpEntry[]; credById: Map<string, Credential> }) {
  const qc = useQueryClient();
  const [dismissed, setDismissed] = useState(loadDismissed);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [checkedLikely, setCheckedLikely] = useState<Set<string>>(new Set());
  const suggestions = useQuery({ queryKey: qk.totpAutolink, queryFn: api.totp.autolinkSuggestions, enabled: entries.length > 0 });

  const totpById = useMemo(() => new Map(entries.map((t) => [t.id, t])), [entries]);
  const rows = useMemo(
    () =>
      (suggestions.data ?? [])
        .filter((s) => !dismissed.has(pairKey(s)))
        .map((s) => ({ ...s, key: pairKey(s), totp: totpById.get(s.totpId), cred: credById.get(s.credentialId) }))
        .filter((r): r is typeof r & { totp: TotpEntry; cred: Credential } => !!r.totp && !!r.cred),
    [suggestions.data, dismissed, totpById, credById],
  );
  const isChecked = (r: { key: string; sure: boolean }) => (unchecked.has(r.key) ? false : r.sure || checkedLikely.has(r.key));
  const selected = rows.filter(isChecked);

  const toggle = (r: { key: string; sure: boolean }, on: boolean) => {
    const set = (s: Set<string>, add: boolean) => {
      const next = new Set(s);
      if (add) next.add(r.key);
      else next.delete(r.key);
      return next;
    };
    if (r.sure) setUnchecked((s) => set(s, !on));
    else setCheckedLikely((s) => set(s, on));
  };

  const dismiss = (keys: string[]) => {
    setDismissed((d) => {
      const next = new Set([...d, ...keys]);
      try {
        localStorage.setItem(DISMISS_KEY, JSON.stringify([...next].slice(-500)));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const link = useMutation({
    mutationFn: () => api.totp.autolink(selected.map(({ credentialId, totpId }) => ({ credentialId, totpId }))),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: qk.totp });
      void qc.invalidateQueries({ queryKey: qk.credentials });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
      const n = res.linked.length;
      if (n) toast.success(`${n} 2FA ${n === 1 ? "code" : "codes"} linked`, { description: "Agents fill them in by themselves on the next sign-in." });
      else toast.info("Nothing to link anymore", { description: "These logins got a 2FA code in the meantime." });
    },
    onError: (e) => toastApiError(e, "Could not link the 2FA codes", qc),
  });

  if (!rows.length) return null;
  const sureCount = rows.filter((r) => r.sure).length;

  return (
    <motion.section
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        aria-label="2FA codes that match a login"
        className="overflow-hidden rounded-xl border border-brand/25 bg-card shadow-card"
      >
        <div className="flex items-start gap-3 px-4 pt-4 pb-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand-strong">
            <Link2 className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium tracking-[-0.01em]">
              {rows.length === 1 ? "1 code matches a login" : `${rows.length} codes match a login`}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Matched by service and account. Link them and agents finish two-factor on their own.
              {sureCount < rows.length ? " Likely matches stay unchecked; agents also try them and link the ones that work." : ""}
            </p>
          </div>
          <Button variant="ghost" size="icon-sm" className="-mt-1 -mr-1 text-muted-foreground" aria-label="Hide these suggestions" onClick={() => dismiss(rows.map((r) => r.key))}>
            <X />
          </Button>
        </div>

        <ul className="max-h-72 divide-y overflow-y-auto border-y">
          {rows.map((r) => {
            const checked = isChecked(r);
            const credDomain = r.cred.domains[0] ?? domainFromUrl(r.cred.url);
            const { service, account } = entryLabel(r.totp);
            return (
              <li key={r.key}>
                <label className={cn("flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/50", !checked && "opacity-75")}>
                  <Checkbox checked={checked} onCheckedChange={(v) => toggle(r, v === true)} aria-label={`Link ${service} to ${r.cred.name}`} />
                  <span className="flex min-w-0 flex-1 items-center gap-2.5">
                    <Favicon domain={credDomain || issuerDomain(r.totp.issuer)} name={service} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{service}</span>
                      {account && <span className="block truncate text-xs text-muted-foreground">{account}</span>}
                    </span>
                  </span>
                  <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{r.cred.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{r.cred.username || credDomain}</span>
                  </span>
                  <span
                    className={cn(
                      "hidden shrink-0 rounded-[5px] px-1.5 py-0.5 text-[10px] font-medium tabular-nums sm:inline",
                      r.sure ? "bg-success/10 text-success" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {r.sure ? "Match" : "Likely"}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>

        <div className="flex items-center justify-end gap-2 bg-paper-2 px-4 py-3">
          <Button variant="ghost" size="sm" onClick={() => dismiss(rows.map((r) => r.key))} disabled={link.isPending}>
            Not now
          </Button>
          <Button size="sm" onClick={() => link.mutate()} disabled={!selected.length || link.isPending}>
            {link.isPending ? <Spinner /> : <Link2 />} Link {selected.length || ""}
          </Button>
        </div>
    </motion.section>
  );
}
