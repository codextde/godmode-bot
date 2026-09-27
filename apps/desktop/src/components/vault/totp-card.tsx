import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Copy, KeyRound, Link2, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { Credential, TotpEntry } from "@godmode/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScopeBadge } from "@/components/common";
import { cn } from "@/lib/utils";
import { CountdownRing } from "./countdown-ring";
import { Favicon } from "./favicon";
import { copySecret } from "./clipboard";
import { formatCode, issuerDomain, type LiveCode } from "./use-totp-codes";
import { domainFromUrl } from "./vault-utils";

export function TotpCard({
  entry,
  code,
  now,
  credential,
  hideCodes,
  index,
  onEdit,
  onDelete,
}: {
  entry: TotpEntry;
  code: LiveCode | undefined;
  now: number;
  credential?: Credential;
  hideCodes: boolean;
  index: number;
  onEdit: (focusLink?: boolean) => void;
  onDelete: () => void;
}) {
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  const [peek, setPeek] = useState(false);

  const period = code?.period ?? entry.period ?? 30;
  const remaining = code ? (code.expiresAt - now) / 1000 : 0;
  const expired = !code || remaining <= 0;
  const domain = credential ? (credential.domains[0] ?? domainFromUrl(credential.url)) : issuerDomain(entry.issuer);
  const masked = hideCodes && !peek;

  const copy = async () => {
    if (!code || expired) return;
    await copySecret(code.code, `${entry.issuer} code copied`);
    setCopiedAt(Date.now());
    setTimeout(() => setCopiedAt(null), 1400);
  };

  const digits = entry.digits || 6;
  const placeholder = formatCode("•".repeat(digits));

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.18 } }}
      transition={{ delay: Math.min(index, 12) * 0.03 }}
      onMouseEnter={() => setPeek(true)}
      onMouseLeave={() => setPeek(false)}
      onFocus={() => setPeek(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setPeek(false)}
      className="group relative flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-card transition hover:border-foreground/15 hover:shadow-float"
    >
      <div className="flex items-start gap-3">
        <Favicon domain={domain} name={entry.issuer} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium tracking-[-0.01em]">{entry.issuer}</p>
          <p className="truncate text-xs text-muted-foreground">{entry.accountName || "No account name"}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="-mt-1 -mr-1 text-muted-foreground" aria-label={`Actions for ${entry.issuer}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => void copy()} disabled={expired}>
              <Copy /> Copy code
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onEdit(false)}>
              <Pencil /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onEdit(true)}>
              <Link2 /> {entry.credentialId ? "Change linked login" : "Link to a login"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => void copy()}
          disabled={expired}
          aria-label={masked ? `Copy ${entry.issuer} code` : `Copy ${entry.issuer} code ${code?.code ?? ""}`}
          className="relative -mx-2 flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default"
        >
          {code ? (
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={`${code.code}-${masked}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: expired ? 0.35 : 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.2 }}
                className={cn(
                  "font-mono text-[28px] leading-none font-medium tracking-[0.06em] tabular-nums",
                  !masked && !expired && remaining <= 5 ? "text-destructive" : "text-foreground",
                  masked && "text-muted-foreground",
                )}
              >
                {masked ? placeholder : formatCode(code.code)}
              </motion.span>
            </AnimatePresence>
          ) : (
            <Skeleton className="h-7 w-32 rounded-lg" />
          )}
          <span className="grid size-6 place-items-center text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
            {copiedAt ? <Check className="size-4 text-success" /> : <Copy className="size-3.5" />}
          </span>
          <AnimatePresence>
            {copiedAt && (
              <motion.span
                key={copiedAt}
                initial={{ opacity: 0, y: 4, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4 }}
                className="absolute -top-5 left-2 rounded-[5px] border border-success/25 bg-card px-1.5 py-0.5 text-[10px] font-medium text-success shadow-card"
              >
                Copied
              </motion.span>
            )}
          </AnimatePresence>
        </button>
        <CountdownRing progress={expired ? 0 : remaining / period} seconds={expired ? 0 : remaining} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {credential ? (
          <Badge variant="secondary" className="max-w-[60%] gap-1 font-normal">
            <KeyRound className="size-3" />
            <span className="truncate">{credential.name}</span>
          </Badge>
        ) : (
          <button
            type="button"
            onClick={() => onEdit(true)}
            className="inline-flex h-5 items-center gap-1 rounded-[5px] border border-dashed px-1.5 text-[11px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
          >
            <Link2 className="size-3" /> Link login
          </button>
        )}
        <ScopeBadge workspaceId={entry.workspaceId} />
        {(entry.algorithm !== "SHA1" || digits !== 6 || entry.period !== 30) && (
          <Badge variant="outline" className="font-normal text-muted-foreground">
            {[entry.algorithm !== "SHA1" && entry.algorithm, digits !== 6 && `${digits} digits`, entry.period !== 30 && `${entry.period}s`].filter(Boolean).join(" · ")}
          </Badge>
        )}
      </div>
    </motion.div>
  );
}

export function TotpCardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-card">
      <div className="flex items-center gap-3">
        <Skeleton className="size-9 rounded-lg" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-3 w-32" />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-36 rounded-lg" />
        <Skeleton className="size-9 rounded-full" />
      </div>
      <Skeleton className="h-5 w-40 rounded-md" />
    </div>
  );
}
