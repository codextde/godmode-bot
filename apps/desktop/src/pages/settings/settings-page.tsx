import { useState, type ReactNode } from "react";
import { Navigate, NavLink, useParams } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import {
  Activity,
  AudioLines,
  BrainCircuit,
  Box,
  ChevronRight,
  BroomSparkles,
  Cloud,
  CreditCard,
  DatabaseBackup,
  Globe,
  HeartPulse,
  Info,
  KeySquare,
  Laptop,
  MonitorUp,
  Phone,
  RefreshCw,
  ScrollText,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  SquareTerminal,
} from "lucide-react";
import { EmptyState, PageBody, PageHeader } from "@/components/common";
import { AboutSection } from "@/components/settings/about-section";
import { AiSection } from "@/components/settings/ai-section";
import { AndroidSection } from "@/components/settings/android-section";
import { BackupSection } from "@/components/settings/backup-section";
import { BillingSection } from "@/components/settings/billing-section";
import { BrowserSection } from "@/components/settings/browser-section";
import { CallsSection } from "@/components/settings/calls-section";
import { CleanupSection } from "@/components/settings/cleanup-section";
import { CloudSection } from "@/components/settings/cloud-section";
import { ComputerSection } from "@/components/settings/computer-section";
import { ConnectSection } from "@/components/settings/connect-section";
import { DevicesSection } from "@/components/settings/devices-section";
import { GeneralSection } from "@/components/settings/general-section";
import { InstructionsSection } from "@/components/settings/instructions-section";
import { LicenseSection } from "@/components/settings/license-section";
import { LogsSection } from "@/components/settings/logs-section";
import { MemorySection } from "@/components/settings/memory-section";
import { PhoneSection } from "@/components/settings/phone-section";
import { SecuritySection } from "@/components/settings/security-section";
import { SystemSection } from "@/components/settings/system-section";
import { VmSection } from "@/components/settings/vm-section";
import { VoiceSection } from "@/components/settings/voice-section";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { useBootstrap, useSettings } from "@/lib/hooks";
import { useEasyMode } from "@/lib/mode";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { id: "general", label: "General", icon: <SlidersHorizontal />, group: "Preferences" },
  { id: "ai", label: "AI & Claude", icon: <Sparkles />, group: "Preferences" },
  { id: "instructions", label: "Instructions", icon: <ScrollText />, group: "Preferences" },
  { id: "browser", label: "Browser", icon: <Globe />, group: "Preferences" },
  { id: "computer", label: "Computer", icon: <MonitorUp />, group: "Preferences" },
  { id: "vms", label: "Virtual machines", icon: <Box />, group: "Preferences" },
  { id: "android", label: "Android phones", icon: <Smartphone />, group: "Preferences" },
  { id: "voice", label: "Voice", icon: <AudioLines />, group: "Preferences" },
  { id: "calls", label: "Phone calls", icon: <Phone />, group: "Preferences" },
  { id: "memory", label: "Memory", icon: <BrainCircuit />, group: "Preferences" },
  { id: "security", label: "Security", icon: <ShieldCheck />, group: "Data & privacy" },
  { id: "backup", label: "Backup", icon: <DatabaseBackup />, group: "Data & privacy" },
  { id: "phone", label: "Phone", icon: <Smartphone />, group: "App" },
  { id: "devices", label: "Devices", icon: <Laptop />, group: "App" },
  { id: "connect", label: "Claude Code & MCP", icon: <SquareTerminal />, group: "App" },
  { id: "cloud", label: "Cloud", icon: <Cloud />, group: "App" },
  { id: "license", label: "License", icon: <KeySquare />, group: "App" },
  { id: "billing", label: "Billing", icon: <CreditCard />, group: "App" },
  { id: "system", label: "System", icon: <HeartPulse />, group: "App" },
  { id: "cleanup", label: "Cleanup", icon: <BroomSparkles />, group: "App" },
  { id: "logs", label: "Logs", icon: <Activity />, group: "App" },
  { id: "about", label: "About", icon: <Info />, group: "App" },
] as const satisfies readonly { id: string; label: string; icon: ReactNode; group: string }[];

type SectionId = (typeof SECTIONS)[number]["id"];

/** Easy mode: the sections people change day to day, in plain words; the rest waits under Advanced. */
const EASY: Partial<Record<SectionId, { label: string; group: string }>> = {
  general: { label: "General", group: "Everyday" },
  ai: { label: "AI", group: "Everyday" },
  instructions: { label: "Instructions", group: "Everyday" },
  memory: { label: "Memory", group: "Everyday" },
  voice: { label: "Voice", group: "Everyday" },
  calls: { label: "Phone calls", group: "Everyday" },
  phone: { label: "Phone app", group: "Everyday" },
  security: { label: "Security", group: "Account" },
  backup: { label: "Backup", group: "Account" },
  license: { label: "License", group: "Account" },
  billing: { label: "Billing", group: "Account" },
  about: { label: "About", group: "Account" },
};

const EASY_ADVANCED_LABEL: Partial<Record<SectionId, string>> = {
  computer: "Computer control",
  connect: "Claude Code & MCP",
  system: "System check",
};

/** Sections that render without the settings document (they use their own endpoints). */
const STANDALONE: SectionId[] = ["backup", "devices", "connect", "cloud", "license", "billing", "system", "cleanup", "about"];

export default function SettingsPage() {
  const { section } = useParams();
  const settings = useSettings();
  const { data: boot } = useBootstrap();

  if (!SECTIONS.some((s) => s.id === section)) return <Navigate to="/settings/general" replace />;
  const active = section as SectionId;
  const needsSettings = !STANDALONE.includes(active);

  let content: ReactNode;
  if (needsSettings && settings.isLoading) content = <SectionSkeleton />;
  else if (needsSettings && (settings.isError || !settings.data))
    content = (
      <EmptyState
        icon={<Settings2 />}
        title="Couldn't load settings"
        description={errorMessage(settings.error)}
        action={
          <Button variant="outline" onClick={() => settings.refetch()}>
            <RefreshCw /> Try again
          </Button>
        }
      />
    );
  else {
    const s = settings.data!;
    content = {
      general: () => <GeneralSection settings={s} />,
      ai: () => <AiSection settings={s} />,
      instructions: () => <InstructionsSection settings={s} />,
      browser: () => <BrowserSection settings={s} />,
      computer: () => <ComputerSection settings={s} />,
      vms: () => <VmSection settings={s} />,
      android: () => <AndroidSection settings={s} />,
      voice: () => <VoiceSection settings={s} />,
      calls: () => <CallsSection settings={s} />,
      memory: () => <MemorySection settings={s} />,
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
    <div className="@container relative min-h-full">
      <PageHeader icon={<Settings2 />} title="Settings" description="Tune how your AI coworkers think, browse, speak and keep your secrets." />
      <PageBody>
        <div className="flex flex-col gap-6 @4xl:flex-row @4xl:items-start @4xl:gap-10">
          <SectionNav active={active} />
          <div className="min-w-0 flex-1 @4xl:max-w-3xl">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={active}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
              >
                {content}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </PageBody>
    </div>
  );
}

type NavEntry = { id: SectionId; label: string; icon: ReactNode; group: string };

function SectionNav({ active }: { active: SectionId }) {
  const easy = useEasyMode();
  const [showAdvanced, setShowAdvanced] = useState(false);
  if (!easy) return <SectionList active={active} entries={SECTIONS} />;
  const everyday: NavEntry[] = (Object.keys(EASY) as SectionId[]).map((id) => ({ ...SECTIONS.find((s) => s.id === id)!, ...EASY[id]! }));
  const advanced: NavEntry[] = SECTIONS.flatMap((s) =>
    EASY[s.id] ? [] : [{ ...s, label: EASY_ADVANCED_LABEL[s.id] ?? s.label, group: "Advanced" }],
  );
  const open = showAdvanced || advanced.some((s) => s.id === active);
  return (
    <SectionList
      active={active}
      entries={open ? [...everyday, ...advanced] : everyday}
      footer={
        !open && (
          <button
            type="button"
            onClick={() => setShowAdvanced(true)}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-[13px] whitespace-nowrap text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 @4xl:mt-4"
          >
            Advanced settings
            <ChevronRight className="size-3.5" />
          </button>
        )
      }
    />
  );
}

function SectionList({ active, entries, footer }: { active: SectionId; entries: readonly NavEntry[]; footer?: ReactNode }) {
  return (
    <nav
      aria-label="Settings sections"
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
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "relative flex h-8 shrink-0 items-center gap-2.5 rounded-md px-3 text-[13.5px] whitespace-nowrap outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                "[&_svg]:size-4 [&_svg]:shrink-0",
                isActive ? "font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {isActive && (
                <motion.span
                  layoutId="settings-nav-pill"
                  className="absolute inset-0 rounded-md bg-card shadow-card ring-1 ring-border"
                  transition={{ type: "spring", stiffness: 420, damping: 36 }}
                />
              )}
              <span className={cn("relative", isActive ? "text-foreground" : "text-muted-foreground")}>{s.icon}</span>
              <span className="relative">{s.label}</span>
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
