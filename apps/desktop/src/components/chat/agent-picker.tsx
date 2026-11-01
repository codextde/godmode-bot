import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import type { Agent } from "@godmode/shared";
import { Bot, Check, ChevronDown, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AgentAvatar } from "@/components/common";
import { useWorkspaces } from "@/lib/hooks";
import { useLiveRunsMap } from "@/stores/live";
import { cn } from "@/lib/utils";

/** Pill button that opens a searchable agent list. */
export function AgentPicker({
  agents,
  value,
  onChange,
  className,
}: {
  agents: Agent[];
  value: string | null;
  onChange: (id: string) => void;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { data: workspaces = [] } = useWorkspaces();
  const liveRuns = useLiveRunsMap();
  const running = useMemo(() => new Set(Object.values(liveRuns).flatMap((r) => (r.status === "running" ? [r.agentId] : []))), [liveRuns]);
  const current = agents.find((a) => a.id === value) ?? null;

  const wsName = (id: string | null) => (id ? (workspaces.find((w) => w.id === id)?.name ?? t("agentPicker.workspace")) : t("agentPicker.global"));
  const sorted = [...agents].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={current ? t("agentPicker.ariaChosen", { name: current.name }) : t("agentPicker.ariaChoose")}
          className={cn(
            "flex h-8 max-w-[13rem] min-w-0 items-center gap-2 rounded-lg border bg-card pr-2 pl-1 text-[13px] transition hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
            className,
          )}
        >
          {current ? (
            <AgentAvatar agent={current} size="sm" />
          ) : (
            <span className="grid size-6 place-items-center rounded-md bg-muted">
              <Bot className="size-4 text-muted-foreground" />
            </span>
          )}
          <span className="truncate font-medium @max-xs/composer:sr-only">{current?.name ?? t("agentPicker.choose")}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 overflow-hidden p-0">
        <Command>
          <CommandInput placeholder={t("agentPicker.search")} />
          <CommandList className="max-h-80">
            <CommandEmpty>{t("agentPicker.empty")}</CommandEmpty>
            <CommandGroup heading={t("agentPicker.talkTo")}>
              {sorted.map((a) => (
                <CommandItem
                  key={a.id}
                  value={`${a.name} ${a.role} ${a.description} ${a.id}`}
                  onSelect={() => {
                    onChange(a.id);
                    setOpen(false);
                  }}
                  className="gap-2.5 py-2"
                >
                  <AgentAvatar agent={a} size="sm" className="size-7" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-medium">{a.name}</span>
                      {running.has(a.id) && <span className="text-shimmer text-[10.5px] font-medium">{t("agentPicker.working")}</span>}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">{[a.role, a.description].filter(Boolean).join(" · ") || wsName(a.workspaceId)}</span>
                  </span>
                  {a.id === value && <Check className="size-4 text-foreground" />}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="__create_agent"
                onSelect={() => {
                  setOpen(false);
                  navigate("/agents/new");
                }}
              >
                <Plus /> {t("agentPicker.create")}
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
