import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ComposioToolkit } from "@godmode/shared";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { ComposioConnectDialog } from "./composio-connect-dialog";
import { ComposioConnections } from "./composio-connections";
import { ComposioExplainer } from "./composio-explainer";
import { ComposioKeyCard } from "./composio-key-card";
import { QueryError } from "./query-error";
import { ToolkitGallery } from "./toolkit-gallery";

export function useComposioStatus() {
  return useQuery({ queryKey: qk.composioStatus, queryFn: api.composio.status, staleTime: 60_000 });
}

export function useComposioConnections(enabled = true) {
  return useQuery({ queryKey: qk.composioConnections, queryFn: api.composio.connections, enabled });
}

/** Composio: API key, connected accounts and the app gallery. */
export function ComposioTab() {
  const status = useComposioStatus();
  const ready = !!status.data?.configured && status.data.valid !== false;
  const connections = useComposioConnections(ready);
  const [connecting, setConnecting] = useState<ComposioToolkit | null>(null);
  const [toolkits, setToolkits] = useState<Record<string, ComposioToolkit>>({});

  const onToolkits = useCallback((items: ComposioToolkit[]) => {
    setToolkits((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const t of items)
        if (!next[t.slug]) {
          next[t.slug] = t;
          changed = true;
        }
      return changed ? next : prev;
    });
  }, []);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of connections.data ?? []) if (c.status.toUpperCase() === "ACTIVE") m.set(c.toolkit, (m.get(c.toolkit) ?? 0) + 1);
    return m;
  }, [connections.data]);
  const connectedCount = useCallback((slug: string) => counts.get(slug) ?? 0, [counts]);

  if (status.isError) return <QueryError error={status.error} onRetry={() => status.refetch()} title="Couldn't reach Composio settings" />;

  return (
    <div className="space-y-8">
      <ComposioKeyCard status={status.data} loading={status.isLoading} />
      {status.isLoading ? null : !ready ? (
        <ComposioExplainer />
      ) : (
        <>
          {connections.isLoading ? (
            <Skeleton className="h-28 rounded-2xl" />
          ) : connections.isError ? (
            <QueryError error={connections.error} onRetry={() => connections.refetch()} title="Couldn't load connected accounts" />
          ) : (
            (connections.data?.length ?? 0) > 0 && <ComposioConnections connections={connections.data!} toolkits={toolkits} />
          )}
          <ToolkitGallery connectedCount={connectedCount} onConnect={setConnecting} onToolkits={onToolkits} />
        </>
      )}
      <ComposioConnectDialog toolkit={connecting} onOpenChange={(o) => !o && setConnecting(null)} />
    </div>
  );
}
