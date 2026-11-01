import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AppWindow,
  Archive,
  AudioLines,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRightFromLine,
  Bot,
  Box,
  BrainCircuit,
  Cloud,
  CreditCard,
  FileText,
  FolderOpen,
  DatabaseBackup,
  Fingerprint,
  Gauge,
  Ghost,
  Globe,
  HeartPulse,
  Inbox,
  Info,
  Keyboard,
  KeyRound,
  KeySquare,
  Laptop,
  Layers,
  Lock,
  MessageCircle,
  MessageSquarePlus,
  MonitorUp,
  Moon,
  Palette,
  Phone,
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
import { useAllAgents, useBootstrap, useConversations, useWorkspaces } from "@/lib/hooks";
import { WorkspaceTile } from "@/components/workspaces/workspace-tile";
import { useStartAgentChat } from "@/components/agents/agent-actions";
import { ATTENTION_ICON } from "@/components/attention/attention-list";
import { useUi } from "@/stores/ui";
import { useTheme } from "@/components/theme-provider";
import { THEME_SHORTCUT } from "@/components/layout/theme-toggle";
import { PALETTES, searchSegments } from "@godmode/shared";
import { paletteLabel } from "@/lib/palettes";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cloudContext } from "@/lib/core";
import { modKey } from "@/lib/desktop";
import { AgentAvatar } from "@/components/common";
import { useHandoff } from "@/components/devices/device-parts";
import { EASY_PAGES, MODE_LABEL, useInterfaceMode, useSetInterfaceMode } from "@/lib/mode";

/** Settings sections by what people look for there (Cloud, License and Billing are under Navigate). */
const SETTINGS = [
  { id: "general", label: "general", icon: SlidersHorizontal, words: "name startup tray notifications desktop easy professional mode interface simple summaries titles haiku ai" },
  { id: "ai", label: "ai", icon: Sparkles, words: "model effort ultracode limit" },
  { id: "browser", label: "browser", icon: Globe, words: "chromium profiles cookies" },
  { id: "computer", label: "computer", icon: MonitorUp, words: "screen share control mac" },
  { id: "voice", label: "voice", icon: AudioLines, words: "speech dictation read aloud microphone" },
  { id: "memory", label: "memory", icon: BrainCircuit, words: "dreaming remember learn" },
  { id: "artifacts", label: "artifacts", icon: AppWindow, words: "dashboards apps trackers tools build feature turn on off" },
  { id: "integrations", label: "integrations", icon: Plug, words: "connected apps composio api tools mcp servers gmail slack notion feature turn on off" },
  { id: "messaging", label: "messaging", icon: MessageCircle, words: "chat apps slack telegram microsoft teams bots feature turn on off" },
  { id: "android", label: "android", icon: Smartphone, words: "adb usb debugging emulator device feature turn on off" },
  { id: "activity", label: "activity", icon: Activity, words: "history runs log feature turn on off" },
  { id: "plugins", label: "plugins", icon: Puzzle, words: "claude code mods skills hooks guardrails github install add-ons feature turn on off" },
  { id: "calls", label: "calls", icon: Phone, words: "elevenlabs twilio number call voice agent inbound feature turn on off" },
  { id: "cards", label: "cards", icon: CreditCard, words: "payment credit cards purchases pay feature turn on off" },
  { id: "vms", label: "vms", icon: Box, words: "vm tart macos linux feature turn on off" },
  { id: "ssh", label: "ssh", icon: Server, words: "remote linux servers feature turn on off" },
  { id: "api-keys", label: "apiKeys", icon: KeyRound, words: "anthropic openai elevenlabs z.ai glm captcha browser-use secrets" },
  { id: "security", label: "security", icon: ShieldCheck, words: "vault passphrase auto-lock password" },
  { id: "files", label: "files", icon: FolderOpen, words: "workspace notes memory cleanup tidy delete bin agents" },
  { id: "backup", label: "backup", icon: DatabaseBackup, words: "restore export import" },
  { id: "phone", label: "phone", icon: Smartphone, words: "mobile iphone android pair app" },
  { id: "devices", label: "devices", icon: Laptop, words: "device group computers macs sync primary secondary hand off handoff lid invite join" },
  { id: "system", label: "system", icon: HeartPulse, words: "health permissions claude code install sign in login doctor updates tools" },
  { id: "logs", label: "logs", icon: Activity, words: "diagnostics debug" },
  { id: "about", label: "about", icon: Info, words: "version updates" },
] as const satisfies readonly { id: string; label: string; icon: LucideIcon; words: string }[];

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
  const { t } = useTranslation(["layout", "common"]);
  const open = useUi((s) => s.commandOpen);
  const setOpen = useUi((s) => s.setCommandOpen);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { resolved, palette, setPalette, toggle: toggleTheme } = useTheme();
  const mode = useInterfaceMode();
  const { setMode } = useSetInterfaceMode();
  // In Easy mode pages go by their plain names; both names always find them.
  const named = (path: string, pro: string) => (mode === "easy" ? (EASY_PAGES[path]?.title ?? pro) : pro);
  const alias = (path: string, pro: string) => (mode === "easy" && EASY_PAGES[path]?.title ? [pro, EASY_PAGES[path]!.title!] : undefined);
  const { data: agents = [] } = useAllAgents();
  const on = useBootstrap().data?.settings;
  const { data: conversations = [] } = useConversations();
  const { data: workspaces = [] } = useWorkspaces();
  const scope = useUi((s) => s.workspace);
  const setScope = useUi((s) => s.setWorkspace);
  const projectScope = useUi((s) => s.project);
  const startChat = useStartAgentChat();
  const devices = useHandoff();
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const searching = query.length > 0;
  const [deferred, setDeferred] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDeferred(q.trim()), 60);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (!open) setQ("");
  }, [open]);
  const { data: found, isPlaceholderData: foundBefore } = useQuery({
    queryKey: qk.search(deferred),
    queryFn: () => api.search(deferred, { limit: 20 }),
    enabled: open && deferred.length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
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
  const fresh = searching && deferred === q.trim() && !foundBefore ? (found ?? null) : null;
  const ticketHits = searching
    ? number
      ? tasks.filter((t) => String(t.number).startsWith(number)).sort((a, b) => a.number - b.number).slice(0, 8).map((t) => ({ id: t.id, number: t.number, title: t.title, snippet: null as string | null }))
      : fresh
        ? fresh.tasks
        : tasks.filter((t) => wordFilter(t.title, q) > 0).slice(0, 8).map((t) => ({ id: t.id, number: t.number, title: t.title, snippet: null as string | null }))
    : [];
  const routineHits = searching ? routines.filter((r) => wordFilter(`${r.name} ${r.prompt}`, q) > 0).slice(0, 6) : [];
  const chatHits = !searching
    ? conversations.slice(0, 50).map((c) => ({ id: c.id, title: c.title, snippet: c.preview ? c.preview : null, messageId: null as string | null, marked: false }))
    : fresh
      ? fresh.chats.map((c) => ({ id: c.id, title: c.title, snippet: c.snippet, messageId: c.titleMatch && !c.snippet ? null : c.messageId, marked: true }))
      : conversations.filter((c) => wordFilter(c.title, q) > 0).map((c) => ({ id: c.id, title: c.title, snippet: null as string | null, messageId: null as string | null, marked: false }));
  const noteHits = fresh?.notes ?? [];
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? "";

  return (
    <CommandDialog open={open} onOpenChange={setOpen} filter={wordFilter} title={t("common:actions.search")} description={t("palette.description")}>
      <CommandInput placeholder={t("palette.placeholder")} value={q} onValueChange={setQ} />
      {fresh?.corrected && <div className="px-3 pt-2 text-xs text-muted-foreground">{t("palette.showingFor", { query: fresh.corrected })}</div>}
      <CommandList>
        <CommandEmpty>{t("palette.empty")}</CommandEmpty>
        {waiting.length > 0 && (
          <>
            <CommandGroup heading={t("palette.groups.waiting")}>
              {(searching ? waiting : waiting.slice(0, 5)).map((item) => {
                const Icon = ATTENTION_ICON[item.kind];
                return (
                  <CommandItem key={item.id} value={unique(`waiting ${t("palette.groups.waiting")} ${item.title} ${item.detail}`, item.id)} onSelect={() => go(item.link)}>
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
          <CommandGroup heading={t("palette.groups.switchWorkspace")}>
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
                {scope === w.id && !projectScope && <span className="ml-2 text-xs text-muted-foreground">{t("palette.current")}</span>}
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
                  <span className="truncate text-xs text-muted-foreground">{t("palette.inWorkspace", { name: w.name })}</span>
                  {projectScope === p.id && <span className="ml-2 text-xs text-muted-foreground">{t("palette.current")}</span>}
                </CommandItem>
              )),
            )}
            {scope !== "all" && (
              <CommandItem value={`workspace switch all workspaces everything ${t("scope.all")}`} onSelect={() => { setScope("all"); setOpen(false); }}>
                <Layers /> {t("scope.all")} <CommandShortcut>{modKey}0</CommandShortcut>
              </CommandItem>
            )}
          </CommandGroup>
        )}
        {ticketHits.length > 0 && (
          <CommandGroup heading={t("palette.groups.tickets")}>
            {ticketHits.map((t) => (
              // Keyed by the search: cmdk reads `keywords` only when an item mounts, and these were matched here already.
              <CommandItem key={`${t.id}:${q}`} value={unique(`ticket #${t.number} ${t.title}`, t.id)} keywords={[q]} onSelect={() => go(`/tasks?task=${t.id}`)}>
                <SquareKanban className="opacity-60" />
                <span className="shrink-0 font-mono text-xs text-muted-foreground">#{t.number}</span>
                <span className="truncate">{t.title}</span>
                {t.snippet && <Marked text={t.snippet} className="ml-2 min-w-0 flex-1 truncate text-xs text-muted-foreground" />}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {noteHits.length > 0 && (
          <CommandGroup heading={t("palette.groups.notes")}>
            {noteHits.map((n) => (
              <CommandItem
                key={`${n.agentId}:${n.path}:${q}`}
                value={unique(`note ${n.path} ${n.heading}`, `${n.agentId}:${n.path}`)}
                keywords={[q]}
                onSelect={() => go(`/files/${n.agentId}?${new URLSearchParams({ file: n.path, dir: n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : "" })}`)}
              >
                <FileText className="opacity-60" />
                <span className="shrink-0 truncate">{n.heading || n.path.split("/").pop()}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{agentName(n.agentId)}</span>
                <Marked text={n.snippet} className="ml-2 min-w-0 flex-1 truncate text-xs text-muted-foreground" />
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {routineHits.length > 0 && (
          <CommandGroup heading={t("nav.automations")}>
            {routineHits.map((r) => (
              <CommandItem key={`${r.id}:${q}`} value={unique(`automation ${r.name}`, r.id)} keywords={[q]} onSelect={() => go(`/automations?edit=${r.id}`)}>
                <Workflow className="opacity-60" />
                <span className="truncate">{r.name}</span>
                {!r.enabled && <span className="ml-2 text-xs text-muted-foreground">{t("palette.off")}</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading={t("palette.groups.actions")}>
          <CommandItem onSelect={() => go("/")}>
            <MessageSquarePlus /> {t("shell.newChat")} <CommandShortcut>{modKey}N</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => go("/?private=1")}>
            <Ghost /> {t("palette.newPrivateChat")} <CommandShortcut>⇧{modKey}N</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => go("/agents/new")}>
            <Plus /> {t("palette.createAgent")}
          </CommandItem>
          <CommandItem onSelect={() => go("/vault/logins?new=1")}>
            <KeyRound /> {t("palette.addLogin")}
          </CommandItem>
          <CommandItem onSelect={() => go("/vault/2fa?import=1")}>
            <ShieldCheck /> {t("palette.import2fa")}
          </CommandItem>
          <CommandItem value={`import memory chatgpt claude gemini bring your memory ${t("palette.importMemory")}`} onSelect={() => go("/settings/memory?import=1")}>
            <ArrowDownToLine /> {t("palette.importMemory")}
          </CommandItem>
          {on?.cards.enabled && (
            <CommandItem value={`add card payment credit card ${t("palette.addCard")}`} onSelect={() => go("/vault/cards?new=1")}>
              <CreditCard /> {t("palette.addCard")}
            </CommandItem>
          )}
          <CommandItem
            onSelect={async () => {
              setOpen(false);
              await api.vault.lock();
              qc.invalidateQueries({ queryKey: qk.bootstrap });
            }}
          >
            <Lock /> {t("footer.lockVault")}
          </CommandItem>
          <CommandItem
            value={`keyboard shortcuts keys hotkeys ${t("shortcuts.title")}`}
            onSelect={() => {
              setOpen(false);
              useUi.getState().setShortcutsOpen(true);
            }}
          >
            <Keyboard /> {t("shortcuts.title")} <CommandShortcut>?</CommandShortcut>
          </CommandItem>
          <CommandItem
            value={`switch light dark mode theme appearance night day ${t(`themeToggle.switchTo.${resolved === "dark" ? "light" : "dark"}`)}`}
            onSelect={() => {
              toggleTheme();
              setOpen(false);
            }}
          >
            {resolved === "dark" ? <Sun /> : <Moon />} {t(`themeToggle.switchTo.${resolved === "dark" ? "light" : "dark"}`)} <CommandShortcut>{THEME_SHORTCUT}</CommandShortcut>
          </CommandItem>
          {PALETTES.filter((p) => p !== palette).map((p) => (
            <CommandItem
              key={`palette-${p}`}
              value={`palette theme colors appearance ${paletteLabel(p)}`}
              onSelect={() => {
                setPalette(p);
                setOpen(false);
              }}
            >
              <Palette /> {t("palette.usePalette", { name: paletteLabel(p) })}
            </CommandItem>
          ))}
          <CommandItem
            value={`switch to ${MODE_LABEL[mode === "easy" ? "pro" : "easy"]} mode interface simple advanced beginner expert ${t(`palette.switchMode.${mode === "easy" ? "pro" : "easy"}`)}`}
            onSelect={() => {
              setMode(mode === "easy" ? "pro" : "easy");
              setOpen(false);
            }}
          >
            <Gauge /> {t(`palette.switchMode.${mode === "easy" ? "pro" : "easy"}`)}
          </CommandItem>
          {devices.targets.map((d) => (
            <CommandItem
              key={`handoff-${d.id ?? "primary"}`}
              value={unique(`hand off running work to ${d.name} handoff move chats close lid device ${t("palette.handOff", { name: d.name })}`, d.id ?? "primary")}
              disabled={devices.pending}
              onSelect={() => {
                setOpen(false);
                devices.handoff(d);
              }}
            >
              <ArrowRightFromLine /> {t("palette.handOff", { name: d.name })}
              {devices.working > 0 && <span className="ml-2 text-xs text-muted-foreground tabular-nums">{t("counts.working", { count: devices.working })}</span>}
            </CommandItem>
          ))}
          {cloudContext && (
            <CommandItem value={`all computers godmode cloud devices ${t("cloud.allComputers")}`} onSelect={() => window.location.assign(cloudContext!.home)}>
              <ArrowLeft /> {t("cloud.allComputers")}
            </CommandItem>
          )}
          {searching &&
            agents.map((a) => (
              <CommandItem
                key={`chat-${a.id}`}
                value={unique(`new chat with ${a.name} talk to ${a.role ?? ""} ${t("palette.chatWith", { name: a.name })}`, a.id)}
                onSelect={() => {
                  setOpen(false);
                  startChat.mutate(a);
                }}
              >
                <MessageSquarePlus /> {t("palette.chatWith", { name: a.name })}
              </CommandItem>
            ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t("palette.groups.navigate")}>
          <CommandItem value={`agent tasks board kanban tickets issues ${t("nav.tasks")}`} keywords={alias("/tasks", t("nav.tasks"))} onSelect={() => go("/tasks")}>
            <SquareKanban /> {named("/tasks", t("nav.tasks"))}
          </CommandItem>
          <CommandItem onSelect={() => go("/agents")}>
            <Bot /> {t("nav.agents")}
          </CommandItem>
          <CommandItem value={`automations routines schedules triggers webhooks ${t("nav.automations")}`} onSelect={() => go("/automations")}>
            <Workflow /> {t("nav.automations")}
          </CommandItem>
          <CommandItem value={`needs you inbox to-dos questions approvals my tasks ${t("nav.inbox")}`} onSelect={() => go("/inbox")}>
            <Inbox /> {t("nav.inbox")}
          </CommandItem>
          <CommandItem onSelect={() => go("/archived")}>
            <Archive /> {t("nav.archivedChats")}
          </CommandItem>
          <CommandItem value={`archived tasks board tickets ${t("nav.archivedTasks")}`} onSelect={() => go("/tasks?view=archived")}>
            <Archive /> {t("nav.archivedTasks")}
          </CommandItem>
          <CommandItem value={`passwords logins vault ${t("nav.passwords")}`} onSelect={() => go("/vault/logins")}>
            <KeyRound /> {t("nav.passwords")}
          </CommandItem>
          <CommandItem value={`2fa codes two-factor authenticator totp otp ${t("palette.twoFactorCodes")}`} onSelect={() => go("/vault/2fa")}>
            <ShieldCheck /> {t("palette.twoFactorCodes")}
          </CommandItem>
          <CommandItem value={`passkeys webauthn ${t("palette.passkeys")}`} onSelect={() => go("/vault/passkeys")}>
            <Fingerprint /> {t("palette.passkeys")}
          </CommandItem>
          {on?.cards.enabled && (
            <CommandItem value={`cards payment credit cards purchases subscriptions ${t("nav.cards")}`} keywords={alias("/vault/cards", t("nav.cards"))} onSelect={() => go("/vault/cards")}>
              <CreditCard /> {named("/vault/cards", t("nav.cards"))}
            </CommandItem>
          )}
          {on?.artifacts.enabled && (
            <CommandItem value={`artifacts dashboards apps trackers ${t("palette.artifacts")}`} keywords={mode === "easy" ? [t("palette.artifactsEasy")] : undefined} onSelect={() => go("/settings/artifacts")}>
              <AppWindow /> {mode === "easy" ? t("palette.artifactsEasy") : t("palette.artifacts")}
            </CommandItem>
          )}
          {on?.integrations.enabled && (
            <CommandItem value={`integrations connected apps composio api tools mcp servers ${t("palette.integrations")} ${t("palette.integrationsEasy")}`} onSelect={() => go("/settings/integrations")}>
              <Plug /> {mode === "easy" ? t("palette.integrationsEasy") : t("palette.integrations")}
            </CommandItem>
          )}
          {on?.messaging.enabled && (
            <CommandItem value={`messaging chat apps slack telegram microsoft teams bots ${t("palette.messaging")} ${t("palette.messagingEasy")}`} onSelect={() => go("/settings/messaging")}>
              <MessageCircle /> {mode === "easy" ? t("palette.messagingEasy") : t("palette.messaging")}
            </CommandItem>
          )}
          {on?.phone.enabled && (
            <CommandItem value={`calls phone calls elevenlabs voice transcripts ${t("nav.calls")}`} keywords={alias("/calls", t("nav.calls"))} onSelect={() => go("/calls")}>
              <Phone /> {named("/calls", t("nav.calls"))}
            </CommandItem>
          )}
          <CommandItem onSelect={() => go("/browser")}>
            <Globe /> {t("nav.browser")}
          </CommandItem>
          <CommandItem keywords={alias("/computer", t("nav.computer"))} onSelect={() => go("/computer")}>
            <MonitorUp /> {named("/computer", t("nav.computer"))}
          </CommandItem>
          {on?.vm.enabled && (
            <CommandItem value={`virtual machines vms macos tart ${t("nav.vms")}`} onSelect={() => go("/vms")}>
              <Box /> {t("nav.vms")}
            </CommandItem>
          )}
          {on?.ssh.enabled && (
            <CommandItem value={`ssh servers remote linux ${t("nav.ssh")}`} keywords={alias("/ssh", t("nav.ssh"))} onSelect={() => go("/ssh")}>
              <Server /> {named("/ssh", t("nav.ssh"))}
            </CommandItem>
          )}
          {on?.android.enabled && (
            <CommandItem value={`android phones adb emulator devices ${t("palette.settingsSections.android")}`} onSelect={() => go("/settings/android")}>
              <Smartphone /> {t("palette.settingsSections.android")}
            </CommandItem>
          )}
          <CommandItem onSelect={() => go("/workspaces")}>
            <Layers /> {t("palette.workspaces")}
          </CommandItem>
          <CommandItem value={`instructions rules agent context ${t("palette.instructions")}`} onSelect={() => go("/settings/instructions")}>
            <ScrollText /> {t("palette.instructions")}
          </CommandItem>
          <CommandItem value="claude code mcp server cli connect terminal cursor api key" onSelect={() => go("/settings/connect")}>
            <SquareTerminal /> Claude Code & MCP
          </CommandItem>
          <CommandItem value="godmode cloud link browser remote access" onSelect={() => go("/settings/cloud")}>
            <Cloud /> Godmode Cloud
          </CommandItem>
          <CommandItem value={`license licence key activate trial subscription pro plan ${t("palette.license")}`} onSelect={() => go("/settings/license")}>
            <KeySquare /> {t("palette.license")}
          </CommandItem>
          <CommandItem value={`billing plan subscription invoices usage tokens ${t("palette.billing")}`} onSelect={() => go("/settings/billing")}>
            <CreditCard /> {t("palette.billing")}
          </CommandItem>
          <CommandItem onSelect={() => go("/settings/general")}>
            <Settings /> {t("common:words.settings")} <CommandShortcut>{modKey},</CommandShortcut>
          </CommandItem>
        </CommandGroup>
        {searching && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("common:words.settings")}>
              {SETTINGS.map(({ id, label, icon: Icon, words }) => (
                <CommandItem key={id} value={`settings ${t("common:words.settings")} ${t(`palette.settingsSections.${label}`)} ${words}`} onSelect={() => go(`/settings/${id}`)}>
                  <Icon /> {t(`palette.settingsSections.${label}`)}
                  <span className="ml-2 text-xs text-muted-foreground">{t("common:words.settings")}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
        {agents.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("nav.agents")}>
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
        {chatHits.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("palette.groups.chats")}>
              {chatHits.map((c) => (
                <CommandItem
                  key={searching ? `${c.id}:${q}` : c.id}
                  value={unique(`chat ${c.title}`, c.id)}
                  keywords={searching ? [q] : c.snippet ? [c.snippet] : undefined}
                  onSelect={() => go(c.messageId ? `/chat/${c.id}?m=${c.messageId}` : `/chat/${c.id}`)}
                >
                  <MessageCircle className="opacity-50" /> <span className="max-w-[45%] shrink-0 truncate">{c.title}</span>
                  {c.snippet && (c.marked ? <Marked text={c.snippet} className="ml-2 min-w-0 flex-1 truncate text-xs text-muted-foreground" /> : <span className="ml-2 min-w-0 flex-1 truncate text-xs text-muted-foreground">{c.snippet}</span>)}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}

function Marked({ text, className }: { text: string; className?: string }) {
  return (
    <span className={className}>
      {searchSegments(text).map((seg, i) =>
        seg.hit ? (
          <mark key={i} className="rounded-[3px] bg-primary/15 px-0.5 text-foreground">
            {seg.text}
          </mark>
        ) : (
          seg.text
        ),
      )}
    </span>
  );
}
