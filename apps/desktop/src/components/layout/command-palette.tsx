import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Archive,
  Bot,
  Box,
  Globe,
  Inbox,
  KeyRound,
  Layers,
  Lock,
  MessageCircle,
  MessageSquarePlus,
  MonitorUp,
  Moon,
  Plug,
  Plus,
  ScrollText,
  Settings,
  ShieldCheck,
  Sun,
  SquareKanban,
  Workflow,
} from "lucide-react";
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
import { useAllAgents, useConversations } from "@/lib/hooks";
import { useUi } from "@/stores/ui";
import { useTheme } from "@/components/theme-provider";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { modKey } from "@/lib/desktop";
import { colorGradient } from "@/components/common";
import { cn } from "@/lib/utils";

export function CommandPalette() {
  const open = useUi((s) => s.commandOpen);
  const setOpen = useUi((s) => s.setCommandOpen);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { resolved, setTheme } = useTheme();
  const { data: agents = [] } = useAllAgents();
  const { data: conversations = [] } = useConversations();

  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Command palette" description="Search agents, chats and actions">
      <CommandInput placeholder="Type a command or search…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => go("/")}>
            <MessageSquarePlus /> New chat <CommandShortcut>{modKey}N</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => go("/agents/new")}>
            <Plus /> Create agent
          </CommandItem>
          <CommandItem onSelect={() => go("/vault/logins?new=1")}>
            <KeyRound /> Add login
          </CommandItem>
          <CommandItem onSelect={() => go("/vault/2fa?import=1")}>
            <ShieldCheck /> Import 2FA QR code
          </CommandItem>
          <CommandItem
            onSelect={async () => {
              setOpen(false);
              await api.vault.lock();
              qc.invalidateQueries({ queryKey: qk.bootstrap });
            }}
          >
            <Lock /> Lock vault
          </CommandItem>
          <CommandItem
            onSelect={() => {
              setTheme(resolved === "dark" ? "light" : "dark");
              setOpen(false);
            }}
          >
            {resolved === "dark" ? <Sun /> : <Moon />} Toggle theme
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Navigate">
          <CommandItem value="tasks board kanban tickets issues" onSelect={() => go("/tasks")}>
            <SquareKanban /> Tasks
          </CommandItem>
          <CommandItem onSelect={() => go("/agents")}>
            <Bot /> Agents
          </CommandItem>
          <CommandItem value="automations routines schedules triggers webhooks" onSelect={() => go("/automations")}>
            <Workflow /> Automations
          </CommandItem>
          <CommandItem onSelect={() => go("/activity")}>
            <Activity /> Activity
          </CommandItem>
          <CommandItem onSelect={() => go("/inbox")}>
            <Inbox /> Inbox
          </CommandItem>
          <CommandItem onSelect={() => go("/archived")}>
            <Archive /> Archived chats
          </CommandItem>
          <CommandItem onSelect={() => go("/vault/logins")}>
            <KeyRound /> Logins
          </CommandItem>
          <CommandItem onSelect={() => go("/vault/2fa")}>
            <ShieldCheck /> 2FA codes
          </CommandItem>
          <CommandItem onSelect={() => go("/integrations")}>
            <Plug /> Integrations
          </CommandItem>
          <CommandItem value="messaging slack telegram microsoft teams bots" onSelect={() => go("/messaging")}>
            <MessageCircle /> Messaging
          </CommandItem>
          <CommandItem onSelect={() => go("/browser")}>
            <Globe /> Browser
          </CommandItem>
          <CommandItem onSelect={() => go("/computer")}>
            <MonitorUp /> Computer
          </CommandItem>
          <CommandItem value="virtual machines vms macos tart" onSelect={() => go("/vms")}>
            <Box /> Virtual machines
          </CommandItem>
          <CommandItem onSelect={() => go("/workspaces")}>
            <Layers /> Workspaces
          </CommandItem>
          <CommandItem value="instructions rules agent context" onSelect={() => go("/settings/instructions")}>
            <ScrollText /> Instructions
          </CommandItem>
          <CommandItem onSelect={() => go("/settings/general")}>
            <Settings /> Settings <CommandShortcut>{modKey},</CommandShortcut>
          </CommandItem>
        </CommandGroup>
        {agents.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Agents">
              {agents.map((a) => (
                <CommandItem key={a.id} value={`agent ${a.name} ${a.description}`} onSelect={() => go(`/agents/${a.id}`)}>
                  <span className={cn("grid size-5 shrink-0 place-items-center rounded-[5px] text-[11px] ring-1 ring-inset", colorGradient(a.color))}>
                    {a.avatar}
                  </span>
                  {a.name}
                  <span className="ml-2 truncate text-xs text-muted-foreground">{a.description}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
        {conversations.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Chats">
              {conversations.slice(0, 50).map((c) => (
                <CommandItem key={c.id} value={`chat ${c.title} ${c.preview ?? ""}`} onSelect={() => go(`/chat/${c.id}`)}>
                  <MessageSquarePlus className="opacity-50" /> <span className="truncate">{c.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
