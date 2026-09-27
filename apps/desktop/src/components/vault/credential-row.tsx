import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { formatDistanceToNow } from "date-fns";
import { Copy, ExternalLink, Eye, EyeOff, KeyRound, MoreHorizontal, Pencil, ShieldCheck, Trash2, UserRound } from "lucide-react";
import type { Credential, TotpEntry } from "@godmode/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScopeBadge } from "@/components/common";
import { api } from "@/lib/api";
import { openExternal } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { Favicon } from "./favicon";
import { CopyButton } from "./copy-button";
import { copySecret, copyText } from "./clipboard";
import { domainFromUrl, normalizeUrl, toastApiError } from "./vault-utils";
import { isGrantCancelled, withGrant } from "./grant";

const REVEAL_SECONDS = 20;

/** Column template shared by the list header and rows (container query: wide = table, narrow = stacked). */
export const CREDENTIAL_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 @3xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,0.9fr)_auto]";

export function CredentialRow({
  credential: c,
  totp,
  index,
  onEdit,
  onDelete,
}: {
  credential: Credential;
  totp?: TotpEntry;
  index: number;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const qc = useQueryClient();
  const [revealed, setRevealed] = useState<{ password: string | null; at: number } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const domain = c.domains[0] ?? domainFromUrl(c.url);

  const hide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    setRevealed(null);
  };
  useEffect(() => () => void (hideTimer.current && clearTimeout(hideTimer.current)), []);

  const reveal = useMutation({
    mutationFn: () => withGrant((grant) => api.credentials.reveal(c.id, grant)),
    onError: (e) => !isGrantCancelled(e) && toastApiError(e, "Could not reveal password", qc),
  });

  const showPassword = async () => {
    const res = await reveal.mutateAsync();
    setRevealed({ password: res.password, at: Date.now() });
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setRevealed(null), REVEAL_SECONDS * 1000);
  };

  const getPassword = async () => {
    if (revealed?.password) return revealed.password;
    const res = await reveal.mutateAsync().catch((e: unknown) => {
      if (isGrantCancelled(e)) return null;
      throw e;
    });
    return res?.password ?? null;
  };

  const lastUsed = c.lastUsedAt ? formatDistanceToNow(new Date(c.lastUsedAt), { addSuffix: true }) : null;

  const passwordCell = !c.hasPassword ? (
    <span className="text-xs text-muted-foreground italic">No password</span>
  ) : (
    <div className="flex min-w-0 items-center gap-1">
      <div className="relative min-w-0 flex-1 overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          {revealed ? (
            <motion.span
              key="shown"
              initial={{ opacity: 0, filter: "blur(4px)" }}
              animate={{ opacity: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, filter: "blur(4px)" }}
              className="block truncate font-mono text-[13px] select-all"
              title="Hides automatically"
            >
              {revealed.password ?? "—"}
            </motion.span>
          ) : (
            <motion.span key="hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="block font-mono text-sm tracking-[0.2em] text-muted-foreground" aria-label="Password hidden">
              ••••••••••
            </motion.span>
          )}
        </AnimatePresence>
        {revealed && (
          <motion.div
            key={revealed.at}
            className="absolute -bottom-0.5 left-0 h-0.5 rounded-full bg-primary/60"
            initial={{ width: "100%" }}
            animate={{ width: "0%" }}
            transition={{ duration: REVEAL_SECONDS, ease: "linear" }}
            aria-hidden
          />
        )}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-foreground"
            aria-label={revealed ? "Hide password" : "Reveal password"}
            onClick={(e) => {
              e.stopPropagation();
              if (revealed) hide();
              else void showPassword().catch(() => undefined);
            }}
            disabled={reveal.isPending}
          >
            {reveal.isPending ? <Spinner /> : revealed ? <EyeOff /> : <Eye />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{revealed ? "Hide" : `Reveal for ${REVEAL_SECONDS} s (audited)`}</TooltipContent>
      </Tooltip>
      <CopyButton getValue={getPassword} secret label="Copy password" toastLabel="Password copied" />
    </div>
  );

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -16, transition: { duration: 0.18 } }}
      transition={{ delay: Math.min(index, 12) * 0.03 }}
      className={cn(CREDENTIAL_GRID, "group gap-y-2 px-4 py-3 transition-colors hover:bg-accent/40")}
    >
      {/* Login */}
      <button type="button" onClick={onEdit} className="flex min-w-0 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        <Favicon domain={domain} name={c.name} />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium">{c.name}</span>
            {c.totpId && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="secondary" className="h-5 gap-0.5 bg-success/12 px-1.5 text-[10px] text-success">
                    <ShieldCheck /> 2FA
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  {totp ? `Linked to ${totp.issuer}${totp.accountName ? ` · ${totp.accountName}` : ""}` : "Two-factor code linked"}
                </TooltipContent>
              </Tooltip>
            )}
            {c.tags.slice(0, 2).map((t) => (
              <Badge key={t} variant="outline" className="hidden h-5 px-1.5 text-[10px] font-normal text-muted-foreground @xl:inline-flex">
                {t}
              </Badge>
            ))}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            <span className="@3xl:hidden">{c.username || domain || "—"}</span>
            <span className="hidden @3xl:inline">{c.domains.length ? c.domains.join(", ") : domain || "—"}</span>
          </div>
        </div>
      </button>

      {/* Username */}
      <div className="hidden min-w-0 items-center gap-1 @3xl:flex">
        {c.username ? (
          <>
            <span className="truncate text-sm">{c.username}</span>
            <CopyButton value={c.username} label="Copy username" toastLabel="Username copied" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />
          </>
        ) : (
          <span className="text-xs text-muted-foreground italic">No username</span>
        )}
      </div>

      {/* Password */}
      <div className="hidden min-w-0 @3xl:block">{passwordCell}</div>

      {/* Scope + last used */}
      <div className="hidden min-w-0 flex-col items-start gap-1 @3xl:flex">
        <ScopeBadge workspaceId={c.workspaceId} className="max-w-full truncate" />
        <span className="text-[11px] text-muted-foreground">{lastUsed ? `Used ${lastUsed}` : "Never used"}</span>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-0.5">
        <div className="@3xl:hidden">
          {c.hasPassword && <CopyButton getValue={getPassword} secret label="Copy password" toastLabel="Password copied" icon={<KeyRound />} />}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${c.name}`} className="text-muted-foreground">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={onEdit}>
              <Pencil /> Edit
            </DropdownMenuItem>
            {c.username && (
              <DropdownMenuItem onClick={() => void copyText(c.username, "Username copied")}>
                <UserRound /> Copy username
              </DropdownMenuItem>
            )}
            {c.hasPassword && (
              <DropdownMenuItem
                onClick={() =>
                  void getPassword()
                    .then((p) => (p ? copySecret(p, "Password copied") : undefined))
                    .catch(() => undefined)
                }
              >
                <Copy /> Copy password
              </DropdownMenuItem>
            )}
            {(c.url || domain) && (
              <DropdownMenuItem onClick={() => void openExternal(normalizeUrl(c.url || domain))}>
                <ExternalLink /> Open website
              </DropdownMenuItem>
            )}
            {c.totpId && (
              <DropdownMenuItem asChild>
                <Link to="/vault/2fa">
                  <ShieldCheck /> View 2FA code
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </motion.div>
  );
}
