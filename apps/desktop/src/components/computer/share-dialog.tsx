import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppWindow, Globe, Layers, Monitor, MonitorUp, RefreshCw, Search, TriangleAlert } from "lucide-react";
import type { ComputerDisplay, ComputerSources, ComputerTab, ComputerTarget, ComputerWindow } from "@godmode/shared";
import { computerView, sameComputerTarget } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Favicon } from "@/components/vault/favicon";
import { domainFromUrl } from "@/components/vault/vault-utils";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { ComputerSetupNotice, useComputerStatus } from "./computer-setup";
import { appInitials, displayTarget, tabTarget, windowTarget } from "./computer-utils";

type Kind = "window" | "screen" | "tab";

/** Load a thumbnail once the card scrolls into view. */
function useVisible<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: "120px" });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);
  return [ref, visible];
}

function Thumbnail({ view, aspect, fallback }: { view: string; aspect: number; fallback: React.ReactNode }) {
  const [ref, visible] = useVisible<HTMLDivElement>();
  const { data, isError, isLoading } = useQuery({
    queryKey: qk.computerThumbnail(view, 360),
    queryFn: () => api.computer.thumbnail(view, 360),
    enabled: visible,
    staleTime: 8_000,
    refetchInterval: 8_000,
    retry: false,
  });
  return (
    <div ref={ref} className="relative w-full overflow-hidden rounded-md border bg-paper-2" style={{ aspectRatio: String(Math.min(Math.max(aspect, 0.6), 2.4)) }}>
      {data ? (
        <img src={`data:${data.mime};base64,${data.data}`} alt="" draggable={false} className="absolute inset-0 size-full object-contain select-none" />
      ) : isError || !visible ? (
        <div className="absolute inset-0 grid place-items-center text-muted-foreground">{fallback}</div>
      ) : isLoading ? (
        <Skeleton className="absolute inset-0 rounded-none" />
      ) : null}
    </div>
  );
}

function SourceCard({
  selected,
  onSelect,
  onConfirm,
  thumbnail,
  title,
  subtitle,
  icon,
  badge,
  muted,
}: {
  selected: boolean;
  onSelect: () => void;
  onConfirm: () => void;
  thumbnail: React.ReactNode;
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  badge?: string;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      onDoubleClick={onConfirm}
      aria-pressed={selected}
      className={cn(
        "group flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-2 text-left transition outline-none hover:border-foreground/25 focus-visible:ring-[3px] focus-visible:ring-ring/50",
        selected && "border-brand ring-2 ring-brand/35 hover:border-brand",
        muted && "opacity-70",
      )}
    >
      {thumbnail}
      <span className="flex min-w-0 items-center gap-2 px-0.5">
        <span className="grid size-5 shrink-0 place-items-center rounded-[5px] border bg-paper-2 text-[9px] font-semibold text-muted-foreground [&_svg]:size-3">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-5 font-medium">{title}</span>
          {subtitle && <span className="block truncate text-[11px] leading-4 text-muted-foreground">{subtitle}</span>}
        </span>
        {badge && <span className="shrink-0 rounded-[4px] border px-1 py-px text-[10px] text-muted-foreground">{badge}</span>}
      </span>
    </button>
  );
}

function WindowsGrid({
  windows,
  selected,
  onSelect,
  onConfirm,
  query,
  showHidden,
}: {
  windows: ComputerWindow[];
  selected: ComputerTarget | null;
  onSelect: (t: ComputerTarget) => void;
  onConfirm: (t: ComputerTarget) => void;
  query: string;
  showHidden: boolean;
}) {
  const q = query.trim().toLowerCase();
  const list = windows
    .filter((w) => showHidden || w.onScreen)
    .filter((w) => !q || w.app.toLowerCase().includes(q) || w.title.toLowerCase().includes(q))
    .sort((a, b) => Number(b.onScreen) - Number(a.onScreen) || a.app.localeCompare(b.app));
  if (!list.length) {
    return <p className="py-12 text-center text-sm text-muted-foreground">{q ? `No window matches "${query}".` : "No windows are open."}</p>;
  }
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
      {list.map((w) => {
        const t = windowTarget(w);
        return (
          <SourceCard
            key={`${w.pid}:${w.id}`}
            selected={sameComputerTarget(selected, t)}
            onSelect={() => onSelect(t)}
            onConfirm={() => onConfirm(t)}
            thumbnail={<Thumbnail view={computerView(t)} aspect={w.width / Math.max(1, w.height)} fallback={<AppWindow className="size-6" />} />}
            icon={appInitials(w.app)}
            title={w.app}
            subtitle={w.title || undefined}
            badge={!w.onScreen ? "Hidden" : undefined}
            muted={!w.onScreen}
          />
        );
      })}
    </div>
  );
}

function ScreensGrid({
  displays,
  selected,
  onSelect,
  onConfirm,
}: {
  displays: ComputerDisplay[];
  selected: ComputerTarget | null;
  onSelect: (t: ComputerTarget) => void;
  onConfirm: (t: ComputerTarget) => void;
}) {
  if (!displays.length) return <p className="py-12 text-center text-sm text-muted-foreground">No displays found.</p>;
  const sorted = [...displays].sort((a, b) => Number(b.primary) - Number(a.primary));
  const desktop: ComputerTarget = { kind: "desktop" };
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
      {displays.length > 1 && (
        <SourceCard
          selected={sameComputerTarget(selected, desktop)}
          onSelect={() => onSelect(desktop)}
          onConfirm={() => onConfirm(desktop)}
          thumbnail={
            <div className="grid aspect-[16/10] w-full grid-cols-2 gap-1 overflow-hidden rounded-md border bg-paper-2 p-1">
              {sorted.slice(0, 4).map((d) => (
                <Thumbnail key={d.id} view={`display:${d.id}`} aspect={d.width / d.height} fallback={<Monitor className="size-4" />} />
              ))}
            </div>
          }
          icon={<Layers />}
          title="Entire desktop"
          subtitle={`All ${displays.length} displays`}
        />
      )}
      {sorted.map((d) => {
        const t = displayTarget(d);
        return (
          <SourceCard
            key={d.id}
            selected={sameComputerTarget(selected, t)}
            onSelect={() => onSelect(displays.length > 1 ? t : desktop)}
            onConfirm={() => onConfirm(displays.length > 1 ? t : desktop)}
            thumbnail={<Thumbnail view={`display:${d.id}`} aspect={d.width / d.height} fallback={<Monitor className="size-6" />} />}
            icon={<Monitor />}
            title={d.name}
            subtitle={`${Math.round(d.width)} × ${Math.round(d.height)}${d.primary ? " · primary" : ""}`}
          />
        );
      })}
    </div>
  );
}

function TabsList_({
  tabs,
  selected,
  onSelect,
  onConfirm,
  query,
}: {
  tabs: ComputerTab[];
  selected: ComputerTarget | null;
  onSelect: (t: ComputerTarget) => void;
  onConfirm: (t: ComputerTarget) => void;
  query: string;
}) {
  const q = query.trim().toLowerCase();
  const list = tabs.filter((t) => !q || t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q));
  if (!tabs.length) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        No Godmode browser is open. Open one on the Browser page — or share a window of your own browser instead.
      </p>
    );
  }
  if (!list.length) return <p className="py-12 text-center text-sm text-muted-foreground">No tab matches "{query}".</p>;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
      {list.map((tab) => {
        const t = tabTarget(tab);
        const domain = domainFromUrl(tab.url);
        return (
          <SourceCard
            key={`${tab.profileId}:${tab.targetId}`}
            selected={sameComputerTarget(selected, t)}
            onSelect={() => onSelect(t)}
            onConfirm={() => onConfirm(t)}
            thumbnail={<Thumbnail view={computerView(t)} aspect={16 / 10} fallback={<Globe className="size-6" />} />}
            icon={domain ? <Favicon domain={domain} name={tab.title || domain} size="sm" className="size-3.5 rounded-[3px]" /> : <Globe />}
            title={tab.title || domain || "New tab"}
            subtitle={`${tab.profileName} · ${domain || tab.url}`}
          />
        );
      })}
    </div>
  );
}

/**
 * Pick what an agent may see and control — like sharing your screen in a video call or with ChatGPT: a single
 * window (controlled in the background), a display or the entire desktop, or a Godmode browser tab.
 */
export function ComputerShareDialog({
  open,
  onOpenChange,
  current,
  agentName,
  onShare,
  sharing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: ComputerTarget | null;
  agentName?: string;
  onShare: (target: ComputerTarget) => void | Promise<unknown>;
  sharing?: boolean;
}) {
  const status = useComputerStatus(open);
  const sources = useQuery<ComputerSources>({
    queryKey: qk.computerSources,
    queryFn: api.computer.sources,
    enabled: open && status.data?.enabled !== false,
    // Windows come and go while the picker is open (even when this window isn't focused).
    refetchInterval: open ? 4_000 : false,
    refetchIntervalInBackground: true,
    refetchOnMount: "always",
    retry: false,
  });
  const [kind, setKind] = useState<Kind>("window");
  const [selected, setSelected] = useState<ComputerTarget | null>(current);
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelected(current);
    setQuery("");
    setKind(current?.kind === "tab" ? "tab" : current?.kind === "desktop" || current?.kind === "display" ? "screen" : "window");
  }, [open, current]);

  const data = sources.data;
  const hiddenCount = useMemo(() => data?.windows.filter((w) => !w.onScreen).length ?? 0, [data]);
  const confirm = (t: ComputerTarget | null) => {
    if (t) void onShare(t);
  };

  const body = sources.isLoading ? (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="aspect-[16/12] rounded-lg" />
      ))}
    </div>
  ) : sources.isError ? (
    <div className="flex flex-col items-center gap-3 py-12 text-center text-sm text-muted-foreground">
      <TriangleAlert className="size-5" />
      {errorMessage(sources.error)}
      <Button variant="outline" size="sm" onClick={() => sources.refetch()}>
        <RefreshCw /> Try again
      </Button>
    </div>
  ) : data ? (
    <>
      <TabsContent value="window" className="mt-0">
        <WindowsGrid windows={data.windows} selected={selected} onSelect={setSelected} onConfirm={confirm} query={query} showHidden={showHidden} />
      </TabsContent>
      <TabsContent value="screen" className="mt-0">
        <ScreensGrid displays={data.displays} selected={selected} onSelect={setSelected} onConfirm={confirm} />
      </TabsContent>
      <TabsContent value="tab" className="mt-0">
        <TabsList_ tabs={data.tabs} selected={selected} onSelect={setSelected} onConfirm={confirm} query={query} />
      </TabsContent>
    </>
  ) : null;

  const note =
    selected?.kind === "window" || (kind === "window" && !selected)
      ? "The agent controls only this window, in the background — your mouse and keyboard stay yours."
      : selected?.kind === "tab" || (kind === "tab" && !selected)
        ? "The agent controls only this tab of Godmode's browser, in the background."
        : "The agent uses your real mouse and keyboard on the shared screen. You can stop it any time.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(88vh,760px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-6 pt-5 pb-4">
          <DialogTitle className="flex items-center gap-2">
            <MonitorUp className="size-4" /> Share with {agentName ?? "the agent"}
          </DialogTitle>
          <DialogDescription>Choose what the agent may see and control in this chat. Stop sharing whenever you like.</DialogDescription>
        </DialogHeader>
        <Tabs value={kind} onValueChange={(v) => setKind(v as Kind)} className="flex min-h-0 flex-1 flex-col gap-0">
          <div className="flex flex-wrap items-center gap-3 border-b px-6 py-3">
            <TabsList>
              <TabsTrigger value="window">
                <AppWindow /> Window
              </TabsTrigger>
              <TabsTrigger value="screen">
                <Monitor /> Entire screen
              </TabsTrigger>
              <TabsTrigger value="tab">
                <Globe /> Browser tab
              </TabsTrigger>
            </TabsList>
            {kind !== "screen" && (
              <div className="relative ml-auto w-full max-w-60 min-w-40 flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={kind === "tab" ? "Search tabs" : "Search windows"} className="h-8 pl-8 text-[13px]" />
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-4">
            <ComputerSetupNotice status={status.data} showCua={kind === "window"} />
            {data?.problems.map((p) => (
              <p key={p} className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-xs text-muted-foreground">
                <TriangleAlert className="mt-px size-3.5 shrink-0 text-amber-600" /> {p}
              </p>
            ))}
            {status.data?.enabled !== false && body}
          </div>
        </Tabs>
        <DialogFooter className="items-center gap-3 border-t bg-paper-2 px-6 py-3 sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            {kind === "window" && hiddenCount > 0 && (
              <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                <Switch size="sm" checked={showHidden} onCheckedChange={setShowHidden} /> Hidden windows ({hiddenCount})
              </label>
            )}
            <p className="hidden min-w-0 text-xs text-muted-foreground md:block">{note}</p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={() => confirm(selected)} disabled={!selected || sharing || sameComputerTarget(selected, current)}>
              {sharing ? <Spinner /> : <MonitorUp />} Share
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
