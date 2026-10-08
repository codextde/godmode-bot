import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent, BrowserProfile } from "@godmode/shared";
import { Check, ChevronDown, Globe, Loader2, Plus, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LiveDot } from "@/components/aicss/Motion";
import { agentBrowserProfile } from "@/components/chat/browser-panel";
import { api } from "@/lib/api";
import { useSettings, useWorkspaces } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { CreateProfileDialog } from "./profile-list";
import { effectiveProject, useProjectIndex } from "@/components/projects/project-utils";

function ProfileTile({ profile, quiet }: { profile: BrowserProfile | null; quiet?: boolean }) {
  return (
    <span className={cn("relative grid size-6 shrink-0 place-items-center rounded-md border text-muted-foreground", quiet ? "bg-paper-2" : "bg-card")}>
      <Globe className="size-3.5" />
      {profile?.running && <LiveDot className="absolute -right-0.5 -bottom-0.5 ring-2 ring-popover" />}
    </span>
  );
}

/**
 * Composer control for the browser profile a chat works in: a quiet button while the chat uses the default profile,
 * a pill with the profile's name otherwise (dashed when it comes from the agent or its workspace). Hidden when the
 * agent has no browser.
 */
export function BrowserProfileChip({
  agent,
  value,
  workspaceId = null,
  projectId = null,
  onChange,
  busy,
}: {
  agent: Agent | undefined;
  /** The chat's own profile; null = the agent's. */
  value: string | null;
  /** Workspace the chat is in: a global agent browses with its default. */
  workspaceId?: string | null;
  /** The chat's own project (null = the agent's): its profile comes before the workspace's. */
  projectId?: string | null;
  onChange: (profileId: string | null) => void | Promise<unknown>;
  busy?: boolean;
}) {
  const { data: settings } = useSettings();
  const enabled = !!agent?.browser.enabled && settings?.browser.enabled !== false;
  const { data: profiles = [] } = useQuery({ queryKey: qk.browserProfiles, queryFn: api.browser.profiles, enabled });
  const { data: workspaces = [] } = useWorkspaces();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const project = effectiveProject(agent, projectId, useProjectIndex())?.project ?? null;
  if (!enabled || !agent) return null;

  const scopeName = (p: BrowserProfile) => (p.workspaceId ? (workspaces.find((w) => w.id === p.workspaceId)?.name ?? "Workspace") : "Global");
  const own = value ? (profiles.find((p) => p.id === value) ?? null) : null;
  const fallback = agentBrowserProfile(agent, profiles, null, workspaceId, project);
  const fallbackFrom = !fallback
    ? "Loading profiles…"
    : agent.browser.profileId === fallback.id
      ? `Pinned in ${agent.name}'s settings`
      : project?.browserProfileId === fallback.id
        ? `Set for the ${project.name} project`
        : fallback.workspaceId
        ? `Default of the ${scopeName(fallback)} workspace`
        : "Your default profile";
  const shown = own ?? (fallback && (fallback.workspaceId || !fallback.isDefault) ? fallback : null);

  const pick = (profileId: string | null) => {
    setOpen(false);
    if (profileId !== value) void onChange(profileId);
  };
  const tooltip = own ? `This chat browses in ${own.name}` : fallback ? `Browses in ${fallback.name} — ${fallbackFrom.toLowerCase()}` : "Browser profile";
  const icon = busy ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <Globe className="size-3.5 shrink-0 text-muted-foreground" />;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              {shown ? (
                <button
                  type="button"
                  aria-label={`Browser profile: ${shown.name}${own ? "" : " (default)"}`}
                  className={cn(
                    "flex h-8 max-w-[12rem] min-w-14 shrink items-center gap-1.5 rounded-lg border pr-1.5 pl-2 text-[13px] transition focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                    own ? "bg-card hover:bg-accent" : "border-dashed text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {icon}
                  <span className={cn("truncate @max-md/composer:sr-only", own && "font-medium")}>{shown.name}</span>
                  {shown.running && <LiveDot className="shrink-0" />}
                  <ChevronDown className="size-3.5 shrink-0 opacity-60" />
                </button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  aria-label="Browser profile"
                  className={cn(
                    "h-8 gap-1.5 rounded-lg px-2 text-[13px] font-normal text-muted-foreground hover:text-foreground has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-4",
                    open && "bg-accent text-foreground",
                  )}
                >
                  {busy ? <Loader2 className="animate-spin" /> : <Globe />}
                  <span className="@max-sm/composer:sr-only">Browser</span>
                </Button>
              )}
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
        <PopoverContent align="start" side="top" sideOffset={8} className="w-80 overflow-hidden rounded-xl p-0">
          <div className="border-b px-3 pt-2.5 pb-2">
            <p className="text-[13px] font-medium">Browser profile</p>
            <p className="text-xs text-muted-foreground">Runs in this chat browse with this profile's cookies and logins.</p>
          </div>
          <Command>
            {profiles.length > 6 && <CommandInput placeholder="Find a profile…" />}
            <CommandList className="max-h-72">
              <CommandEmpty>No profile with that name.</CommandEmpty>
              <CommandGroup>
                <CommandItem value={`__default ${fallback?.name ?? ""}`} onSelect={() => pick(null)} className="gap-2.5 py-2">
                  <ProfileTile profile={fallback} quiet />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{fallback && fallback.name.toLowerCase() !== "default" ? `Default — ${fallback.name}` : "Default"}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{fallbackFrom}</span>
                  </span>
                  {!value && <Check className="size-4" aria-label="Selected" />}
                </CommandItem>
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Browse in">
                {profiles.map((p) => (
                  <CommandItem key={p.id} value={`${p.name} ${p.id}`} onSelect={() => pick(p.id)} className="gap-2.5 py-2">
                    <ProfileTile profile={p} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{p.name}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {[p.running ? "Running" : null, scopeName(p), p.cookieCount ? `${p.cookieCount.toLocaleString()} cookies` : "No sessions yet"]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    {own?.id === p.id && <Check className="size-4" aria-label="Selected" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
          <div className="flex items-center gap-1 border-t p-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="flex-1 justify-start font-normal text-muted-foreground"
              onClick={() => {
                setOpen(false);
                setCreating(true);
              }}
            >
              <Plus /> New profile
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="font-normal text-muted-foreground"
              onClick={() => {
                setOpen(false);
                navigate(own ? `/browser?profile=${own.id}` : "/browser");
              }}
            >
              <Settings2 /> Manage
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <CreateProfileDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(p) => {
          qc.setQueryData<BrowserProfile[]>(qk.browserProfiles, (old) => (old && !old.some((x) => x.id === p.id) ? [...old, p] : old));
          void onChange(p.id);
        }}
      />
    </>
  );
}
