import { memo, useId } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight, Copy, Lock, Pencil, Server, ServerCog, ShieldAlert, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SshManagedKey, SshServer } from "@godmode/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useReduceAnimations } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { copyText } from "./clipboard";
import { CopyButton } from "./copy-button";

const CHIP: Record<string, string> = { ed25519: "ED", rsa: "RSA", ecdsa: "EC", dsa: "DSA", "ed25519-sk": "SK", "ecdsa-sk": "SK" };
const LABEL: Record<string, string> = { ed25519: "Ed25519", rsa: "RSA", ecdsa: "ECDSA", dsa: "DSA", "ed25519-sk": "Ed25519-SK", "ecdsa-sk": "ECDSA-SK" };

const shortPrint = (fingerprint: string) => (fingerprint.length > 24 ? `${fingerprint.slice(0, 14)}…${fingerprint.slice(-6)}` : fingerprint);

export interface SshKeyActions {
  toggle: (key: SshManagedKey, enabled: boolean) => void;
  setLoaded: (key: SshManagedKey, loaded: boolean) => void;
  fixPermissions: (key: SshManagedKey) => void;
  install: (key: SshManagedKey, server: SshServer) => void;
  edit: (key: SshManagedKey) => void;
  remove: (key: SshManagedKey) => void;
}

export const SshKeyRow = memo(function SshKeyRow({
  sshKey: key,
  open,
  onOpenChange,
  agentAvailable,
  servers,
  actions,
}: {
  sshKey: SshManagedKey;
  open: boolean;
  onOpenChange: (name: string | null) => void;
  agentAvailable: boolean;
  servers: SshServer[];
  actions: SshKeyActions;
}) {
  const { t } = useTranslation("vault");
  const reduce = useReduceAnimations();
  const detailId = useId();
  const toggle = () => onOpenChange(open ? null : key.name);
  const place = [key.comment, ...key.hosts.slice(0, 2).map((h) => (h === "*" ? t("sshKeys.allHosts") : h))].filter(Boolean);
  const more = key.hosts.length - 2;

  return (
    <div className={cn(open && "bg-paper-2/60")}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls={detailId}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            toggle();
          }
        }}
        className="group flex cursor-default items-center gap-3 px-4 py-3 outline-none transition-colors hover:bg-foreground/[0.025] focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50"
      >
        <span
          className={cn(
            "grid h-7 w-10 shrink-0 place-items-center rounded-md border bg-paper-2 font-mono text-[10.5px] font-medium tracking-wide text-foreground/70",
            !key.enabled && "opacity-50",
          )}
        >
          {CHIP[key.algorithm] ?? "?"}
        </span>
        <div className={cn("min-w-0 flex-1", !key.enabled && "opacity-55")}>
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium">{key.name}</span>
            {key.encrypted && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Lock className="size-3 shrink-0 text-muted-foreground" aria-label={t("sshKeys.passphrase")} />
                </TooltipTrigger>
                <TooltipContent>{t("sshKeys.passphrase")}</TooltipContent>
              </Tooltip>
            )}
            {key.inAgent && (
              <Badge variant="secondary" className="h-[18px] shrink-0 px-1.5 text-[10.5px] font-normal">
                {t("sshKeys.loadedBadge")}
              </Badge>
            )}
            {!key.hasPrivate && (
              <Badge variant="outline" className="h-[18px] shrink-0 px-1.5 text-[10.5px] font-normal">
                {t("sshKeys.publicOnly")}
              </Badge>
            )}
            {key.format === "putty" && (
              <Badge variant="outline" className="h-[18px] shrink-0 px-1.5 text-[10.5px] font-normal">
                PuTTY
              </Badge>
            )}
            {key.looseMode && <ShieldAlert className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-label={t("sshKeys.looseTitle")} />}
          </div>
          {place.length > 0 && (
            <p className="truncate text-xs text-muted-foreground">
              {place.join(" · ")}
              {more > 0 && ` +${more}`}
            </p>
          )}
        </div>
        {key.fingerprint && <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground @3xl:block">{shortPrint(key.fingerprint)}</span>}
        {key.publicKey && (
          <CopyButton
            value={key.publicKey}
            label={t("sshKeys.copyPublic")}
            toastLabel={t("sshKeys.publicCopied")}
            className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 max-sm:opacity-100"
          />
        )}
        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} className="flex">
          <Switch checked={key.enabled} onCheckedChange={(on) => actions.toggle(key, on)} aria-label={t("sshKeys.enabledFor", { name: key.name })} />
        </span>
        <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground/70 transition-transform", open && "rotate-90")} aria-hidden />
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={detailId}
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduce ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.25, 0.1, 0.25, 1] }}
            className="overflow-hidden"
          >
            <SshKeyDetail sshKey={key} agentAvailable={agentAvailable} servers={servers} actions={actions} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

function Section({ label, children, action }: { label: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex min-h-6 items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {action}
      </div>
      {children}
    </div>
  );
}

function SshKeyDetail({
  sshKey: key,
  agentAvailable,
  servers,
  actions,
}: {
  sshKey: SshManagedKey;
  agentAvailable: boolean;
  servers: SshServer[];
  actions: SshKeyActions;
}) {
  const { t } = useTranslation("vault");
  const switchId = useId();
  const type = [LABEL[key.algorithm] ?? t("sshKeys.unknownType"), key.bits ? t("sshKeys.bits", { bits: key.bits }) : null, key.encrypted ? t("sshKeys.passphrase") : null].filter(Boolean).join(" · ");
  const canLoad = key.hasPrivate && key.enabled && key.format !== "putty" && agentAvailable && !key.looseMode;
  const usable = servers.filter((s) => !key.servers.some((u) => u.id === s.id));
  const usedBy = key.hosts.length + key.servers.length;

  return (
    <div className="space-y-4 border-t border-dashed px-4 py-4 sm:pl-[4.25rem]">
      {key.looseMode && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-[13px]">
          <span className="flex items-center gap-2">
            <ShieldAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            {t("sshKeys.looseTitle")}
          </span>
          <Button size="sm" variant="outline" onClick={() => actions.fixPermissions(key)}>
            {t("sshKeys.fix")}
          </Button>
        </div>
      )}

      <div className="grid gap-4 @3xl:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0 space-y-4">
          <p className="text-[13px] text-muted-foreground">{type}</p>
          {key.publicKey && (
            <Section
              label={t("sshKeys.publicKey")}
              action={
                <Button size="xs" variant="outline" onClick={() => void copyText(key.publicKey!, t("sshKeys.publicCopied"))}>
                  <Copy /> {t("sshKeys.copy")}
                </Button>
              }
            >
              <p className="rounded-lg border bg-card px-3 py-2 font-mono text-[11.5px] leading-relaxed break-all text-foreground/80 select-text">{key.publicKey}</p>
            </Section>
          )}
          {key.fingerprint && (
            <Section label={t("sshKeys.fingerprint")}>
              <div className="flex min-w-0 items-center gap-1">
                <span className="truncate font-mono text-xs select-text">{key.fingerprint}</span>
                <CopyButton value={key.fingerprint} size="icon-xs" toastLabel={t("sshKeys.fingerprintCopied")} className="shrink-0" />
              </div>
            </Section>
          )}
          {usedBy > 0 && (
            <Section label={t("sshKeys.usedBy")}>
              <div className="flex flex-wrap gap-1.5">
                {key.hosts.map((host) => (
                  <span key={host} className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-card px-2 py-0.5 text-xs">
                    <Server className="size-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">{host === "*" ? t("sshKeys.allHosts") : host}</span>
                  </span>
                ))}
                {key.servers.map((server) => (
                  <Link key={server.id} to={`/ssh?edit=${server.id}`} className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-card px-2 py-0.5 text-xs outline-none transition hover:border-foreground/20 focus-visible:ring-[3px] focus-visible:ring-ring/50">
                    <ServerCog className="size-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">{server.name}</span>
                  </Link>
                ))}
              </div>
            </Section>
          )}
        </div>
        {key.randomart && (
          <pre aria-hidden className="hidden self-start rounded-lg border bg-card px-3 py-2 font-mono text-[10px] leading-[1.15] text-muted-foreground select-none @3xl:block">
            {key.randomart}
          </pre>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-1">
        {canLoad || key.inAgent ? (
          <label htmlFor={switchId} className="flex cursor-default items-center gap-2.5 text-[13px]">
            <Switch id={switchId} checked={key.inAgent} onCheckedChange={(loaded) => actions.setLoaded(key, loaded)} />
            {t("sshKeys.inAgent")}
          </label>
        ) : (
          <span />
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          {usable.length > 0 && key.publicKey && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">
                  <Server /> {t("sshKeys.addToServer")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
                {usable.map((server) => (
                  <DropdownMenuItem key={server.id} onSelect={() => actions.install(key, server)}>
                    <span className="truncate">{server.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button size="sm" variant="outline" onClick={() => actions.edit(key)}>
            <Pencil /> {t("sshKeys.edit")}
          </Button>
          <Button size="sm" variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => actions.remove(key)}>
            <Trash2 /> {t("sshKeys.delete")}
          </Button>
        </div>
      </div>
    </div>
  );
}
