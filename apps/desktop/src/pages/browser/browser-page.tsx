import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Globe, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, PageBody, PageHeader } from "@/components/common";
import { CreateProfileDialog, ProfileList } from "@/components/browser/profile-list";
import { LiveView } from "@/components/browser/live-view";
import { ImportSessionsCard } from "@/components/browser/import-sessions";
import { ProfileUseCard } from "@/components/browser/profile-use-card";
import { useProfileActions } from "@/components/browser/use-profile-actions";
import { isVaultLocked } from "@/components/vault/vault-utils";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { Skeleton } from "@/components/ui/skeleton";

export default function BrowserPage() {
  const [params, setParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  const actions = useProfileActions();

  const profilesQuery = useQuery({ queryKey: qk.browserProfiles, queryFn: api.browser.profiles });
  const profiles = profilesQuery.data ?? [];

  const requested = params.get("profile");
  const selected = profiles.find((p) => p.id === requested) ?? profiles.find((p) => p.isDefault) ?? profiles[0] ?? null;

  const select = (id: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("profile", id);
        return next;
      },
      { replace: true },
    );

  // Drop a stale ?profile= (e.g. after deletion).
  useEffect(() => {
    if (requested && profilesQuery.isSuccess && !profiles.some((p) => p.id === requested)) {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("profile");
          return next;
        },
        { replace: true },
      );
    }
  }, [requested, profilesQuery.isSuccess, profiles, setParams]);

  const launching = !!selected && actions.launch.isPending && actions.launch.variables?.id === selected.id;

  return (
    <div className="relative">
      <PageHeader
        icon={<Globe />}
        title="Browser"
        description="Godmode's own Chromium profiles. Agents browse here — signed in with the sessions you import — and you can watch or take over at any time."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus /> New profile
          </Button>
        }
      />
      <PageBody>
        {profilesQuery.isError ? (
          <EmptyState
            icon={<Globe />}
            title={isVaultLocked(profilesQuery.error) ? "Vault is locked" : "Couldn't load browser profiles"}
            description={errorMessage(profilesQuery.error)}
            action={
              <Button variant="outline" onClick={() => profilesQuery.refetch()}>
                <RefreshCw /> Try again
              </Button>
            }
          />
        ) : !profilesQuery.isLoading && profiles.length === 0 ? (
          <EmptyState
            icon={<Globe />}
            title="No browser profiles yet"
            description="Create a profile to give your agents a browser. The core normally creates a default one on start."
            action={
              <Button onClick={() => setCreateOpen(true)}>
                <Plus /> Create profile
              </Button>
            }
          />
        ) : (
          <div className="grid gap-6 xl:grid-cols-[300px_minmax(0,1fr)]">
            <aside className="space-y-3">
              <h2 className="eyebrow px-1">Profiles</h2>
              <ProfileList profiles={profiles} isLoading={profilesQuery.isLoading} selectedId={selected?.id ?? null} onSelect={select} actions={actions} />
            </aside>
            <div className="min-w-0 space-y-6">
              {selected ? (
                <LiveView profile={selected} onLaunch={() => actions.launch.mutate(selected)} launching={launching} />
              ) : (
                <Skeleton className="aspect-[16/10] w-full rounded-xl" />
              )}
              <div className="grid gap-6 2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <ImportSessionsCard profiles={profiles} targetId={selected?.id ?? null} onTargetChange={select} />
                <ProfileUseCard />
              </div>
            </div>
          </div>
        )}
      </PageBody>
      <CreateProfileDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={(p) => select(p.id)} />
    </div>
  );
}
