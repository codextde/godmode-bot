import type { ReactNode } from "react";
import { Navigate, NavLink, useParams } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import {
  Activity,
  AudioLines,
  BrainCircuit,
  Box,
  Cloud,
  CreditCard,
  DatabaseBackup,
  Globe,
  HeartPulse,
  Info,
  MonitorUp,
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
import { BackupSection } from "@/components/settings/backup-section";
import { BillingSection } from "@/components/settings/billing-section";
import { BrowserSection } from "@/components/settings/browser-section";
import { CloudSection } from "@/components/settings/cloud-section";
import { ComputerSection } from "@/components/settings/computer-section";
import { ConnectSection } from "@/components/settings/connect-section";
import { GeneralSection } from "@/components/settings/general-section";
import { InstructionsSection } from "@/components/settings/instructions-section";
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
import { cn } from "@/lib/utils";

const SECTIONS = [
  { id: "general", label: "General", icon: <SlidersHorizontal />, group: "Preferences" },
  { id: "ai", label: "AI & Claude", icon: <Sparkles />, group: "Preferences" },
  { id: "instructions", label: "Instructions", icon: <ScrollText />, group: "Preferences" },
  { id: "browser", label: "Browser", icon: <Globe />, group: "Preferences" },
  { id: "computer", label: "Computer", icon: <MonitorUp />, group: "Preferences" },
  { id: "vms", label: "Virtual machines", icon: <Box />, group: "Preferences" },
  { id: "voice", label: "Voice", icon: <AudioLines />, group: "Preferences" },
  { id: "memory", label: "Memory", icon: <BrainCircuit />, group: "Preferences" },
  { id: "security", label: "Security", icon: <ShieldCheck />, group: "Data & privacy" },
  { id: "backup", label: "Backup", icon: <DatabaseBackup />, group: "Data & privacy" },
  { id: "phone", label: "Phone", icon: <Smartphone />, group: "App" },
  { id: "connect", label: "Claude Code & MCP", icon: <SquareTerminal />, group: "App" },
  { id: "cloud", label: "Cloud", icon: <Cloud />, group: "App" },
  { id: "billing", label: "Billing", icon: <CreditCard />, group: "App" },
  { id: "system", label: "System", icon: <HeartPulse />, group: "App" },
  { id: "logs", label: "Logs", icon: <Activity />, group: "App" },
  { id: "about", label: "About", icon: <Info />, group: "App" },
] as const satisfies readonly { id: string; label: string; icon: ReactNode; group: string }[];

type SectionId = (typeof SECTIONS)[number]["id"];

/** Sections that render without the settings document (they use their own endpoints). */
const STANDALONE: SectionId[] = ["backup", "connect", "cloud", "billing", "system", "about"];

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
      voice: () => <VoiceSection settings={s} />,
      memory: () => <MemorySection settings={s} />,
      security: () => <SecuritySection settings={s} />,
      backup: () => <BackupSection />,
      phone: () => <PhoneSection settings={s} />,
      connect: () => <ConnectSection />,
      cloud: () => <CloudSection />,
      billing: () => <BillingSection />,
      system: () => <SystemSection bootstrap={boot} settings={settings.data} />,
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

function SectionNav({ active }: { active: SectionId }) {
  return (
    <nav
      aria-label="Settings sections"
      className={cn(
        "scroll-fade-x -mx-2 flex gap-1 overflow-x-auto px-2 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        "@4xl:sticky @4xl:top-6 @4xl:mx-0 @4xl:w-52 @4xl:shrink-0 @4xl:flex-col @4xl:gap-0.5 @4xl:overflow-visible @4xl:px-0 @4xl:pb-0 @4xl:mask-none @4xl:animate-none",
      )}
    >
      {SECTIONS.map((s, i) => {
        const isActive = s.id === active;
        const firstInGroup = i === 0 || SECTIONS[i - 1].group !== s.group;
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
