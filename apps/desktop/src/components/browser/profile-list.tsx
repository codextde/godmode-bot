import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { formatDistanceToNow } from "date-fns";
import { Cookie, Download, Ellipsis, Globe, Layers, Pencil, Play, Plus, Square, Star, Trash2 } from "lucide-react";
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
import { cn } from "@/lib/utils";
import type { ProfileActions } from "./use-profile-actions";
import { AssignWorkspaceDialog } from "./assign-workspace-dialog";

function relative(iso: string | null) {
  if (!iso) return null;
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
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
      <div className="grid grid-cols-1 gap-2 @2xl:grid-cols-2 @5xl:grid-cols-1" role="listbox" aria-label="Browser profiles">
        <AnimatePresence initial={false}>
          {profiles.map((p, i) => (
            <motion.div
              key={p.id}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ delay: Math.min(i, 12) * 0.03 }}
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
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The browser profile and everything in it — cookies, sessions, history, local storage — is removed from this machine.
              Agents assigned to this profile will need another one. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleteTarget) actions.remove.mutate(deleteTarget);
                setDeleteTarget(null);
              }}
            >
              <Trash2 /> Delete profile
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
  const launching = actions.launch.isPending && actions.launch.variables?.id === p.id;
  const stopping = actions.stop.isPending && actions.stop.variables?.id === p.id;
  const imported = relative(p.importedAt);
  const globalDefault = p.isDefault && !p.workspaceId;
  const canMakeDefault = !isDefault && (!p.workspaceId || p.workspaceId === workspace?.id);
  const makeDefaultLabel = !workspace ? "Set as default" : p.workspaceId || globalDefault ? `Make default in ${workspace.name}` : `Move to ${workspace.name} as default`;

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
                  <Star className="size-2.5 fill-current" /> Default
                </Badge>
              </TooltipTrigger>
              <TooltipContent>{workspace ? `New chats in ${workspace.name} browse here` : "New chats browse here unless their workspace has its own default"}</TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <ScopeBadge workspaceId={p.workspaceId} className="h-5 text-[10px]" />
          <span className="inline-flex items-center gap-1" title={`${p.cookieCount} cookies`}>
            <Cookie className="size-3" /> {p.cookieCount.toLocaleString()}
          </span>
          <span className={cn("inline-flex items-center gap-1", p.running && "text-brand-strong")}>
            {p.running ? "Running" : "Stopped"}
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
            aria-label={`Actions for ${p.name}`}
            onClick={(e) => e.stopPropagation()}
          >
            {launching || stopping ? <Spinner /> : <Ellipsis />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64" onClick={(e) => e.stopPropagation()}>
          {p.running ? (
            <DropdownMenuItem onClick={() => actions.stop.mutate(p)} disabled={stopping}>
              <Square /> Stop browser
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => actions.launch.mutate(p)} disabled={launching}>
              <Play /> Launch browser
            </DropdownMenuItem>
          )}
          {canMakeDefault && (
            <DropdownMenuItem onClick={() => actions.setDefault.mutate({ profile: p, workspace })}>
              <Star /> {makeDefaultLabel}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={onRename}>
            <Pencil /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onAssign} disabled={globalDefault}>
            <Layers /> {globalDefault ? "Global default stays global" : "Assign to workspace…"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" disabled={globalDefault} onClick={onDelete}>
            <Trash2 /> {globalDefault ? "Global default can't be deleted" : "Delete"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function RenameProfileDialog({ profile, onClose, actions }: { profile: BrowserProfile | null; onClose: () => void; actions: ProfileActions }) {
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
            <DialogTitle>Rename profile</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="rename-profile">Name</Label>
            <Input id="rename-profile" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || actions.rename.isPending}>
              {actions.rename.isPending && <Spinner />} Save
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
      toast.success(`${profile.name} created`, { description: "Launch it or import your Chrome sessions next." });
      void qc.invalidateQueries({ queryKey: qk.browserProfiles });
      onCreated(profile);
      onOpenChange(false);
    },
    onError: (e) => toastApiError(e, "Could not create the profile", qc),
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
            <DialogTitle>New browser profile</DialogTitle>
            <DialogDescription>
              A separate Chromium with its own cookies and logins — e.g. one per client or workspace, so sessions never mix.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="new-profile-name">Name</Label>
            <Input
              id="new-profile-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Marketing accounts"
              autoFocus
              maxLength={60}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-profile-scope">Available to</Label>
            <WorkspaceSelect id="new-profile-scope" value={workspaceId} onChange={setWorkspaceId} />
            <p className="text-xs text-muted-foreground">Agents pick their profile in their settings; workspace profiles are offered to that workspace's agents.</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending ? <Spinner /> : <Plus />} Create profile
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
