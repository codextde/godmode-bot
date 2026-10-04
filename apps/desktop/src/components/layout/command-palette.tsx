import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Archive,
  AudioLines,
  ArrowLeft,
  Bot,
  Box,
  BrainCircuit,
  Cloud,
  CreditCard,
  DatabaseBackup,
  Globe,
  HeartPulse,
  Inbox,
  Info,
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
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Sun,
  SquareKanban,
  Workflow,
  type LucideIcon,
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
import { useStartAgentChat } from "@/components/agents/agent-actions";
import { ATTENTION_ICON } from "@/components/attention/attention-list";
import { useUi } from "@/stores/ui";
import { useTheme } from "@/components/theme-provider";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cloudContext } from "@/lib/core";
import { modKey } from "@/lib/desktop";
import { AgentAvatar } from "@/components/common";

/** Settings sections by what people look for there (Cloud and Billing are under Navigate). */
const SETTINGS: { id: string; label: string; icon: LucideIcon; words: string }[] = [
  { id: "general", label: "General", icon: SlidersHorizontal, words: "name startup tray notifications desktop" },
  { id: "ai", label: "AI & Claude", icon: Sparkles, words: "model effort ultracode monthly budget team cost limit" },
  { id: "browser", label: "Browser", icon: Globe, words: "chromium profiles cookies" },
  { id: "computer", label: "Computer", icon: MonitorUp, words: "screen share control mac" },
  { id: "vms", label: "Virtual machines", icon: Box, words: "vm tart macos linux" },
  { id: "voice", label: "Voice", icon: AudioLines, words: "speech dictation read aloud microphone" },
  { id: "memory", label: "Memory", icon: BrainCircuit, words: "dreaming remember learn" },
  { id: "security", label: "Security", icon: ShieldCheck, words: "vault passphrase auto-lock password" },
  { id: "backup", label: "Backup", icon: DatabaseBackup, words: "restore export import" },
  { id: "phone", label: "Phone", icon: Smartphone, words: "mobile iphone android pair app" },
  { id: "system", label: "System", icon: HeartPulse, words: "health permissions claude code install sign in login doctor updates tools" },
  { id: "logs", label: "Logs", icon: Activity, words: "diagnostics debug" },
  { id: "about", label: "About", icon: Info, words: "version updates" },
];

/** Every word typed starts a word somewhere — no stray letters: "invoice" doesn't find "Voice", "sign in" not "redesign". */
function wordFilter(value: string, search: string, keywords?: string[]): number {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${value} ${keywords?.join(" ") ?? ""}`.toLowerCase();
  return words.every((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u").test(text)) ? 1 : 0;
}

export function CommandPalette() {
  const open = useUi((s) => s.commandOpen);
  const setOpen = useUi((s) => s.setCommandOpen);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { resolved, setTheme } = useTheme();
  const { data: agents = [] } = useAllAgents();
  const { data: conversations = [] } = useConversations();
  const startChat = useStartAgentChat();
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const searching = query.length > 0;
  // What the core finds in chats (message text too), a moment after typing stops.
  const [deferred, setDeferred] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDeferred(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (!open) setQ("");
  }, [open]);
  const { data: found } = useQuery({
    queryKey: qk.conversations("all", deferred),
    queryFn: () => api.conversations.list({ search: deferred, limit: 20 }),
    enabled: open && deferred.length >= 2,
    placeholderData: keepPreviousData,
  });
  const { data: waiting = [] } = useQuery({ queryKey: qk.attention, queryFn: api.attention, enabled: open, staleTime: 2_000 });
  const { data: tasks = [] } = useQuery({ queryKey: qk.taskList("all"), queryFn: () => api.tasks.list({ workspaceId: "all" }), enabled: open && searching });
  const { data: routines = [] } = useQuery({ queryKey: qk.routineList("all"), queryFn: () => api.routines.list({}), enabled: open && searching });

  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };

  // Tickets by number ("#12", "12") or title; automations by name or what they do. Capped: the list stays short.
  const number = /^#?(\d+)$/.exec(query)?.[1];
  const ticketHits = searching
    ? tasks.filter((t) => (number ? String(t.number).startsWith(number) : wordFilter(`${t.title} ${t.description ?? ""}`, q) > 0)).slice(0, 8)
    : [];
  const routineHits = searching ? routines.filter((r) => wordFilter(`${r.name} ${r.prompt}`, q) > 0).slice(0, 6) : [];
  const chats = searching && deferred.length >= 2 && found ? found : conversations.slice(0, 50);

  return (
    <CommandDialog open={open} onOpenChange={setOpen} filter={wordFilter} title="Search" description="Find what waits for you, chats, tickets, automations, agents, settings and actions">
      <CommandInput placeholder="Search chats, tickets, automations, settings… or type a command" value={q} onValueChange={setQ} />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        {waiting.length > 0 && (
          <>
            <CommandGroup heading="Waiting for you">
              {(searching ? waiting : waiting.slice(0, 5)).map((item) => {
                const Icon = ATTENTION_ICON[item.kind];
                return (
                  <CommandItem key={item.id} value={`waiting ${item.title} ${item.detail}`} onSelect={() => go(item.link)}>
                    <Icon className="text-warning" />
                    <span className="truncate">{item.title}</span>
                    {item.detail && <span className="ml-2 min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.detail}</span>}
                    <CommandShortcut>{item.action}</CommandShortcut>
                  </CommandItem>
                );
              })}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}
        {ticketHits.length > 0 && (
          <CommandGroup heading="Tickets">
            {ticketHits.map((t) => (
              <CommandItem key={t.id} value={`ticket #${t.number} ${t.title}`} keywords={[q]} onSelect={() => go(`/tasks?task=${t.id}`)}>
                <SquareKanban className="opacity-60" />
                <span className="shrink-0 font-mono text-xs text-muted-foreground">#{t.number}</span>
                <span className="truncate">{t.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {routineHits.length > 0 && (
          <CommandGroup heading="Automations">
            {routineHits.map((r) => (
              <CommandItem key={r.id} value={`automation ${r.name}`} keywords={[q]} onSelect={() => go(`/automations?edit=${r.id}`)}>
                <Workflow className="opacity-60" />
                <span className="truncate">{r.name}</span>
                {!r.enabled && <span className="ml-2 text-xs text-muted-foreground">off</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
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
          {searching &&
            agents.map((a) => (
              <CommandItem
                key={`chat-${a.id}`}
                value={`new chat with ${a.name} talk to ${a.role ?? ""}`}
                onSelect={() => {
                  setOpen(false);
                  startChat.mutate(a);
                }}
              >
                <MessageSquarePlus /> New chat with {a.name}
              </CommandItem>
            ))}
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
        {searching && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Settings">
              {SETTINGS.map(({ id, label, icon: Icon, words }) => (
                <CommandItem key={id} value={`settings ${label} ${words}`} onSelect={() => go(`/settings/${id}`)}>
                  <Icon /> {label}
                  <span className="ml-2 text-xs text-muted-foreground">Settings</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
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
        {chats.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Chats">
              {chats.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`chat ${c.title} ${c.preview ?? ""}`}
                  // The core found it, maybe in a message: keep it whatever the title says.
                  keywords={chats === found ? [q] : undefined}
                  onSelect={() => go(`/chat/${c.id}`)}
                >
                  <MessageCircle className="opacity-50" /> <span className="truncate">{c.title}</span>
                  {c.preview && <span className="ml-2 min-w-0 flex-1 truncate text-xs text-muted-foreground">{c.preview}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
