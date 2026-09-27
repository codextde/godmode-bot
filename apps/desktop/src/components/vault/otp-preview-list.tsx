import { useMemo } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Layers, TriangleAlert, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { parseOtpUri, type MigrationPreview, type OtpPreview } from "@/lib/qr";
import { Favicon } from "./favicon";
import { issuerDomain } from "./use-totp-codes";

type Parsed =
  | { kind: "otpauth"; uri: string; preview: OtpPreview }
  | { kind: "migration"; uri: string; preview: MigrationPreview };

export function useParsedUris(uris: string[]) {
  return useMemo(() => {
    const parsed: Parsed[] = [];
    for (const uri of uris) {
      const p = parseOtpUri(uri);
      if (p.kind !== "invalid") parsed.push(p);
    }
    const accountCount = parsed.reduce((n, p) => n + (p.kind === "otpauth" ? 1 : p.preview.accounts.length), 0);
    // Incomplete multi-QR Google Authenticator exports
    const batches = new Map<number, { size: number; indexes: Set<number> }>();
    for (const p of parsed) {
      if (p.kind !== "migration" || p.preview.batchSize <= 1) continue;
      const b = batches.get(p.preview.batchId) ?? { size: p.preview.batchSize, indexes: new Set<number>() };
      b.indexes.add(p.preview.batchIndex);
      batches.set(p.preview.batchId, b);
    }
    const incomplete = [...batches.values()].filter((b) => b.indexes.size < b.size).map((b) => ({ size: b.size, missing: b.size - b.indexes.size }));
    return { parsed, accountCount, incomplete };
  }, [uris]);
}

/** Preview of everything that is about to be imported, with per-code removal. */
export function OtpPreviewList({ uris, onRemove }: { uris: string[]; onRemove: (uri: string) => void }) {
  const { parsed, accountCount, incomplete } = useParsedUris(uris);
  if (parsed.length === 0) return null;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <p className="eyebrow">Ready to import</p>
        <Badge variant="secondary" className="tabular-nums">
          {accountCount} {accountCount === 1 ? "account" : "accounts"}
        </Badge>
      </div>

      {incomplete.map((b, i) => (
        <div key={i} className="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/[0.07] p-3 text-xs">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <p>
            This Google Authenticator export has <strong>{b.size} QR codes</strong> — {b.missing} {b.missing === 1 ? "is" : "are"} still missing. Add the
            remaining screenshots to import every account.
          </p>
        </div>
      ))}

      <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-card">
        <AnimatePresence initial={false}>
          {parsed.map((p) =>
            p.kind === "otpauth" ? (
              <motion.div key={p.uri} layout initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
                <div className="flex items-center gap-3 px-3 py-2.5">
                  <Favicon domain={issuerDomain(p.preview.issuer)} name={p.preview.issuer} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{p.preview.issuer}</p>
                    {p.preview.account && <p className="truncate text-xs text-muted-foreground">{p.preview.account}</p>}
                  </div>
                  <OtpBadges type={p.preview.type} algorithm={p.preview.algorithm} digits={p.preview.digits} period={p.preview.period} invalid={!p.preview.validSecret} />
                  <RemoveButton label={p.preview.issuer} onClick={() => onRemove(p.uri)} />
                </div>
              </motion.div>
            ) : (
              <motion.div key={p.uri} layout initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
                <div className="flex items-center gap-2 bg-paper-2 px-3 py-2">
                  <Layers className="size-4 text-muted-foreground" />
                  <p className="min-w-0 flex-1 truncate text-xs font-medium">
                    Google Authenticator export
                    {p.preview.batchSize > 1 && (
                      <span className="text-muted-foreground">
                        {" "}
                        · QR {p.preview.batchIndex + 1} of {p.preview.batchSize}
                      </span>
                    )}
                  </p>
                  <span className="text-xs text-muted-foreground tabular-nums">{p.preview.accounts.length}</span>
                  <RemoveButton label="this export" onClick={() => onRemove(p.uri)} />
                </div>
                {p.preview.accounts.map((a, i) => (
                  <div key={i} className="flex items-center gap-3 py-2 pr-3 pl-6">
                    <Favicon domain={issuerDomain(a.issuer)} name={a.issuer} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{a.issuer}</p>
                      {a.account && <p className="truncate text-xs text-muted-foreground">{a.account}</p>}
                    </div>
                    <OtpBadges type={a.type} algorithm={a.algorithm} digits={a.digits} />
                  </div>
                ))}
              </motion.div>
            ),
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function OtpBadges({ type, algorithm, digits, period, invalid }: { type: string; algorithm: string; digits: number; period?: number; invalid?: boolean }) {
  return (
    <div className="flex shrink-0 flex-wrap justify-end gap-1">
      {invalid && (
        <Badge variant="destructive" className="h-5 text-[10px]">
          Invalid secret
        </Badge>
      )}
      {type === "hotp" && (
        <Badge variant="outline" className="h-5 border-warning/40 text-[10px] text-warning" title="Counter-based codes may not be supported">
          Counter (HOTP)
        </Badge>
      )}
      {algorithm !== "SHA1" && (
        <Badge variant="outline" className="h-5 text-[10px] font-normal">
          {algorithm}
        </Badge>
      )}
      {digits !== 6 && (
        <Badge variant="outline" className="h-5 text-[10px] font-normal">
          {digits} digits
        </Badge>
      )}
      {period && period !== 30 && (
        <Badge variant="outline" className="h-5 text-[10px] font-normal">
          {period}s
        </Badge>
      )}
    </div>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button size="icon-xs" variant="ghost" className="text-muted-foreground hover:text-foreground" aria-label={`Remove ${label}`} onClick={onClick}>
      <X />
    </Button>
  );
}
