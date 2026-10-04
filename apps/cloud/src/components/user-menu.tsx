"use client";

import { useTransition, type ReactNode } from "react";
import Link from "next/link";
import { ChevronsUpDown, LogOut, Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type Theme } from "@/components/theme-provider";
import { guardNavigation } from "@/components/unsaved-guard";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export interface ShellUser {
  name: string | null;
  email: string;
  roleName: string;
}

export interface UserMenuLink {
  href: string;
  label: string;
  icon?: ReactNode;
}

/** "Ada Lovelace" → "AL", "ada@example.com" → "A". */
export function initials(user: Pick<ShellUser, "name" | "email">): string {
  const source = user.name?.trim() || user.email.split("@")[0] || "?";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : source.slice(0, user.name ? 2 : 1);
  return letters.toUpperCase();
}

export function UserAvatar({ user, className }: { user: Pick<ShellUser, "name" | "email">; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-full border bg-card text-[11px] font-medium tracking-[0.02em] text-foreground shadow-card",
        className,
      )}
    >
      {initials(user)}
    </span>
  );
}

const THEMES: { value: Theme; label: string; icon: ReactNode }[] = [
  { value: "light", label: "Light", icon: <Sun /> },
  { value: "dark", label: "Dark", icon: <Moon /> },
  { value: "system", label: "System", icon: <Monitor /> },
];

/**
 * The signed-in person: name, e-mail and role, links to their own pages, the theme, and sign out.
 * `variant="sidebar"` is the full-width row in the sidebar footer; `variant="avatar"` the round button in the phone
 * top bar. `onSignOut` is a server action (it revokes the session and redirects).
 */
export function UserMenu({
  user,
  onSignOut,
  links = [],
  variant = "sidebar",
  className,
}: {
  user: ShellUser;
  onSignOut: () => Promise<void>;
  links?: UserMenuLink[];
  variant?: "sidebar" | "avatar";
  className?: string;
}) {
  const { theme, setTheme } = useTheme();
  const [signingOut, startSignOut] = useTransition();
  const display = user.name?.trim() || user.email;

  const trigger =
    variant === "avatar" ? (
      <button
        type="button"
        aria-label={`Account menu for ${display}`}
        className={cn(
          "grid size-9 place-items-center rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:size-11",
          className,
        )}
      >
        <UserAvatar user={user} />
      </button>
    ) : (
      <button
        type="button"
        aria-label={`Account menu for ${display}`}
        className={cn(
          "flex h-11 w-full min-w-0 items-center gap-2.5 rounded-lg px-1.5 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[state=open]:bg-sidebar-accent",
          "group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0 pointer-coarse:group-data-[collapsible=icon]:size-11",
          className,
        )}
      >
        <UserAvatar user={user} className="group-data-[collapsible=icon]:size-7" />
        <span className="min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:hidden">
          <span className="block truncate text-[13px] font-medium text-foreground">{display}</span>
          <span className="block truncate text-[11.5px] text-muted-foreground">{user.name ? user.email : user.roleName}</span>
        </span>
        <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden" />
      </button>
    );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align={variant === "avatar" ? "end" : "start"}
        side={variant === "avatar" ? "bottom" : "top"}
        sideOffset={8}
        className="w-64"
      >
        <DropdownMenuLabel className="flex items-center gap-2.5 py-2 font-normal">
          <UserAvatar user={user} />
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-[13px] font-medium">{display}</span>
            <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
            <span className="mt-1 inline-block rounded-[5px] border px-1.5 py-px text-[11px] text-muted-foreground">{user.roleName}</span>
          </span>
        </DropdownMenuLabel>
        {links.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {links.map((link) => (
                <DropdownMenuItem key={link.href} asChild>
                  <Link href={link.href}>
                    {link.icon}
                    {link.label}
                  </Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="eyebrow py-1 text-[10.5px]">Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
          {THEMES.map((t) => (
            <DropdownMenuRadioItem key={t.value} value={t.value} onSelect={(e) => e.preventDefault()}>
              {t.icon}
              {t.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={signingOut}
          onSelect={(e) => {
            e.preventDefault();
            guardNavigation(() => startSignOut(() => onSignOut()));
          }}
        >
          {signingOut ? <Spinner aria-hidden aria-label={undefined} role={undefined} /> : <LogOut />}
          {signingOut ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
