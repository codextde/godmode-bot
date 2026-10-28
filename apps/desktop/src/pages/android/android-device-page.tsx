import { useCallback, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bell,
  ChevronLeft,
  Circle,
  CornerDownLeft,
  Moon,
  Pencil,
  Power,
  Settings2,
  Smartphone,
  Square,
  Sun,
  Terminal,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import { androidSummary, type AndroidDevice, type AndroidExecResult, type AndroidInputEvent, type AndroidKey } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LiveDot } from "@/components/aicss/Motion";
import { EmptyState } from "@/components/common";
import { EditPhoneDialog } from "@/components/android/android-dialogs";
import { AndroidStateBadge, BatteryPill, CONNECTION_LABEL } from "@/components/android/android-parts";
import { PhoneScreen } from "@/components/android/phone-screen";
import { UsedBy } from "@/components/android/used-by";
import { toastApiError } from "@/components/vault/vault-utils";
import { api, errorMessage } from "@/lib/api";
import { isTauri } from "@/lib/core";
import { isMac } from "@/lib/desktop";
import { useAndroidDevices } from "@/lib/hooks";
import { cn } from "@/lib/utils";

function useSend(device: AndroidDevice | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (event: AndroidInputEvent) => api.android.input(device!.id, { event }),
    onError: (e) => toastApiError(e, "The phone didn't take that", qc),
  });
}

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("border-b px-4 py-4", className)}>
      <h2 className="eyebrow mb-2.5 text-[10.5px]">{title}</h2>
      {children}
    </section>
  );
}

const BUTTONS: { key: AndroidKey; label: string; icon: ReactNode }[] = [
  { key: "power", label: "Power", icon: <Power /> },
  { key: "volume_down", label: "Volume down", icon: <Volume1 /> },
  { key: "volume_up", label: "Volume up", icon: <Volume2 /> },
  { key: "mute", label: "Mute", icon: <VolumeX /> },
  { key: "wake", label: "Wake the screen", icon: <Sun /> },
  { key: "sleep", label: "Turn the screen off", icon: <Moon /> },
  { key: "notifications", label: "Notifications", icon: <Bell /> },
  { key: "quick_settings", label: "Quick settings", icon: <Settings2 /> },
];

function NavButton({ label, onClick, children, disabled }: { label: string; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} onClick={onClick} disabled={disabled} className="size-10 rounded-full text-foreground/80 hover:text-foreground [&_svg]:size-[18px]">
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function TypePanel({ device }: { device: AndroidDevice }) {
  const send = useSend(device);
  const [text, setText] = useState("");
  const submit = async (e: FormEvent, enter: boolean) => {
    e.preventDefault();
    if (!text) return;
    await send.mutateAsync({ type: "text", text });
    if (enter) await send.mutateAsync({ type: "key", key: "enter" });
    setText("");
  };
  const ascii = /^[\x20-\x7e]*$/.test(text);
  return (
    <form onSubmit={(e) => void submit(e, false)} className="grid gap-2">
      <div className="flex gap-1.5">
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Text for the focused field" disabled={device.state !== "connected"} aria-label="Text to type on the phone" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="outline" size="icon" aria-label="Type and press Enter" disabled={!text || !ascii || send.isPending} onClick={(e) => void submit(e, true)}>
              <CornerDownLeft />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Type and press Enter</TooltipContent>
        </Tooltip>
      </div>
      {!ascii && <p className="text-[11px] text-destructive">adb types plain ASCII only. Use the phone's keyboard for ä, é or emoji.</p>}
    </form>
  );
}

function CommandPanel({ device }: { device: AndroidDevice }) {
  const qc = useQueryClient();
  const [command, setCommand] = useState("");
  const [result, setResult] = useState<(AndroidExecResult & { command: string }) | null>(null);
  const run = useMutation({
    mutationFn: (cmd: string) => api.android.exec(device.id, { command: cmd }),
    onSuccess: (res, cmd) => setResult({ ...res, command: cmd }),
    onError: (e) => toastApiError(e, "The command didn't run", qc),
  });
  return (
    <div className="grid gap-2">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (command.trim()) run.mutate(command.trim());
        }}
        className="flex gap-1.5"
      >
        <Input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="pm list packages -3"
          className="font-mono text-xs"
          spellCheck={false}
          disabled={device.state !== "connected"}
          aria-label="Shell command"
        />
        <Button type="submit" variant="outline" size="icon" aria-label="Run" disabled={!command.trim() || run.isPending}>
          {run.isPending ? <Spinner className="size-4" /> : <Terminal />}
        </Button>
      </form>
      {result && (
        <div className="overflow-hidden rounded-lg border bg-[#141414] text-[11.5px] leading-relaxed text-white/85">
          <div className="flex items-center justify-between border-b border-white/10 px-2.5 py-1.5 font-mono text-[10.5px] text-white/50">
            <span className="truncate">$ {result.command}</span>
            <span className={cn("shrink-0", result.exitCode === 0 ? "text-emerald-400" : "text-red-400")}>{result.timedOut ? "timed out" : `exit ${result.exitCode}`}</span>
          </div>
          <pre className="max-h-64 overflow-auto px-2.5 py-2 font-mono break-words whitespace-pre-wrap">
            {result.stdout || result.stderr ? (
              <>
                {result.stdout}
                {result.stderr && <span className="text-red-300">{result.stderr}</span>}
              </>
            ) : (
              <span className="text-white/40">(no output)</span>
            )}
          </pre>
        </div>
      )}
    </div>
  );
}

function About({ device }: { device: AndroidDevice }) {
  const rows: [string, ReactNode][] = [
    ["Phone", androidSummary(device)],
    ["Connection", device.connection ? CONNECTION_LABEL[device.connection] : "Not connected"],
    ["Screen", device.width && device.height ? `${device.width} × ${device.height}` : "Unknown"],
    ["Serial", <span className="font-mono text-[11px]">{device.serial.replace(/^avd:/, "")}</span>],
  ];
  return (
    <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1.5 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 truncate">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One phone, full size and under the human's control. */
export default function AndroidDevicePage() {
  const { id } = useParams();
  const list = useAndroidDevices();
  const device = list.data?.find((d) => d.id === id);
  const send = useSend(device);
  const [live, setLive] = useState(false);
  const [editing, setEditing] = useState(false);
  const onLive = useCallback((v: boolean) => setLive(v), []);
  const press = (key: AndroidKey) => send.mutate({ type: "key", key });

  if (list.isLoading) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Skeleton className="aspect-[9/19.5] h-[70vh] rounded-[36px]" />
      </div>
    );
  }
  if (!device) {
    return (
      <div className="p-8">
        <EmptyState
          icon={<Smartphone />}
          title={list.isError ? "Couldn't load the phone" : "This phone isn't known anymore"}
          description={list.isError ? errorMessage(list.error) : "It may have been forgotten. Plug it in again and it shows up as a new phone."}
          action={
            <Button asChild variant="outline">
              <Link to="/settings/android">
                <ArrowLeft /> All phones
              </Link>
            </Button>
          }
        />
      </div>
    );
  }
  const connected = device.state === "connected";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className={cn("flex h-14 shrink-0 items-center gap-3 border-b px-4", isTauri && isMac && "h-auto pt-7 pb-2")}>
        <Button asChild variant="ghost" size="icon-sm" className="text-muted-foreground">
          <Link to="/settings/android" aria-label="All phones">
            <ArrowLeft />
          </Link>
        </Button>
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-[15px] font-medium tracking-[-0.01em]">{device.name}</h1>
          <AndroidStateBadge device={device} />
          {connected && (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-[5px] border px-1.5 py-0.5 text-[11px] leading-none font-medium",
                live ? "border-brand/25 bg-brand-soft text-brand-strong" : "bg-card text-muted-foreground",
              )}
            >
              <LiveDot live={live} />
              {live ? "Live" : "Waiting"}
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <BatteryPill battery={connected ? device.battery : null} />
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setEditing(true)}>
            <Pencil /> Rename
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col items-center gap-4 overflow-hidden bg-paper-2 px-6 pt-6 pb-4">
          <div className="flex min-h-0 w-full flex-1 items-center justify-center">
            <PhoneScreen device={device} interactive onLive={onLive} className="h-full max-h-[920px]" />
          </div>
          <div className="flex shrink-0 items-center gap-6 rounded-full border bg-card px-4 py-1 shadow-card">
            <NavButton label="Back" onClick={() => press("back")} disabled={!connected}>
              <ChevronLeft />
            </NavButton>
            <NavButton label="Home" onClick={() => press("home")} disabled={!connected}>
              <Circle />
            </NavButton>
            <NavButton label="Recent apps" onClick={() => press("recents")} disabled={!connected}>
              <Square />
            </NavButton>
          </div>
          <p className="shrink-0 text-center text-[11px] text-muted-foreground">
            Click to tap · drag to swipe · hold to long-press · scroll to swipe · right click or <Kbd>Esc</Kbd> for back · type to enter text
          </p>
        </main>

        <aside aria-label="Phone controls" className="w-80 shrink-0 overflow-y-auto border-l bg-background">
          <Section title="Buttons">
            <div className="grid grid-cols-4 gap-1.5">
              {BUTTONS.map((b) => (
                <Tooltip key={b.key}>
                  <TooltipTrigger asChild>
                    <Button variant="outline" size="icon" aria-label={b.label} disabled={!connected} onClick={() => press(b.key)} className="h-9 w-full">
                      {b.icon}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{b.label}</TooltipContent>
                </Tooltip>
              ))}
            </div>
          </Section>
          <Section title="Type">
            <TypePanel device={device} />
          </Section>
          <Section title="Run a command">
            <CommandPanel device={device} />
          </Section>
          <Section title="Agents">
            <UsedBy device={device} />
            {device.description && <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{device.description}</p>}
          </Section>
          <Section title="About" className="border-b-0">
            <About device={device} />
          </Section>
        </aside>
      </div>
      <EditPhoneDialog device={editing ? device : null} onClose={() => setEditing(false)} />
    </div>
  );
}
