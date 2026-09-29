import { useEffect, useId, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Globe2, Info, Layers, Plus } from "lucide-react";
import type { BrowserProfile } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { WorkspaceTile } from "@/components/workspaces/workspace-tile";
import { useWorkspaces } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import type { ProfileActions } from "./use-profile-actions";

const GLOBAL = "__global";

export function AssignWorkspaceDialog({
  profileId,
  profiles,
  onClose,
  actions,
}: {
  profileId: string | null;
  profiles: BrowserProfile[];
  onClose: () => void;
  actions: ProfileActions;
}) {
  const { data: workspaces = [], isLoading } = useWorkspaces();
  const [target, setTarget] = useState(GLOBAL);
  const [makeDefault, setMakeDefault] = useState(true);
  const switchId = useId();
  const profile = profiles.find((p) => p.id === profileId) ?? null;
  const pending = actions.assign.isPending;

  useEffect(() => {
    if (!profile) return;
    setTarget(profile.workspaceId ?? GLOBAL);
    setMakeDefault(true);
  }, [profileId]); // eslint-disable-line react-hooks/exhaustive-deps

  const workspaceId = target === GLOBAL ? null : target;
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const defaultOf = (scope: string | null) => profiles.find((p) => p.workspaceId === scope && p.isDefault);
  const globalDefault = defaultOf(null);
  const targetDefault = workspaceId ? defaultOf(workspaceId) : undefined;
  const unchanged = !profile || workspaceId === profile.workspaceId;
  const leaving = profile?.workspaceId && profile.isDefault && !unchanged ? workspaces.find((w) => w.id === profile.workspaceId) : undefined;

  const submit = () => {
    if (!profile || unchanged) return;
    const isDefault = workspaceId ? makeDefault || !targetDefault : undefined;
    actions.assign.mutate({ profile, workspaceId, isDefault, scopeName: workspace?.name ?? "Global" }, { onSuccess: onClose });
  };

  return (
    <Dialog open={!!profile} onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-lg">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogHeader className="border-b bg-paper-2 px-6 pt-6 pb-5">
            <DialogTitle>Assign “{profile?.name}” to a workspace</DialogTitle>
            <DialogDescription>
              Cookies and sessions stay with the profile. Agents that picked it in their own settings keep using it wherever they are.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[min(30rem,calc(100dvh-16rem))] space-y-4 overflow-y-auto px-6 py-5">
            <RadioGroup value={target} onValueChange={setTarget} aria-label="Workspace" className="gap-2">
              <ScopeOption
                value={GLOBAL}
                checked={target === GLOBAL}
                current={!profile?.workspaceId}
                tile={
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-secondary text-foreground ring-1 ring-border ring-inset">
                    <Globe2 className="size-5" />
                  </span>
                }
                title="Global"
                hint="Not tied to a workspace; agents use it when they pick it"
              />
              {workspaces.map((w) => {
                const browser = defaultOf(w.id);
                return (
                  <ScopeOption
                    key={w.id}
                    value={w.id}
                    checked={target === w.id}
                    current={profile?.workspaceId === w.id}
                    tile={<WorkspaceTile icon={w.icon} color={w.color} size="md" />}
                    title={w.name}
                    hint={browser ? `Agents browse with ${browser.name}` : `No profile yet — agents browse with ${globalDefault?.name ?? "the global default"}`}
                  />
                );
              })}
            </RadioGroup>

            {!isLoading && workspaces.length === 0 && (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-3.5">
                <Layers className="size-5 shrink-0 text-muted-foreground" />
                <p className="min-w-0 flex-1 basis-48 text-sm text-muted-foreground">No workspaces yet — create one per client or project to keep their sessions apart.</p>
                <Button type="button" variant="outline" size="sm" asChild>
                  <Link to="/workspaces?new=1">
                    <Plus /> New workspace
                  </Link>
                </Button>
              </div>
            )}

            {workspace && !unchanged && (
              <label htmlFor={switchId} className={cn("flex items-start gap-3 rounded-lg border bg-card p-3.5 transition", targetDefault && "cursor-pointer hover:border-foreground/15")}>
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="block text-sm font-medium">Use for {workspace.name}'s agents</span>
                  <span className="block text-xs text-muted-foreground">
                    {!targetDefault
                      ? `${workspace.name} has no profile yet, so its agents browse with this one unless they pick their own.`
                      : makeDefault
                        ? `Replaces ${targetDefault.name} as the browser its agents use, unless they pick their own.`
                        : `Its agents keep browsing with ${targetDefault.name}.`}
                  </span>
                </span>
                <Switch id={switchId} checked={makeDefault || !targetDefault} onCheckedChange={setMakeDefault} disabled={!targetDefault} className="mt-0.5" />
              </label>
            )}

            {leaving && (
              <div className="flex items-start gap-2.5 rounded-lg border bg-paper-2 px-3 py-2.5 text-xs text-muted-foreground">
                <Info className="mt-px size-3.5 shrink-0" />
                <p className="min-w-0">
                  {leaving.name}'s agents will browse with <span className="font-medium text-foreground">{globalDefault?.name ?? "the global default"}</span> instead, unless you
                  make another of its profiles the default.
                </p>
              </div>
            )}
          </div>

          <DialogFooter className="border-t bg-paper-2 px-6 py-4">
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={unchanged || pending}>
              {pending && <Spinner />}
              {workspaceId ? "Assign profile" : "Make global"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ScopeOption({
  value,
  checked,
  current,
  tile,
  title,
  hint,
}: {
  value: string;
  checked: boolean;
  current: boolean;
  tile: ReactNode;
  title: string;
  hint: string;
}) {
  const id = useId();
  return (
    <Label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-lg border bg-card p-3 font-normal transition hover:border-foreground/15",
        checked && "border-foreground/35 bg-paper-2 ring-1 ring-foreground/10 hover:border-foreground/35",
      )}
    >
      {tile}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <span className="truncate">{title}</span>
          {current && <span className="shrink-0 rounded-[5px] border px-1.5 py-px text-[10px] font-medium text-muted-foreground">Current</span>}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{hint}</span>
      </span>
      <RadioGroupItem id={id} value={value} />
    </Label>
  );
}
