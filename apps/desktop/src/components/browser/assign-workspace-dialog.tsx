import { useEffect, useId, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Trans, useTranslation } from "react-i18next";
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
  const { t } = useTranslation(["browser", "common"]);
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
    actions.assign.mutate({ profile, workspaceId, isDefault, scopeName: workspace?.name ?? t("scope.global") }, { onSuccess: onClose });
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
            <DialogTitle>{t("assign.title", { name: profile?.name })}</DialogTitle>
            <DialogDescription>{t("assign.description")}</DialogDescription>
          </DialogHeader>

          <div className="max-h-[min(30rem,calc(100dvh-16rem))] space-y-4 overflow-y-auto px-6 py-5">
            <RadioGroup value={target} onValueChange={setTarget} aria-label={t("scope.workspace")} className="gap-2">
              <ScopeOption
                value={GLOBAL}
                checked={target === GLOBAL}
                current={!profile?.workspaceId}
                tile={
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-secondary text-foreground ring-1 ring-border ring-inset">
                    <Globe2 className="size-5" />
                  </span>
                }
                title={t("scope.global")}
                hint={t("assign.globalHint")}
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
                    hint={browser ? t("assign.browsesWith", { name: browser.name }) : t("assign.noProfile", { name: globalDefault?.name ?? t("assign.theGlobalDefault") })}
                  />
                );
              })}
            </RadioGroup>

            {!isLoading && workspaces.length === 0 && (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-3.5">
                <Layers className="size-5 shrink-0 text-muted-foreground" />
                <p className="min-w-0 flex-1 basis-48 text-sm text-muted-foreground">{t("assign.noWorkspaces")}</p>
                <Button type="button" variant="outline" size="sm" asChild>
                  <Link to="/workspaces?new=1">
                    <Plus /> {t("assign.newWorkspace")}
                  </Link>
                </Button>
              </div>
            )}

            {workspace && !unchanged && (
              <label htmlFor={switchId} className={cn("flex items-start gap-3 rounded-lg border bg-card p-3.5 transition", targetDefault && "cursor-pointer hover:border-foreground/15")}>
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="block text-sm font-medium">{t("assign.useFor", { name: workspace.name })}</span>
                  <span className="block text-xs text-muted-foreground">
                    {!targetDefault
                      ? t("assign.noProfileYet", { name: workspace.name })
                      : makeDefault
                        ? t("assign.replaces", { name: targetDefault.name })
                        : t("assign.keeps", { name: targetDefault.name })}
                  </span>
                </span>
                <Switch id={switchId} checked={makeDefault || !targetDefault} onCheckedChange={setMakeDefault} disabled={!targetDefault} className="mt-0.5" />
              </label>
            )}

            {leaving && (
              <div className="flex items-start gap-2.5 rounded-lg border bg-paper-2 px-3 py-2.5 text-xs text-muted-foreground">
                <Info className="mt-px size-3.5 shrink-0" />
                <p className="min-w-0">
                  <Trans
                    t={t}
                    i18nKey="assign.leaving"
                    values={{ workspace: leaving.name, profile: globalDefault?.name ?? t("assign.theGlobalDefault") }}
                    components={{ b: <span className="font-medium text-foreground" /> }}
                  />
                </p>
              </div>
            )}
          </div>

          <DialogFooter className="border-t bg-paper-2 px-6 py-4">
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" disabled={unchanged || pending}>
              {pending && <Spinner />}
              {workspaceId ? t("assign.assignProfile") : t("assign.makeGlobal")}
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
  const { t } = useTranslation("browser");
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
          {current && <span className="shrink-0 rounded-[5px] border px-1.5 py-px text-[10px] font-medium text-muted-foreground">{t("assign.current")}</span>}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{hint}</span>
      </span>
      <RadioGroupItem id={id} value={value} />
    </Label>
  );
}
