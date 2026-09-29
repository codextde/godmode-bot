import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppWindow, Globe, Layers, Monitor, MonitorUp, RefreshCw } from "lucide-react";
import type { ComputerTarget } from "@godmode/shared";
import { computerTargetLabel, computerView, sameComputerTarget } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, PageBody, PageHeader } from "@/components/common";
import { ComputerLiveView } from "@/components/computer/computer-live-view";
import { ComputerSetupNotice, useComputerStatus } from "@/components/computer/computer-setup";
import { appInitials, displayTarget, tabTarget, viewsOf, windowTarget } from "@/components/computer/computer-utils";
import { Favicon } from "@/components/vault/favicon";
import { domainFromUrl } from "@/components/vault/vault-utils";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

function Item({ active, onClick, icon, title, subtitle }: { active: boolean; onClick: () => void; icon: React.ReactNode; title: string; subtitle?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active || undefined}
      className={cn(
        "flex w-full min-w-0 items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        active ? "border-foreground/20 bg-card shadow-card" : "border-transparent hover:bg-card/70",
      )}
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-md border bg-paper-2 text-[10px] font-semibold text-muted-foreground [&_svg]:size-3.5">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] leading-5 font-medium">{title}</span>
        {subtitle && <span className="block truncate text-[11px] leading-4 text-muted-foreground">{subtitle}</span>}
      </span>
    </button>
  );
}

/** Watch and take over this computer's displays, app windows and Godmode browser tabs. */
export default function ComputerPage() {
  const status = useComputerStatus();
  const enabled = status.data?.enabled !== false;
  const sources = useQuery({ queryKey: qk.computerSources, queryFn: api.computer.sources, enabled, refetchInterval: 10_000, retry: false });
  const [picked, setPicked] = useState<ComputerTarget | null>(null);
  const data = sources.data;

  const target: ComputerTarget | null = useMemo(() => {
    if (picked) return picked;
    if (!data) return null;
    return data.displays.length ? { kind: "desktop" } : data.windows[0] ? windowTarget(data.windows[0]) : null;
  }, [picked, data]);
  const views = target ? viewsOf(target, data?.displays) : [];
  const windows = (data?.windows ?? []).filter((w) => w.onScreen);

  return (
    <div className="relative">
      <PageHeader
        icon={<MonitorUp />}
        title="Computer"
        description="What agents can see and control when you share it in a chat. Watch any display, window or browser tab here and take over when needed."
        actions={
          <Button variant="outline" onClick={() => sources.refetch()} disabled={!enabled}>
            <RefreshCw className={cn(sources.isFetching && "animate-spin")} /> Refresh
          </Button>
        }
      />
      <PageBody className="space-y-5">
        <ComputerSetupNotice status={status.data} />
        {!enabled ? null : sources.isError ? (
          <EmptyState
            icon={<MonitorUp />}
            title="Couldn't list displays and windows"
            description={errorMessage(sources.error)}
            action={
              <Button variant="outline" onClick={() => sources.refetch()}>
                <RefreshCw /> Try again
              </Button>
            }
          />
        ) : (
          <div className="grid gap-6 xl:grid-cols-[300px_minmax(0,1fr)]">
            <aside className="space-y-5">
              {sources.isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 6 }, (_, i) => (
                    <Skeleton key={i} className="h-11 rounded-lg" />
                  ))}
                </div>
              ) : data ? (
                <>
                  {data.displays.length > 0 && (
                    <section className="space-y-1">
                      <h2 className="eyebrow px-1 pb-1">Screens</h2>
                      {data.displays.length > 1 && (
                        <Item
                          active={sameComputerTarget(target, { kind: "desktop" })}
                          onClick={() => setPicked({ kind: "desktop" })}
                          icon={<Layers />}
                          title="Entire desktop"
                          subtitle={`${data.displays.length} displays`}
                        />
                      )}
                      {data.displays.map((d) => {
                        const t: ComputerTarget = data.displays.length > 1 ? displayTarget(d) : { kind: "desktop" };
                        return (
                          <Item
                            key={d.id}
                            active={sameComputerTarget(target, t)}
                            onClick={() => setPicked(t)}
                            icon={<Monitor />}
                            title={d.name}
                            subtitle={`${Math.round(d.width)} × ${Math.round(d.height)}${d.primary ? " · primary" : ""}`}
                          />
                        );
                      })}
                    </section>
                  )}
                  <section className="space-y-1">
                    <h2 className="eyebrow px-1 pb-1">Windows</h2>
                    {windows.length ? (
                      windows.map((w) => {
                        const t = windowTarget(w);
                        return (
                          <Item key={`${w.pid}:${w.id}`} active={sameComputerTarget(target, t)} onClick={() => setPicked(t)} icon={appInitials(w.app)} title={w.app} subtitle={w.title || undefined} />
                        );
                      })
                    ) : (
                      <p className="px-1 text-xs text-muted-foreground">No windows on screen.</p>
                    )}
                  </section>
                  {data.tabs.length > 0 && (
                    <section className="space-y-1">
                      <h2 className="eyebrow px-1 pb-1">Godmode browser tabs</h2>
                      {data.tabs.map((tab) => {
                        const t = tabTarget(tab);
                        const domain = domainFromUrl(tab.url);
                        return (
                          <Item
                            key={`${tab.profileId}:${tab.targetId}`}
                            active={sameComputerTarget(target, t)}
                            onClick={() => setPicked(t)}
                            icon={domain ? <Favicon domain={domain} name={tab.title || domain} size="sm" className="size-3.5 rounded-[3px]" /> : <Globe />}
                            title={tab.title || domain || "New tab"}
                            subtitle={domain || tab.url}
                          />
                        );
                      })}
                    </section>
                  )}
                  {data.problems.map((p) => (
                    <p key={p} className="px-1 text-xs text-muted-foreground">
                      {p}
                    </p>
                  ))}
                </>
              ) : null}
            </aside>
            <div className="min-w-0">
              {target && views.length ? (
                <ComputerLiveView key={computerView(target)} target={target} views={views} />
              ) : sources.isLoading ? (
                <Skeleton className="aspect-[16/10] w-full rounded-xl" />
              ) : (
                <EmptyState icon={<AppWindow />} title="Nothing to show" description="Open an app window or connect a display, then refresh." />
              )}
              {target && (
                <p className="mt-3 text-xs text-muted-foreground">
                  To let an agent work here, open a chat and use <span className="font-medium text-foreground">Share</span> in the message box — then pick{" "}
                  {computerTargetLabel(target)}.
                </p>
              )}
            </div>
          </div>
        )}
      </PageBody>
    </div>
  );
}
