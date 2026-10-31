import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { formatDistanceToNow } from "date-fns";
import { Bot, Cookie, Download, Ellipsis, Globe, Layers, Pencil, Play, Plus, Square, Star, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { BrowserProfile, Workspace } from "@godmode/shared";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ScopeBadge } from "@/components/common";
import { LiveDot } from "@/components/aicss/Motion";
import { WorkspaceSelect } from "@/components/vault/workspace-select";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useUi } from "@/stores/ui";
import { dateLocale, intlLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import type { ProfileActions } from "./use-profile-actions";
import { AssignWorkspaceDialog } from "./assign-workspace-dialog";
import { useReduceAnimations } from "@/lib/motion";

function relative(iso: string | null) {
  if (!iso) return null;
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: dateLocale() });
  } catch {
    return null;
  }
}

export function ProfileList({
  profiles,
  defaultId,
  workspace,
  isLoading,
  selectedId,
  onSelect,
  actions,
}: {
  profiles: BrowserProfile[];
  /** The profile new chats in `workspace` browse with. */
  defaultId: string | null;
  /** Workspace picked in the sidebar; null = global. */
  workspace: Workspace | null;
  isLoading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  actions: ProfileActions;
}) {
  const reduce = useReduceAnimations();
  const { t } = useTranslation(["browser", "common"]);
  const [renameTarget, setRenameTarget] = useState<BrowserProfile | null>(null);
  const [assignTarget, setAssignTarget] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BrowserProfile | null>(null);

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-2 @2xl:grid-cols-2 @5xl:grid-cols-1">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[84px] rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-2 @2xl:grid-cols-2 @5xl:grid-cols-1" role="listbox" aria-label={t("list.aria")}>
        <AnimatePresence initial={false}>
          {profiles.map((p, i) => (
            <motion.div
              key={p.id}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={reduce ? undefined : { delay: Math.min(i, 12) * 0.03 }}
            >
              <ProfileCard
                profile={p}
                isDefault={p.id === defaultId}
                workspace={workspace}
                selected={p.id === selectedId}
                onSelect={() => onSelect(p.id)}
                actions={actions}
                onRename={() => setRenameTarget(p)}
                onAssign={() => setAssignTarget(p.id)}
                onDelete={() => setDeleteTarget(p)}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <RenameProfileDialog profile={renameTarget} onClose={() => setRenameTarget(null)} actions={actions} />
      <AssignWorkspaceDialog profileId={assignTarget} profiles={profiles} onClose={() => setAssignTarget(null)} actions={actions} />

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("list.deleteTitle", { name: deleteTarget?.name })}</AlertDialogTitle>
            <AlertDialogDescription>{t("list.deleteBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleteTarget) actions.remove.mutate(deleteTarget);
                setDeleteTarget(null);
              }}
            >
              <Trash2 /> {t("list.deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ProfileCard({
  profile: p,
  isDefault,
  workspace,
  selected,
  onSelect,
  actions,
  onRename,
  onAssign,
  onDelete,
}: {
  profile: BrowserProfile;
  isDefault: boolean;
  workspace: Workspace | null;
  selected: boolean;
  onSelect: () => void;
  actions: ProfileActions;
  onRename: () => void;
  onAssign: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation(["browser", "common"]);
  const launching = actions.launch.isPending && actions.launch.variables?.id === p.id;
  const stopping = actions.stop.isPending && actions.stop.variables?.id === p.id;
  const imported = relative(p.importedAt);
  const globalDefault = p.isDefault && !p.workspaceId;
  const canMakeDefault = !isDefault && (!p.workspaceId || p.workspaceId === workspace?.id);
  const makeDefaultLabel = !workspace
    ? t("list.setDefault")
    : p.workspaceId || globalDefault
      ? t("list.makeDefaultIn", { workspace: workspace.name })
      : t("list.moveAsDefault", { workspace: workspace.name });

  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group relative flex cursor-pointer items-start gap-3 rounded-xl border bg-card p-3.5 shadow-card transition outline-none",
        "hover:border-foreground/15 hover:shadow-float focus-visible:ring-[3px] focus-visible:ring-ring/50",
        selected && "border-foreground/35 ring-1 ring-foreground/10 hover:border-foreground/35",
      )}
    >
      <div className="relative">
        <div
          className={cn(
            "grid size-10 place-items-center rounded-lg border text-foreground",
            p.running ? "bg-card shadow-card" : "bg-paper-2 text-muted-foreground",
          )}
        >
          <Globe className="size-5" />
        </div>
        <span className="absolute -right-1 -bottom-1 grid place-items-center rounded-full bg-card p-[2px]">
          <LiveDot live={p.running} />
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium tracking-[-0.01em]">{p.name}</span>
          {isDefault && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="secondary" className="h-5 gap-1 px-1.5 text-[10px]">
                  <Star className="size-2.5 fill-current" /> {t("list.default")}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>{workspace ? t("list.defaultTooltipWs", { workspace: workspace.name }) : t("list.defaultTooltip")}</TooltipContent>
            </Tooltip>
          )}
          {p.createdByAgentId && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[10px]">
                  <Bot className="size-2.5" /> {t("common:words.agent")}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>{t("list.agentTooltip")}</TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <ScopeBadge workspaceId={p.workspaceId} className="h-5 text-[10px]" />
          <span className="inline-flex items-center gap-1" title={t("cookies", { count: p.cookieCount, n: String(p.cookieCount) })}>
            <Cookie className="size-3" /> {p.cookieCount.toLocaleString(intlLocale())}
          </span>
          <span className={cn("inline-flex items-center gap-1", p.running && "text-brand-strong")}>
            {p.running ? (p.chats.length ? t("list.chats", { count: p.chats.length }) : t("list.running")) : t("list.stopped")}
          </span>
        </div>
        {p.importedFrom && (
          <p className="mt-1 truncate text-[11px] text-muted-foreground/90" title={p.importedFrom}>
            <Download className="mr-1 inline size-3 -translate-y-px" />
            {p.importedFrom}
            {imported && ` · ${imported}`}
          </p>
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="-mt-1 -mr-1 text-muted-foreground opacity-70 group-hover:opacity-100"
            aria-label={t("list.actionsFor", { name: p.name })}
            onClick={(e) => e.stopPropagation()}
          >
            {launching || stopping ? <Spinner /> : <Ellipsis />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64" onClick={(e) => e.stopPropagation()}>
          {p.running ? (
            <DropdownMenuItem onClick={() => actions.stop.mutate(p)} disabled={stopping}>
              <Square /> {t("list.stopBrowser")}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => actions.launch.mutate(p)} disabled={launching}>
              <Play /> {t("list.launchBrowser")}
            </DropdownMenuItem>
          )}
          {canMakeDefault && (
            <DropdownMenuItem onClick={() => actions.setDefault.mutate({ profile: p, workspace })}>
              <Star /> {makeDefaultLabel}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={onRename}>
            <Pencil /> {t("common:actions.rename")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onAssign} disabled={globalDefault}>
            <Layers /> {globalDefault ? t("list.globalStays") : t("list.assignTo")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" disabled={globalDefault} onClick={onDelete}>
            <Trash2 /> {globalDefault ? t("list.cantDelete") : t("common:actions.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function RenameProfileDialog({ profile, onClose, actions }: { profile: BrowserProfile | null; onClose: () => void; actions: ProfileActions }) {
  const { t } = useTranslation(["browser", "common"]);
  const [name, setName] = useState("");
  useEffect(() => {
    if (profile) setName(profile.name);
  }, [profile]);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile || !name.trim()) return;
    actions.rename.mutate({ id: profile.id, name: name.trim() }, { onSuccess: onClose });
  };
  return (
    <Dialog open={!!profile} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t("list.renameTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="rename-profile">{t("common:words.name")}</Label>
            <Input id="rename-profile" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" disabled={!name.trim() || actions.rename.isPending}>
              {actions.rename.isPending && <Spinner />} {t("common:actions.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CreateProfileDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (profile: BrowserProfile) => void;
}) {
  const { t } = useTranslation(["browser", "common"]);
  const qc = useQueryClient();
  const scope = useUi((s) => s.workspace);
  const [name, setName] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setWorkspaceId(scope !== "all" && scope !== "global" ? scope : null);
  }, [open, scope]);

  const create = useMutation({
    mutationFn: () => api.browser.createProfile({ name: name.trim(), workspaceId }),
    onSuccess: (profile) => {
      toast.success(t("list.created", { name: profile.name }), { description: t("list.createdDescription") });
      void qc.invalidateQueries({ queryKey: qk.browserProfiles });
      onCreated(profile);
      onOpenChange(false);
    },
    onError: (e) => toastApiError(e, t("list.createFailed"), qc),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("list.newTitle")}</DialogTitle>
            <DialogDescription>{t("list.newDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="new-profile-name">{t("common:words.name")}</Label>
            <Input
              id="new-profile-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("list.namePlaceholder")}
              autoFocus
              maxLength={60}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-profile-scope">{t("list.availableTo")}</Label>
            <WorkspaceSelect id="new-profile-scope" value={workspaceId} onChange={setWorkspaceId} />
            <p className="text-xs text-muted-foreground">{t("list.availableHint")}</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending ? <Spinner /> : <Plus />} {t("page.createProfile")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
