"use client";

import { Fragment, useEffect, useMemo, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { guardNavigation } from "@/components/unsaved-guard";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";

export interface CommandEntry {
  id: string;
  label: string;
  /** Heading the entry is listed under, e.g. "Workspace", "Admin", "Computers". */
  group: string;
  href: string;
  icon?: ReactNode;
  /** Extra words that should find this entry. */
  keywords?: string[];
  /** Muted text at the end of the row ("Online", "Shared with you"). */
  hint?: string;
  /** Load as a full page — paths the custom server answers (computers under /d/…) do this automatically. */
  document?: boolean;
}

/** Navigates to `href` (honouring unsaved-changes guards); computers under /d/… load as documents. */
export function useNavigateTo() {
  const router = useRouter();
  return (href: string, document = false) =>
    guardNavigation(() => {
      if (document || href.startsWith("/d/")) window.location.assign(href);
      else router.push(href);
    });
}

/**
 * Cmd/Ctrl+K (house rule 13): the pages the person may open, their computers, theme and sign out. The AppShell owns
 * it; `entries` come from the nav plus whatever the layout passes as `commands`.
 */
export function CommandPalette({
  open,
  onOpenChange,
  entries,
  onSignOut,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: CommandEntry[];
  onSignOut?: () => Promise<void>;
}) {
  const navigate = useNavigateTo();
  const { setTheme } = useTheme();
  const [, startSignOut] = useTransition();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const groups = useMemo(() => {
    const map = new Map<string, CommandEntry[]>();
    for (const entry of entries) {
      const list = map.get(entry.group) ?? [];
      list.push(entry);
      map.set(entry.group, list);
    }
    return [...map.entries()];
  }, [entries]);

  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Command palette" description="Go to a page or computer, or run a command">
      <CommandInput placeholder="Go to…" />
      <CommandList className="max-h-[min(24rem,60svh)]">
        <CommandEmpty>No results.</CommandEmpty>
        {groups.map(([group, list], i) => (
          <Fragment key={group}>
            {i > 0 && <CommandSeparator />}
            <CommandGroup heading={group}>
              {list.map((entry) => (
                <CommandItem
                  key={entry.id}
                  value={`${group} ${entry.label} ${entry.id}`}
                  keywords={entry.keywords}
                  onSelect={() => run(() => navigate(entry.href, entry.document))}
                >
                  {entry.icon}
                  <span className="truncate">{entry.label}</span>
                  {entry.hint && <span className="ml-auto pl-3 text-xs text-muted-foreground">{entry.hint}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </Fragment>
        ))}
        <CommandSeparator />
        <CommandGroup heading="Theme">
          <CommandItem value="theme light" keywords={["appearance", "paper"]} onSelect={() => run(() => setTheme("light"))}>
            <Sun /> Light theme
          </CommandItem>
          <CommandItem value="theme dark" keywords={["appearance", "anthracite", "night"]} onSelect={() => run(() => setTheme("dark"))}>
            <Moon /> Dark theme
          </CommandItem>
          <CommandItem value="theme system" keywords={["appearance", "auto"]} onSelect={() => run(() => setTheme("system"))}>
            <Monitor /> System theme
          </CommandItem>
        </CommandGroup>
        {onSignOut && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Account">
              <CommandItem
                value="sign out"
                keywords={["log out", "logout"]}
                onSelect={() => run(() => guardNavigation(() => startSignOut(() => onSignOut())))}
              >
                <LogOut /> Sign out
              </CommandItem>
            </CommandGroup>
          </>
        )}
      </CommandList>
      <div className="hidden items-center justify-end gap-3 border-t px-3 py-2 text-[11px] text-muted-foreground pointer-fine:flex">
        <span className="flex items-center gap-1">
          <CommandShortcut className="ml-0 tracking-normal">↑↓</CommandShortcut> to move
        </span>
        <span className="flex items-center gap-1">
          <CommandShortcut className="ml-0 tracking-normal">↵</CommandShortcut> to open
        </span>
        <span className="flex items-center gap-1">
          <CommandShortcut className="ml-0 tracking-normal">esc</CommandShortcut> to close
        </span>
      </div>
    </CommandDialog>
  );
}
