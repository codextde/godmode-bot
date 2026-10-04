import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Archive,
  ArrowLeft,
  Bot,
  Box,
  Cloud,
  CreditCard,
  Globe,
  Inbox,
  KeyRound,
  Layers,
  Lock,
  MessageCircle,
  MessageSquarePlus,
  MonitorSmartphone,
  MonitorUp,
  Moon,
  Plug,
  Plus,
  Puzzle,
  ScrollText,
  Server,
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
import { cloudContext } from "@/lib/core";
import { modKey } from "@/lib/desktop";
import { AgentAvatar } from "@/components/common";

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
          {cloudContext && (
            <CommandItem value="all computers godmode cloud devices" onSelect={() => window.location.assign(cloudContext!.home)}>
              <ArrowLeft /> All computers
            </CommandItem>
          )}
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
          <CommandItem value="mods claude code plugins hooks guardrails" onSelect={() => go("/mods")}>
            <Puzzle /> Mods
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
          <CommandItem value="archived tasks board tickets" onSelect={() => go("/tasks?view=archived")}>
            <Archive /> Archived tasks
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
          <CommandItem value="ssh servers remote linux" onSelect={() => go("/ssh")}>
            <Server /> SSH servers
          </CommandItem>
          <CommandItem value="runners remote computer mac mini" onSelect={() => go("/runners")}>
            <MonitorSmartphone /> Runners
          </CommandItem>
          <CommandItem onSelect={() => go("/workspaces")}>
            <Layers /> Workspaces
          </CommandItem>
          <CommandItem value="instructions rules agent context" onSelect={() => go("/settings/instructions")}>
            <ScrollText /> Instructions
          </CommandItem>
          <CommandItem value="godmode cloud link browser remote access" onSelect={() => go("/settings/cloud")}>
            <Cloud /> Godmode Cloud
          </CommandItem>
          <CommandItem value="billing plan subscription invoices usage cost tokens" onSelect={() => go("/settings/billing")}>
            <CreditCard /> Billing and usage
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
                  <AgentAvatar agent={a} size="sm" still className="size-5" />
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
