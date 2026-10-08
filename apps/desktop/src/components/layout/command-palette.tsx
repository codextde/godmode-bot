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
  Keyboard,
  KeyRound,
  KeySquare,
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
  SquareTerminal,
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
import { useAllAgents, useConversations, useWorkspaces } from "@/lib/hooks";
import { WorkspaceTile } from "@/components/workspaces/workspace-tile";
import { useStartAgentChat } from "@/components/agents/agent-actions";
import { ATTENTION_ICON } from "@/components/attention/attention-list";
import { useUi } from "@/stores/ui";
import { useTheme } from "@/components/theme-provider";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cloudContext } from "@/lib/core";
import { modKey } from "@/lib/desktop";
import { AgentAvatar } from "@/components/common";

/** Settings sections by what people look for there (Cloud, License and Billing are under Navigate). */
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

/** Matches ignore case and accents: "cafe" finds "Café", "istanbul" finds "İstanbul". */
const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
/** Scripts written without spaces between words: there a word may start anywhere. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;
/** Keeps two items with the same text apart (two automations may share a name); never searched. */
const ID_MARK = "\u2063";
const unique = (text: string, id: string) => `${text}${ID_MARK}${id}`;

/** Every word typed starts a word somewhere — no stray letters: "invoice" doesn't find "Voice", "sign in" not "redesign". */
function wordFilter(value: string, search: string, keywords?: string[]): number {
  const words = fold(search).split(/\s+/).filter(Boolean);
  const text = fold(`${value.split(ID_MARK)[0]} ${keywords?.join(" ") ?? ""}`);
  return words.every((w) => (UNSPACED.test(w) ? text.includes(w) : new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u").test(text))) ? 1 : 0;
}

export function CommandPalette() {
  const open = useUi((s) => s.commandOpen);
  const setOpen = useUi((s) => s.setCommandOpen);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { resolved, setTheme } = useTheme();
  const { data: agents = [] } = useAllAgents();
  const { data: conversations = [] } = useConversations();
  const { data: workspaces = [] } = useWorkspaces();
  const scope = useUi((s) => s.workspace);
  const setScope = useUi((s) => s.setWorkspace);
  const projectScope = useUi((s) => s.project);
  const startChat = useStartAgentChat();
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const searching = query.length > 0;
  // What the core finds in chats (message text too), a moment after typing stops.
  const [deferred, setDeferred] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDeferred(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (!open) setQ("");
  }, [open]);
  const { data: found, isPlaceholderData: foundBefore } = useQuery({
    queryKey: qk.conversations("all", deferred),
    queryFn: () => api.conversations.list({ search: deferred, limit: 20 }),
    enabled: open && deferred.length >= 3,
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
    ? number
      ? tasks.filter((t) => String(t.number).startsWith(number)).sort((a, b) => a.number - b.number).slice(0, 8)
      : tasks.filter((t) => wordFilter(`${t.title} ${t.description ?? ""}`, q) > 0).slice(0, 8)
    : [];
  const routineHits = searching ? routines.filter((r) => wordFilter(`${r.name} ${r.prompt}`, q) > 0).slice(0, 6) : [];
  // Chats whose title or preview match here, then what the core found in their messages (for this very search).
  const chats = searching ? conversations.filter((c) => wordFilter(`${c.title} ${c.preview ?? ""}`, q) > 0) : conversations.slice(0, 50);
  const fresh = searching && deferred === q.trim() && !foundBefore ? (found ?? []) : [];
  const inMessages = fresh.filter((c) => !chats.some((l) => l.id === c.id));

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
                  <CommandItem key={item.id} value={unique(`waiting ${item.title} ${item.detail}`, item.id)} onSelect={() => go(item.link)}>
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
        {searching && workspaces.length > 0 && (
          <CommandGroup heading="Switch workspace">
            {workspaces.map((w) => (
              <CommandItem
                key={w.id}
                value={unique(`workspace switch ${w.name}`, w.id)}
                onSelect={() => {
                  setScope(w.id);
                  setOpen(false);
                }}
              >
                <WorkspaceTile icon={w.icon} color={w.color} size="sm" className="size-5 rounded-[5px] text-[11px]" />
                <span className="truncate">{w.name}</span>
                {scope === w.id && !projectScope && <span className="ml-2 text-xs text-muted-foreground">current</span>}
              </CommandItem>
            ))}
            {workspaces.flatMap((w) =>
              (w.projects ?? []).map((p) => (
                <CommandItem
                  key={p.id}
                  value={unique(`project switch ${p.name} ${w.name}`, p.id)}
                  onSelect={() => {
                    setScope(w.id, p.id);
                    setOpen(false);
                  }}
                >
                  <WorkspaceTile icon={p.icon} color={p.color} size="sm" className="size-5 rounded-[5px] text-[11px]" />
                  <span className="truncate">{p.name}</span>
                  <span className="truncate text-xs text-muted-foreground">in {w.name}</span>
                  {projectScope === p.id && <span className="ml-2 text-xs text-muted-foreground">current</span>}
                </CommandItem>
              )),
            )}
            {scope !== "all" && (
              <CommandItem value="workspace switch all workspaces everything" onSelect={() => { setScope("all"); setOpen(false); }}>
                <Layers /> All workspaces <CommandShortcut>{modKey}0</CommandShortcut>
              </CommandItem>
            )}
          </CommandGroup>
        )}
        {ticketHits.length > 0 && (
          <CommandGroup heading="Tickets">
            {ticketHits.map((t) => (
              // Keyed by the search: cmdk reads `keywords` only when an item mounts, and these were matched here already.
              <CommandItem key={`${t.id}:${q}`} value={unique(`ticket #${t.number} ${t.title}`, t.id)} keywords={[q]} onSelect={() => go(`/tasks?task=${t.id}`)}>
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
              <CommandItem key={`${r.id}:${q}`} value={unique(`automation ${r.name}`, r.id)} keywords={[q]} onSelect={() => go(`/automations?edit=${r.id}`)}>
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
            value="keyboard shortcuts keys hotkeys"
            onSelect={() => {
              setOpen(false);
              useUi.getState().setShortcutsOpen(true);
            }}
          >
            <Keyboard /> Keyboard shortcuts <CommandShortcut>?</CommandShortcut>
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
                value={unique(`new chat with ${a.name} talk to ${a.role ?? ""}`, a.id)}
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
          <CommandItem value="claude code mcp server cli connect terminal cursor api key" onSelect={() => go("/settings/connect")}>
            <SquareTerminal /> Claude Code & MCP
          </CommandItem>
          <CommandItem value="godmode cloud link browser remote access" onSelect={() => go("/settings/cloud")}>
            <Cloud /> Godmode Cloud
          </CommandItem>
          <CommandItem value="license licence key activate trial subscription pro plan" onSelect={() => go("/settings/license")}>
            <KeySquare /> License
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
                <CommandItem key={a.id} value={unique(`agent ${a.name} ${a.description}`, a.id)} onSelect={() => go(`/agents/${a.id}`)}>
                  <AgentAvatar agent={a} size="sm" still className="size-5" />
                  {a.name}
                  <span className="ml-2 truncate text-xs text-muted-foreground">{a.description}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
        {chats.length + inMessages.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Chats">
              {chats.map((c) => (
                <CommandItem key={c.id} value={unique(`chat ${c.title} ${c.preview ?? ""}`, c.id)} onSelect={() => go(`/chat/${c.id}`)}>
                  <MessageCircle className="opacity-50" /> <span className="truncate">{c.title}</span>
                  {c.preview && <span className="ml-2 min-w-0 flex-1 truncate text-xs text-muted-foreground">{c.preview}</span>}
                </CommandItem>
              ))}
              {inMessages.map((c) => (
                // Found by the core in its messages: kept whatever the title says (keyed by the search, see Tickets).
                <CommandItem key={`${c.id}:${q}`} value={unique(`chat ${c.title}`, c.id)} keywords={[q]} onSelect={() => go(`/chat/${c.id}`)}>
                  <MessageCircle className="opacity-50" /> <span className="truncate">{c.title}</span>
                  <span className="ml-2 min-w-0 flex-1 truncate text-xs text-muted-foreground">mentioned in a message</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
