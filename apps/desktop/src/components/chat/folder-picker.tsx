import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerDownLeft,
  Eye,
  EyeOff,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderSearch,
  History,
  Home,
  Loader2,
  TriangleAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { FolderListing } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { useBootstrap } from "@/lib/hooks";
import { isTauri, storageKey } from "@/lib/core";
import { isMac, modKey } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Kbd } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { copyText } from "./copy-button";

const LAST_FOLDER_KEY = storageKey("gm:last-folder");

export function folderName(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).at(-1) ?? path;
}

export function shortPath(path: string, home?: string): string {
  if (!home) return path;
  if (path === home) return "~";
  return path.startsWith(home) && /[\\/]/.test(path[home.length] ?? "") ? `~${path.slice(home.length)}` : path;
}

/** `shortPath` with the core's home directory. */
export function useShortPath(): (path: string) => string {
  const { data: boot } = useBootstrap();
  return (path) => shortPath(path, boot?.homeDir);
}

const looksLikePath = (q: string) => /^(\/|~|[a-zA-Z]:[\\/])/.test(q.trim());

function lastFolder(): string | undefined {
  try {
    return localStorage.getItem(LAST_FOLDER_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function rememberFolder(path: string) {
  try {
    localStorage.setItem(LAST_FOLDER_KEY, path);
  } catch {
    /* ignore */
  }
}

interface Crumb {
  name: string;
  path: string;
  home?: boolean;
}

function crumbsOf({ path, home }: FolderListing): Crumb[] {
  const win = /^[a-zA-Z]:/.test(path);
  const sep = win ? "\\" : "/";
  let base: Crumb;
  let rest: string;
  if (path === home || path.startsWith(home + sep)) {
    base = { name: "Home", path: home, home: true };
    rest = path.slice(home.length);
  } else if (win) {
    base = { name: path.slice(0, 2), path: path.slice(0, 3) };
    rest = path.slice(3);
  } else {
    base = { name: "/", path: "/" };
    rest = path;
  }
  const out = [base];
  let acc = base.path;
  for (const part of rest.split(/[\\/]+/).filter(Boolean)) {
    acc = acc.endsWith(sep) ? acc + part : acc + sep + part;
    out.push({ name: part, path: acc });
  }
  return out;
}

export function FolderPickerDialog({
  open,
  onOpenChange,
  value,
  onPick,
  title = "Work in a folder",
  description = "The agent runs inside this folder and can read and edit its files. Its memory stays in its own repository.",
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string | null;
  onPick: (path: string) => void;
  title?: string;
  description?: string;
  onCloseAutoFocus?: (e: Event) => void;
}) {
  const qc = useQueryClient();
  const [path, setPath] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState(false);
  const [browsed, setBrowsed] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const crumbsRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setPath(value ?? lastFolder());
    setQuery("");
    setBrowsed(false);
    // Only when the dialog opens: later changes of `value` must not reset the browsing position.
  }, [open]);

  const listing = useQuery({
    queryKey: qk.folderList(path ?? "", hidden),
    queryFn: () => api.folders.list(path, hidden),
    enabled: open,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const recent = useQuery({ queryKey: qk.recentFolders, queryFn: api.folders.recent, enabled: open, staleTime: 30_000 });

  // A remembered folder may be gone: start at home instead of an error.
  useEffect(() => {
    if (listing.isError && !browsed && path !== undefined) setPath(undefined);
  }, [listing.isError, browsed, path]);

  const current = listing.isError ? undefined : listing.data;
  const crumbs = current ? crumbsOf(current) : [];

  useLayoutEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [current?.path]);

  const go = async (target: string) => {
    setPending(target);
    try {
      const data = await qc.fetchQuery({
        queryKey: qk.folderList(target, hidden),
        queryFn: () => api.folders.list(target, hidden),
        staleTime: 10_000,
      });
      qc.setQueryData(qk.folderList(data.path, hidden), data);
      setPath(data.path);
      setQuery("");
      setBrowsed(true);
    } catch (err) {
      toast.error("Can't open this folder", { description: errorMessage(err) });
    } finally {
      setPending(null);
    }
  };

  const pick = (p: string) => {
    rememberFolder(p);
    onPick(p);
    onOpenChange(false);
  };

  const browseNative = async () => {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const picked = await openDialog({ directory: true, defaultPath: current?.path });
      if (typeof picked === "string") pick(picked);
    } catch (err) {
      toast.error("Couldn't open the folder dialog", { description: errorMessage(err) });
    }
  };

  const pathQuery = looksLikePath(query);

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Backspace" && !query && !e.repeat && current?.parent) {
      e.preventDefault();
      void go(current.parent);
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !pathQuery && current && !current.blocked) {
      e.preventDefault();
      e.stopPropagation();
      pick(current.path);
    }
  };

  const recents = (recent.data ?? []).filter((p) => p !== current?.path).slice(0, 4);
  const entries = current?.entries ?? [];
  const currentName = current ? (crumbs.at(-1)?.home ? "Home" : folderName(current.path) || current.path) : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="grid-cols-[minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-xl"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader className="px-5 pt-5 pb-4 text-left">
          <DialogTitle className="flex items-center gap-2">
            <FolderOpen className="size-[18px] text-muted-foreground" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1 border-y bg-muted/30 px-2 py-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Up one level"
                disabled={!current?.parent}
                onClick={() => current?.parent && void go(current.parent)}
                className="shrink-0 text-muted-foreground"
              >
                <ArrowUp />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Up one level <Kbd>⌫</Kbd>
            </TooltipContent>
          </Tooltip>
          <nav ref={crumbsRef} aria-label="Current folder" className="flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none]">
            {current ? (
              crumbs.map((c, i) => (
                <Fragment key={c.path}>
                  {i > 0 && <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" />}
                  <button
                    type="button"
                    onClick={() => void go(c.path)}
                    aria-current={i === crumbs.length - 1 ? "location" : undefined}
                    className={cn(
                      "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[13px] text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                      i === crumbs.length - 1 && "font-medium text-foreground",
                    )}
                  >
                    {c.home && <Home className="size-3.5" />}
                    {c.name}
                  </button>
                </Fragment>
              ))
            ) : (
              <Skeleton className="h-5 w-48" />
            )}
          </nav>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Show hidden folders"
                aria-pressed={hidden}
                onClick={() => setHidden((h) => !h)}
                className={cn("shrink-0 text-muted-foreground", hidden && "bg-accent text-foreground")}
              >
                {hidden ? <Eye /> : <EyeOff />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{hidden ? "Hide hidden folders" : "Show hidden folders"}</TooltipContent>
          </Tooltip>
        </div>

        <Command shouldFilter={!pathQuery} loop className="rounded-none bg-transparent">
          <div className="relative">
            <CommandInput
              ref={inputRef}
              value={query}
              onValueChange={setQuery}
              onKeyDown={onInputKeyDown}
              placeholder="Filter, or paste a path…"
              aria-label="Filter folders or enter a path"
            />
            {!query && (
              <div className="pointer-events-none absolute inset-y-0 right-3 hidden items-center gap-1.5 text-[11px] text-muted-foreground md:flex">
                <Kbd>↵</Kbd> open <span className="opacity-40">·</span> <Kbd>⌫</Kbd> up
              </div>
            )}
          </div>
          <div className="flex h-[min(21rem,48vh)] flex-col">
            <CommandList className="max-h-none min-h-0 flex-1 px-1.5 py-1">
              {pathQuery ? (
                <CommandGroup>
                  <CommandItem value="__go" onSelect={() => void go(query.trim())} className="gap-2.5 py-2">
                    {pending ? <Loader2 className="animate-spin" /> : <CornerDownLeft />}
                    Open <span className="min-w-0 truncate font-mono text-[13px]">{query.trim()}</span>
                  </CommandItem>
                </CommandGroup>
              ) : (
                <>
                  {!browsed && recents.length > 0 && (
                    <CommandGroup heading="Recent">
                      {recents.map((p) => (
                        <CommandItem key={p} value={`recent ${p}`} onSelect={() => pick(p)} className="group gap-2.5 py-2">
                          <History />
                          <span className="shrink-0 font-medium">{folderName(p)}</span>
                          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{shortPath(p, current?.home)}</span>
                          <span className="text-[11px] text-muted-foreground opacity-0 transition group-data-[selected=true]:opacity-100">Use ↵</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                  {!current && listing.isError && (
                    <div className="flex flex-col items-center gap-3 px-6 py-10 text-center text-sm text-muted-foreground">
                      <p>{errorMessage(listing.error)}</p>
                      {path !== undefined && (
                        <Button type="button" variant="outline" size="sm" onClick={() => setPath(undefined)}>
                          <Home /> Go to your home folder
                        </Button>
                      )}
                    </div>
                  )}
                  <CommandGroup heading={current ? `Folders${entries.length ? ` · ${entries.length}${current.truncated ? "+" : ""}` : ""}` : undefined}>
                    {!current && !listing.isError
                      ? Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="mx-2 my-2.5 h-4" style={{ width: `${40 + ((i * 17) % 45)}%` }} />)
                      : entries.map((e) => (
                          <CommandItem key={e.path} value={e.name} onSelect={() => void go(e.path)} className="group gap-2.5 py-2">
                            {e.git ? <FolderGit2 /> : <Folder />}
                            <span className="min-w-0 flex-1 truncate">{e.name}</span>
                            {pending === e.path ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : e.blocked ? null : (
                              <button
                                type="button"
                                tabIndex={-1}
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  pick(e.path);
                                }}
                                className="rounded-md border bg-card px-2 py-0.5 text-[11px] font-medium text-muted-foreground opacity-0 shadow-xs transition group-hover:opacity-100 group-data-[selected=true]:opacity-100 hover:text-foreground"
                              >
                                Use
                              </button>
                            )}
                            <ChevronRight className="size-3.5 text-muted-foreground/60" />
                          </CommandItem>
                        ))}
                  </CommandGroup>
                  {current && (
                    <CommandEmpty className="px-6 py-10 text-center text-sm text-muted-foreground">
                      {query ? `No folders match “${query}”.` : "No subfolders here. Use this folder, or go up a level."}
                    </CommandEmpty>
                  )}
                </>
              )}
            </CommandList>
            {current?.blocked && (
              <p className="flex gap-1.5 border-t border-warning/30 bg-warning/[0.07] px-4 py-2 text-xs text-warning">
                <TriangleAlert className="mt-px size-3.5 shrink-0" />
                {current.blocked}
              </p>
            )}
          </div>
        </Command>

        <div className="flex items-center gap-2 border-t bg-muted/30 px-4 py-3">
          {isTauri && (
            <Button type="button" variant="ghost" size="sm" onClick={() => void browseNative()} className="-ml-1 text-muted-foreground">
              {isMac ? "Open Finder…" : "Browse…"}
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} className="ml-auto">
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!current || !!current.blocked}
            onClick={() => current && pick(current.path)}
            className="min-w-0 shrink"
          >
            <span className="max-w-[17rem] truncate">Use “{currentName}”</span>
            <kbd className="hidden font-sans text-[10px] opacity-60 md:inline">{modKey}↵</kbd>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Composer control for the folder a chat works in: an icon button when there is none, a pill with a menu otherwise.
 * `chatFolder` overrides the agent's default `agentFolder`; clearing it falls back to the agent's.
 */
export function FolderChip({
  chatFolder,
  agentFolder,
  agentName,
  onChange,
  busy,
}: {
  chatFolder: string | null;
  agentFolder: string | null;
  agentName?: string;
  onChange: (path: string | null) => void;
  busy?: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const short = useShortPath();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pickAfterMenu = useRef(false);
  const folder = chatFolder ?? agentFolder;
  const dialog = (
    <FolderPickerDialog
      open={picking}
      onOpenChange={setPicking}
      value={folder}
      onPick={onChange}
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        triggerRef.current?.focus();
      }}
    />
  );

  if (!folder) {
    return (
      <>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              ref={triggerRef}
              type="button"
              variant="ghost"
              onClick={() => setPicking(true)}
              aria-label="Work in a folder"
              className="h-8 gap-1.5 rounded-lg px-2 text-[13px] font-normal text-muted-foreground hover:text-foreground has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-4"
            >
              {busy ? <Loader2 className="animate-spin" /> : <FolderOpen />}
              <span className="@max-sm/composer:sr-only">Folder</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Work in a folder</TooltipContent>
        </Tooltip>
        {dialog}
      </>
    );
  }

  const inherited = !chatFolder;
  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                ref={triggerRef}
                type="button"
                aria-label={`Folder: ${folderName(folder)}`}
                className="flex h-8 max-w-[14rem] min-w-0 items-center gap-1.5 rounded-lg border bg-card pr-1.5 pl-2 text-[13px] transition hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {busy ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />}
                <span className="truncate font-medium">{folderName(folder)}</span>
                <ChevronDown className="size-3.5 shrink-0 opacity-60" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent className="font-mono">{short(folder)}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="start"
          className="w-72"
          // Open the picker once the menu has fully closed: otherwise both fight over focus.
          onCloseAutoFocus={(e) => {
            if (!pickAfterMenu.current) return;
            pickAfterMenu.current = false;
            e.preventDefault();
            setPicking(true);
          }}
        >
          <DropdownMenuLabel className="space-y-1 font-normal">
            <span className="block text-xs text-muted-foreground">
              {inherited ? `Default folder of ${agentName ?? "this agent"}` : "This chat works in"}
            </span>
            <span className="block font-mono text-xs break-all">{short(folder)}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => (pickAfterMenu.current = true)}>
            <FolderSearch /> Change folder…
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void copyText(folder).then((ok) => ok && toast.success("Path copied"))}>
            <Copy /> Copy path
          </DropdownMenuItem>
          {!inherited && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onChange(null)}>
                <X /> {agentFolder ? `Use ${agentName ?? "the agent"}'s folder` : "Remove folder"}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </>
  );
}
