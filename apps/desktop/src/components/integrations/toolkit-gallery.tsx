import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { CircleCheck, LayoutGrid, Plus, Search, SearchX, X } from "lucide-react";
import type { ComposioToolkit } from "@godmode/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/common";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { QueryError } from "./query-error";
import { ToolkitLogo } from "./toolkit-logo";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Browse Composio toolkits: debounced search, category chips, infinite scroll. */
export function ToolkitGallery({
  connectedCount,
  onConnect,
  onToolkits,
}: {
  connectedCount: (slug: string) => number;
  onConnect: (toolkit: ComposioToolkit) => void;
  /** Reports every loaded toolkit (used to show logos/names in the connections list). */
  onToolkits?: (items: ComposioToolkit[]) => void;
}) {
  const [searchInput, setSearchInput] = useState("");
  const search = useDebounced(searchInput.trim(), 300);
  const [category, setCategory] = useState("");
  const [categoryCounts, setCategoryCounts] = useState<Map<string, number>>(new Map());

  const query = useInfiniteQuery({
    queryKey: qk.composioToolkits(search, category),
    queryFn: ({ pageParam }) => api.composio.toolkits({ search: search || undefined, category: category || undefined, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 5 * 60_000,
  });

  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: ComposioToolkit[] = [];
    for (const page of query.data?.pages ?? []) for (const t of page.items) if (!seen.has(t.slug)) (seen.add(t.slug), out.push(t));
    return out;
  }, [query.data]);

  // Accumulate categories across loads so chips don't vanish while a filter is active.
  useEffect(() => {
    if (!items.length) return;
    onToolkits?.(items);
    if (category) return;
    const counts = new Map<string, number>();
    for (const t of items) for (const c of t.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
    setCategoryCounts((prev) => {
      const next = new Map(prev);
      for (const [c, n] of counts) next.set(c, Math.max(prev.get(c) ?? 0, n));
      return next;
    });
  }, [items, category, onToolkits]);

  const chips = useMemo(
    () =>
      [...categoryCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 16)
        .map(([c]) => c),
    [categoryCounts],
  );

  // Infinite scroll sentinel
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: "400px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <section aria-label="App gallery" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[17px] font-medium tracking-[-0.02em]">
            <LayoutGrid className="size-4 text-muted-foreground" /> Add an app
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Connect an account and your agents get its actions as tools.</p>
        </div>
        <InputGroup className="h-9 w-full @xl:w-72">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput placeholder="Search apps…" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} aria-label="Search apps" />
          {searchInput && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setSearchInput("")}>
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
      </div>

      {chips.length > 0 && (
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Categories">
          {["", ...chips].map((c) => {
            const active = category === c;
            return (
              <button
                key={c || "all"}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setCategory(c)}
                className={cn(
                  "relative h-7 shrink-0 rounded-md border px-3 text-xs font-medium whitespace-nowrap capitalize transition",
                  active ? "border-transparent text-primary-foreground" : "bg-card text-muted-foreground hover:border-foreground/20 hover:text-foreground",
                )}
              >
                {active && <motion.span layoutId="toolkit-cat" className="absolute -inset-px rounded-md bg-primary" transition={{ type: "spring", stiffness: 400, damping: 32 }} />}
                <span className="relative">{c || "All"}</span>
              </button>
            );
          })}
        </div>
      )}

      {query.isError ? (
        <QueryError error={query.error} onRetry={() => query.refetch()} title="Couldn't load Composio apps" />
      ) : query.isLoading ? (
        <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
          {Array.from({ length: 9 }).map((_, i) => (
            <Skeleton key={i} className="h-[132px] rounded-xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<SearchX />}
          title={search ? `No apps match “${search}”` : "No apps in this category"}
          description="Try another search or category."
          action={
            <Button variant="outline" onClick={() => (setSearchInput(""), setCategory(""))}>
              Reset filters
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
            {items.map((t, i) => (
              <ToolkitCard key={t.slug} toolkit={t} index={i} connected={connectedCount(t.slug)} onConnect={() => onConnect(t)} />
            ))}
          </div>
          <div ref={sentinel} className="flex justify-center pt-2">
            {hasNextPage ? (
              <Button variant="outline" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
                {isFetchingNextPage ? <Spinner /> : null} {isFetchingNextPage ? "Loading more…" : "Load more apps"}
              </Button>
            ) : (
              items.length > 12 && <p className="text-xs text-muted-foreground">That's everything — {items.length} apps.</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function ToolkitCard({ toolkit: t, index, connected, onConnect }: { toolkit: ComposioToolkit; index: number; connected: number; onConnect: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index % 24, 12) * 0.03 }}
      className="group flex flex-col rounded-xl border bg-card p-4 shadow-card transition hover:border-foreground/15 hover:shadow-float"
    >
      <div className="flex items-start gap-3">
        <ToolkitLogo src={t.logo} name={t.name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-medium tracking-[-0.01em]">{t.name}</h3>
            {connected > 0 && (
              <Badge variant="outline" className="h-5 shrink-0 gap-1 border-brand/25 bg-brand-soft px-1.5 text-[10px] text-brand-strong">
                <CircleCheck /> {connected > 1 ? `${connected} accounts` : "Connected"}
              </Badge>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{t.description || "No description."}</p>
        </div>
      </div>
      <div className="mt-auto flex items-center justify-between gap-2 pt-3">
        <div className="flex min-w-0 gap-1 overflow-hidden">
          {t.noAuth && (
            <Badge variant="outline" className="h-5 shrink-0 text-[10px] font-normal">
              No sign-in
            </Badge>
          )}
          {t.categories.slice(0, t.noAuth ? 1 : 2).map((c) => (
            <Badge key={c} variant="secondary" className="h-5 max-w-28 truncate text-[10px] font-normal capitalize">
              {c}
            </Badge>
          ))}
        </div>
        <Button size="sm" variant={connected ? "outline" : "secondary"} className="shrink-0" onClick={onConnect} aria-label={`Connect ${t.name}`}>
          <Plus /> {connected ? "Add account" : "Connect"}
        </Button>
      </div>
    </motion.div>
  );
}
