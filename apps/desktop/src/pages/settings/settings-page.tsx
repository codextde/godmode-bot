import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Navigate, NavLink, useLocation, useNavigate, type To } from "react-router";
import searchIndex from "virtual:settings-search";
import { useTranslation } from "react-i18next";
import type { ParseKeys, TFunction } from "i18next";
import { AnimatePresence, motion } from "motion/react";
import {
  Activity,
  AppWindow,
  AudioLines,
  BrainCircuit,
  Box,
  ChevronRight,
  BroomSparkles,
  Cloud,
  CreditCard,
  DatabaseBackup,
  FolderOpen,
  Globe,
  HeartPulse,
  Info,
  KeyRound,
  KeySquare,
  Laptop,
  Logs,
  MessageCircle,
  MonitorUp,
  Phone,
  Plug,
  Puzzle,
  RefreshCw,
  Search,
  ScrollText,
  Server,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  SquareTerminal,
  UsersRound,
  X,
} from "lucide-react";
import { EmptyState } from "@/components/common";
import { usePluginsWaiting } from "@/components/mods/use-plugins-waiting";
import { AboutSection } from "@/components/settings/about-section";
import { ActivitySection } from "@/components/settings/activity-section";
import { AiSection } from "@/components/settings/ai-section";
import { ClaudeAccountsSection } from "@/components/settings/claude-accounts-section";
import { AndroidSection } from "@/components/settings/android-section";
import { ApiKeysSection } from "@/components/settings/api-keys-section";
import { ArtifactsSection } from "@/components/settings/artifacts-section";
import { BackupSection } from "@/components/settings/backup-section";
import { BillingSection } from "@/components/settings/billing-section";
import { BrowserSection } from "@/components/settings/browser-section";
import { CallsSection } from "@/components/settings/calls-section";
import { CardsSection } from "@/components/settings/cards-section";
import { CleanupSection } from "@/components/settings/cleanup-section";
import { CloudSection } from "@/components/settings/cloud-section";
import { ComputerSection } from "@/components/settings/computer-section";
import { ConnectSection } from "@/components/settings/connect-section";
import { DevicesSection } from "@/components/settings/devices-section";
import { FEATURE_SECTION, FEATURES, featureOn } from "@/components/settings/feature-section";
import { FilesSection } from "@/components/settings/files-section";
import { GeneralSection } from "@/components/settings/general-section";
import { InstructionsSection } from "@/components/settings/instructions-section";
import { IntegrationsSection } from "@/components/settings/integrations-section";
import { LicenseSection } from "@/components/settings/license-section";
import { LogsSection } from "@/components/settings/logs-section";
import { MemorySection } from "@/components/settings/memory-section";
import { MessagingSection } from "@/components/settings/messaging-section";
import { PhoneSection } from "@/components/settings/phone-section";
import { PluginsSection } from "@/components/settings/plugins-section";
import { SecuritySection } from "@/components/settings/security-section";
import { SshSection } from "@/components/settings/ssh-section";
import { SystemSection } from "@/components/settings/system-section";
import { VmSection } from "@/components/settings/vm-section";
import { VoiceSection } from "@/components/settings/voice-section";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { useBootstrap, useSettings } from "@/lib/hooks";
import { useEasyMode } from "@/lib/mode";
import { cn } from "@/lib/utils";
import { useReduceAnimations } from "@/lib/motion";

type SettingsKey = ParseKeys<"settings">;

const SECTIONS = [
  { id: "general", labelKey: "page.sections.general", icon: <SlidersHorizontal />, groupKey: "page.groups.preferences" },
  { id: "ai", labelKey: "page.sections.ai", icon: <Sparkles />, groupKey: "page.groups.preferences" },
  { id: "accounts", labelKey: "page.sections.accounts", icon: <UsersRound />, groupKey: "page.groups.preferences" },
  { id: "instructions", labelKey: "page.sections.instructions", icon: <ScrollText />, groupKey: "page.groups.preferences" },
  { id: "browser", labelKey: "page.sections.browser", icon: <Globe />, groupKey: "page.groups.preferences" },
  { id: "computer", labelKey: "page.sections.computer", icon: <MonitorUp />, groupKey: "page.groups.preferences" },
  { id: "voice", labelKey: "page.sections.voice", icon: <AudioLines />, groupKey: "page.groups.preferences" },
  { id: "memory", labelKey: "page.sections.memory", icon: <BrainCircuit />, groupKey: "page.groups.preferences" },
  { id: "activity", labelKey: "page.sections.activity", icon: <Activity />, groupKey: "page.groups.features" },
  { id: "artifacts", labelKey: "page.sections.artifacts", icon: <AppWindow />, groupKey: "page.groups.features" },
  { id: "integrations", labelKey: "page.sections.integrations", icon: <Plug />, groupKey: "page.groups.features" },
  { id: "plugins", labelKey: "page.sections.plugins", icon: <Puzzle />, groupKey: "page.groups.features" },
  { id: "messaging", labelKey: "page.sections.messaging", icon: <MessageCircle />, groupKey: "page.groups.features" },
  { id: "calls", labelKey: "page.sections.calls", icon: <Phone />, groupKey: "page.groups.features" },
  { id: "cards", labelKey: "page.sections.cards", icon: <CreditCard />, groupKey: "page.groups.features" },
  { id: "vms", labelKey: "page.sections.vms", icon: <Box />, groupKey: "page.groups.features" },
  { id: "ssh", labelKey: "page.sections.ssh", icon: <Server />, groupKey: "page.groups.features" },
  { id: "android", labelKey: "page.sections.android", icon: <Smartphone />, groupKey: "page.groups.features" },
  { id: "files", labelKey: "page.sections.files", icon: <FolderOpen />, groupKey: "page.groups.dataPrivacy" },
  { id: "api-keys", labelKey: "page.sections.apiKeys", icon: <KeyRound />, groupKey: "page.groups.dataPrivacy" },
  { id: "security", labelKey: "page.sections.security", icon: <ShieldCheck />, groupKey: "page.groups.dataPrivacy" },
  { id: "backup", labelKey: "page.sections.backup", icon: <DatabaseBackup />, groupKey: "page.groups.dataPrivacy" },
  { id: "phone", labelKey: "page.sections.phone", icon: <Smartphone />, groupKey: "page.groups.app" },
  { id: "devices", labelKey: "page.sections.devices", icon: <Laptop />, groupKey: "page.groups.app" },
  { id: "connect", labelKey: "page.sections.connect", icon: <SquareTerminal />, groupKey: "page.groups.app" },
  { id: "cloud", labelKey: "page.sections.cloud", icon: <Cloud />, groupKey: "page.groups.app" },
  { id: "license", labelKey: "page.sections.license", icon: <KeySquare />, groupKey: "page.groups.app" },
  { id: "billing", labelKey: "page.sections.billing", icon: <CreditCard />, groupKey: "page.groups.app" },
  { id: "system", labelKey: "page.sections.system", icon: <HeartPulse />, groupKey: "page.groups.app" },
  { id: "cleanup", labelKey: "page.sections.cleanup", icon: <BroomSparkles />, groupKey: "page.groups.app" },
  { id: "logs", labelKey: "page.sections.logs", icon: <Logs />, groupKey: "page.groups.app" },
  { id: "about", labelKey: "page.sections.about", icon: <Info />, groupKey: "page.groups.app" },
] as const satisfies readonly { id: string; labelKey: SettingsKey; icon: ReactNode; groupKey: SettingsKey }[];

type SectionId = (typeof SECTIONS)[number]["id"];

/** Easy mode: the sections people change day to day, in plain words; the rest waits under Advanced. */
const EASY: Partial<Record<SectionId, { labelKey: SettingsKey; groupKey: SettingsKey }>> = {
  general: { labelKey: "page.easy.general", groupKey: "page.groups.everyday" },
  ai: { labelKey: "page.easy.ai", groupKey: "page.groups.everyday" },
  accounts: { labelKey: "page.easy.accounts", groupKey: "page.groups.everyday" },
  instructions: { labelKey: "page.easy.instructions", groupKey: "page.groups.everyday" },
  memory: { labelKey: "page.easy.memory", groupKey: "page.groups.everyday" },
  voice: { labelKey: "page.easy.voice", groupKey: "page.groups.everyday" },
  calls: { labelKey: "page.easy.calls", groupKey: "page.groups.everyday" },
  phone: { labelKey: "page.easy.phone", groupKey: "page.groups.everyday" },
  activity: { labelKey: "page.easy.activity", groupKey: "page.groups.extras" },
  artifacts: { labelKey: "page.easy.artifacts", groupKey: "page.groups.extras" },
  integrations: { labelKey: "page.easy.integrations", groupKey: "page.groups.extras" },
  plugins: { labelKey: "page.easy.plugins", groupKey: "page.groups.extras" },
  messaging: { labelKey: "page.easy.messaging", groupKey: "page.groups.extras" },
  cards: { labelKey: "page.easy.cards", groupKey: "page.groups.extras" },
  vms: { labelKey: "page.easy.vms", groupKey: "page.groups.extras" },
  ssh: { labelKey: "page.easy.ssh", groupKey: "page.groups.extras" },
  android: { labelKey: "page.easy.android", groupKey: "page.groups.extras" },
  security: { labelKey: "page.easy.security", groupKey: "page.groups.account" },
  backup: { labelKey: "page.easy.backup", groupKey: "page.groups.account" },
  license: { labelKey: "page.easy.license", groupKey: "page.groups.account" },
  billing: { labelKey: "page.easy.billing", groupKey: "page.groups.account" },
  about: { labelKey: "page.easy.about", groupKey: "page.groups.account" },
};

const EASY_ADVANCED_LABEL: Partial<Record<SectionId, SettingsKey>> = {
  computer: "page.easy.computer",
  connect: "page.easy.connect",
  system: "page.easy.system",
};

/** Sections that render without the settings document (they use their own endpoints). */
const STANDALONE: SectionId[] = ["files", "api-keys", "backup", "devices", "connect", "cloud", "license", "billing", "system", "cleanup", "about"];

export default function SettingsDialog({ closeTo }: { closeTo: To }) {
  const { t } = useTranslation(["settings", "common"]);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [focusLabel, setFocusLabel] = useState<string | null>(null);
  const section = pathname.split("/")[2];

  if (!SECTIONS.some((s) => s.id === section)) return <Navigate to="/settings/general" replace />;
  const active = section as SectionId;

  const open = (id: SectionId, label: string | null = null) => {
    setFocusLabel(label);
    if (id !== active) navigate(`/settings/${id}`, { replace: true });
  };

  return (
    <Dialog open onOpenChange={(next) => !next && navigate(closeTo)}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          document.getElementById("settings-search")?.focus();
        }}
        onEscapeKeyDown={(e) => {
          if (!query) return;
          e.preventDefault();
          setQuery("");
        }}
        className="@container flex h-[min(860px,calc(100vh-3rem))] w-[min(1180px,calc(100vw-3rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <header className="flex shrink-0 items-center justify-between border-b px-5 py-3">
          <DialogTitle className="text-[15px] font-medium tracking-[-0.01em]">{t("common:words.settings")}</DialogTitle>
          <DialogDescription className="sr-only">{t("page.dialogDescription")}</DialogDescription>
          <Button variant="ghost" size="icon" className="size-8" aria-label={t("page.close")} onClick={() => navigate(closeTo)}>
            <X />
          </Button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col @4xl:flex-row">
          <aside className="flex shrink-0 flex-col gap-3 border-b px-4 pt-4 pb-2 @4xl:w-64 @4xl:overflow-y-auto @4xl:border-r @4xl:border-b-0 @4xl:pb-4">
            <SettingsSearch query={query} onQuery={setQuery} onPick={open} />
            {query.trim() ? <SearchResults query={query} active={active} onPick={open} /> : <SectionNav active={active} />}
          </aside>
          <SectionContent active={active} focusLabel={focusLabel} onFocused={() => setFocusLabel(null)} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SectionContent({ active, focusLabel, onFocused }: { active: SectionId; focusLabel: string | null; onFocused: () => void }) {
  const reduce = useReduceAnimations();
  const { t } = useTranslation(["settings", "common"]);
  const settings = useSettings();
  const { data: boot } = useBootstrap();
  const scroller = useRef<HTMLDivElement>(null);
  const needsSettings = !STANDALONE.includes(active);

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [active]);

  useEffect(() => {
    if (!focusLabel) return;
    const started = performance.now();
    let timer = 0;
    const find = () => {
      const target = [...(scroller.current?.querySelectorAll(`[data-section="${active}"] :is(label, h2, h3)`) ?? [])].find((el) => el.textContent?.trim() === focusLabel);
      if (target) {
        const row = target.closest<HTMLElement>("[data-slot=setting-row], [data-slot=settings-group]") ?? (target as HTMLElement);
        row.scrollIntoView({ block: "center", behavior: "smooth" });
        row.animate([{ backgroundColor: "color-mix(in oklab, var(--brand) 14%, transparent)" }, { backgroundColor: "transparent" }], { duration: 1800, easing: "ease-out" });
        onFocused();
      } else if (performance.now() - started < 3000) timer = window.setTimeout(find, 100);
      else onFocused();
    };
    find();
    return () => window.clearTimeout(timer);
  }, [focusLabel, active, onFocused]);

  let content: ReactNode;
  if (needsSettings && settings.isLoading) content = <SectionSkeleton />;
  else if (needsSettings && (settings.isError || !settings.data))
    content = (
      <EmptyState
        icon={<Settings2 />}
        title={t("page.loadError")}
        description={errorMessage(settings.error)}
        action={
          <Button variant="outline" onClick={() => settings.refetch()}>
            <RefreshCw /> {t("common:actions.tryAgain")}
          </Button>
        }
      />
    );
  else {
    const s = settings.data!;
    content = {
      general: () => <GeneralSection settings={s} />,
      ai: () => <AiSection settings={s} />,
      accounts: () => <ClaudeAccountsSection settings={s} />,
      instructions: () => <InstructionsSection settings={s} />,
      browser: () => <BrowserSection settings={s} />,
      computer: () => <ComputerSection settings={s} />,
      vms: () => <VmSection settings={s} />,
      activity: () => <ActivitySection settings={s} />,
      plugins: () => <PluginsSection settings={s} />,
      cards: () => <CardsSection settings={s} />,
      ssh: () => <SshSection settings={s} />,
      artifacts: () => <ArtifactsSection settings={s} />,
      integrations: () => <IntegrationsSection settings={s} />,
      messaging: () => <MessagingSection settings={s} />,
      android: () => <AndroidSection settings={s} />,
      voice: () => <VoiceSection settings={s} />,
      calls: () => <CallsSection settings={s} />,
      memory: () => <MemorySection settings={s} />,
      files: () => <FilesSection />,
      "api-keys": () => <ApiKeysSection />,
      security: () => <SecuritySection settings={s} />,
      backup: () => <BackupSection />,
      phone: () => <PhoneSection settings={s} />,
      devices: () => <DevicesSection />,
      connect: () => <ConnectSection />,
      cloud: () => <CloudSection />,
      license: () => <LicenseSection />,
      billing: () => <BillingSection />,
      system: () => <SystemSection bootstrap={boot} settings={settings.data} />,
      cleanup: () => <CleanupSection settings={settings.data} />,
      logs: () => <LogsSection settings={s} />,
      about: () => <AboutSection version={boot?.version} />,
    }[active]();
  }

  return (
    <div ref={scroller} className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-6 @4xl:px-10">
      <div className="mx-auto max-w-3xl">
        {reduce ? (
          <div key={active} data-section={active}>
            {content}
          </div>
        ) : (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={active}
              data-section={active}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
            >
              {content}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}

const fold = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

type Hit = { id: SectionId; label: string; icon: ReactNode; settings: string[] };

function useLabels(): Record<SectionId, string> {
  const { t } = useTranslation("settings");
  const easy = useEasyMode();
  return Object.fromEntries(SECTIONS.map((s) => [s.id, t(easy ? (EASY[s.id]?.labelKey ?? EASY_ADVANCED_LABEL[s.id] ?? s.labelKey) : s.labelKey)])) as Record<SectionId, string>;
}

const searchText = (s: string, t: TFunction<"settings">) => (s.startsWith("@") ? t(s.slice(1) as never, { ns: "settings" }) : s);

function useSearch(query: string): Hit[] {
  const labels = useLabels();
  const { t } = useTranslation("settings");
  return useMemo(() => {
    const words = fold(query).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const matches = (text: string) => {
      const folded = fold(text);
      return words.every((w) => folded.includes(w));
    };
    return SECTIONS.flatMap((s) => {
      const entry = searchIndex[s.id] ?? { labels: [], text: [] };
      const settings = entry.labels.map((l) => searchText(l, t)).filter((l) => l !== labels[s.id] && matches(l));
      const hit = matches(labels[s.id]) || matches(t(s.labelKey)) || settings.length > 0 || matches(entry.text.map((l) => searchText(l, t)).join(" "));
      return hit ? [{ id: s.id, label: labels[s.id], icon: s.icon, settings: settings.slice(0, 5) }] : [];
    }).sort((a, b) => Number(matches(b.label)) - Number(matches(a.label)) || b.settings.length - a.settings.length);
  }, [query, labels, t]);
}

function SettingsSearch({ query, onQuery, onPick }: { query: string; onQuery: (q: string) => void; onPick: (id: SectionId, label: string | null) => void }) {
  const { t } = useTranslation("settings");
  const hits = useSearch(query);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || !hits[0]) return;
    e.preventDefault();
    onPick(hits[0].id, hits[0].settings[0] ?? null);
  };
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        id="settings-search"
        type="search"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t("page.search")}
        aria-label={t("page.search")}
        className="h-9 w-full rounded-lg border bg-secondary pr-3 pl-8.5 text-[13.5px] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-search-cancel-button]:hidden"
      />
    </div>
  );
}

function SearchResults({ query, active, onPick }: { query: string; active: SectionId; onPick: (id: SectionId, label: string | null) => void }) {
  const { t } = useTranslation("settings");
  const hits = useSearch(query);
  if (!hits.length) return <p className="px-3 py-2 text-[13px] text-muted-foreground">{t("page.noMatch", { query: query.trim() })}</p>;
  return (
    <nav aria-label={t("page.matching")} className="flex max-h-48 flex-col gap-0.5 overflow-y-auto @4xl:max-h-none @4xl:overflow-visible">
      {hits.map((hit) => (
        <div key={hit.id} className="flex flex-col">
          <button
            type="button"
            onClick={() => onPick(hit.id, null)}
            className={cn(
              "flex h-8 items-center gap-2.5 rounded-md px-3 text-left text-[13.5px] outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-4 [&_svg]:shrink-0",
              hit.id === active ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {hit.icon}
            <span className="truncate">{hit.label}</span>
          </button>
          {hit.settings.map((label) => (
            <button
              key={label}
              type="button"
              onClick={() => onPick(hit.id, label)}
              className="ml-9 truncate rounded-md px-2 py-1 text-left text-[12.5px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {label}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}

type NavEntry = { id: SectionId; label: string; icon: ReactNode; group: string };
type Marks = Partial<Record<SectionId, ReactNode>>;

/** Next to the optional features: "Off", or what waits for the human there (people who asked to talk to a bot). */
function useMarks(): Marks {
  const { t } = useTranslation(["settings", "common"]);
  const { data: boot } = useBootstrap();
  const plugins = usePluginsWaiting();
  if (!boot) return {};
  const marks: Marks = {};
  for (const feature of FEATURES) if (!featureOn(boot.settings, feature)) marks[FEATURE_SECTION[feature] as SectionId] = <span className="text-[11px] text-muted-foreground/70">{t("common:status.off")}</span>;
  const requests = featureOn(boot.settings, "messaging") ? boot.counts.messagingRequests : 0;
  if (requests) marks.messaging = <WaitingMark count={requests} />;
  if (plugins) marks.plugins = <WaitingMark count={plugins} />;
  return marks;
}

function WaitingMark({ count }: { count: number }) {
  const { t } = useTranslation("settings");
  return (
    <span className="rounded-[5px] bg-brand-soft px-1.5 font-mono text-[10.5px] leading-4 font-medium text-brand-strong tabular-nums" aria-label={t("page.waiting", { count })}>
      {count}
    </span>
  );
}

function SectionNav({ active }: { active: SectionId }) {
  const { t } = useTranslation("settings");
  const easy = useEasyMode();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const marks = useMarks();
  if (!easy) return <SectionList active={active} entries={SECTIONS.map((s) => ({ id: s.id, icon: s.icon, label: t(s.labelKey), group: t(s.groupKey) }))} marks={marks} />;
  const everyday: NavEntry[] = (Object.keys(EASY) as SectionId[]).map((id) => ({ id, icon: SECTIONS.find((s) => s.id === id)!.icon, label: t(EASY[id]!.labelKey), group: t(EASY[id]!.groupKey) }));
  const advanced: NavEntry[] = SECTIONS.flatMap((s) =>
    EASY[s.id] ? [] : [{ id: s.id, icon: s.icon, label: t(EASY_ADVANCED_LABEL[s.id] ?? s.labelKey), group: t("page.groups.advanced") }],
  );
  const open = showAdvanced || advanced.some((s) => s.id === active);
  return (
    <SectionList
      active={active}
      entries={open ? [...everyday, ...advanced] : everyday}
      marks={marks}
      footer={
        !open && (
          <button
            type="button"
            onClick={() => setShowAdvanced(true)}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-[13px] whitespace-nowrap text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 @4xl:mt-4"
          >
            {t("page.advanced")}
            <ChevronRight className="size-3.5" />
          </button>
        )
      }
    />
  );
}

function SectionList({ active, entries, marks, footer }: { active: SectionId; entries: readonly NavEntry[]; marks: Marks; footer?: ReactNode }) {
  const reduce = useReduceAnimations();
  const { t } = useTranslation("settings");
  return (
    <nav
      aria-label={t("page.sectionsLabel")}
      className={cn(
        "scroll-fade-x -mx-2 flex gap-1 overflow-x-auto px-2 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        "@4xl:sticky @4xl:top-6 @4xl:mx-0 @4xl:w-52 @4xl:shrink-0 @4xl:flex-col @4xl:gap-0.5 @4xl:overflow-visible @4xl:px-0 @4xl:pb-0 @4xl:mask-none @4xl:animate-none",
      )}
    >
      {entries.map((s, i) => {
        const isActive = s.id === active;
        const firstInGroup = i === 0 || entries[i - 1].group !== s.group;
        return (
          <div key={s.id} className="contents">
            {firstInGroup && (
              <div className={cn("eyebrow hidden px-3 pb-1.5 @4xl:block", i > 0 && "@4xl:mt-4")}>{s.group}</div>
            )}
            <NavLink
              to={`/settings/${s.id}`}
              replace
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "relative flex h-8 shrink-0 items-center gap-2.5 rounded-md px-3 text-[13.5px] whitespace-nowrap outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                "[&_svg]:size-4 [&_svg]:shrink-0",
                isActive ? "font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {isActive && (
                <motion.span
                  layoutId={reduce ? undefined : "settings-nav-pill"}
                  className="absolute inset-0 rounded-md bg-card shadow-card ring-1 ring-border"
                  transition={{ type: "spring", stiffness: 420, damping: 36 }}
                />
              )}
              <span className={cn("relative", isActive ? "text-foreground" : "text-muted-foreground")}>{s.icon}</span>
              <span className="relative">{s.label}</span>
              {marks[s.id] && <span className="relative ml-auto pl-2">{marks[s.id]}</span>}
            </NavLink>
          </div>
        );
      })}
      {footer}
    </nav>
  );
}

function SectionSkeleton() {
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-80" />
      </div>
      {[0, 1].map((i) => (
        <div key={i} className="space-y-4 rounded-xl border bg-card p-5 shadow-card">
          <Skeleton className="h-5 w-32" />
          {[0, 1, 2].map((j) => (
            <div key={j} className="flex items-center justify-between gap-6">
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-44" />
                <Skeleton className="h-3 w-72" />
              </div>
              <Skeleton className="h-6 w-10 rounded-full" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
