import { useEffect, useRef, type Ref } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import type { SlashCommand } from "@godmode/shared";
import { parseSlashCommand } from "@godmode/shared";
import { Loader2, SquareSlash } from "lucide-react";
import { Kbd } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

export function useSlashCommands(agentId: string | undefined) {
  return useQuery({
    queryKey: qk.agentCommands(agentId ?? ""),
    queryFn: () => api.agents.commands(agentId!),
    enabled: !!agentId,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

/** Custom commands first, then Claude Code's; with a query: best name match first. */
export function rankCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return [...commands].sort((a, b) => Number(a.builtin) - Number(b.builtin) || a.name.localeCompare(b.name));
  const score = (c: SlashCommand) => {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    if (c.aliases.some((a) => a.toLowerCase().startsWith(q))) return 1;
    if (name.includes(q)) return 2;
    if (q.length > 2 && c.description.toLowerCase().includes(q)) return 3;
    return -1;
  };
  return commands
    .map((c) => ({ c, s: score(c) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.c.name.length - b.c.name.length || a.c.name.localeCompare(b.c.name))
    .map((x) => x.c);
}

export function findCommand(commands: SlashCommand[] | undefined, name: string): SlashCommand | undefined {
  return commands?.find((c) => c.name === name || c.aliases.includes(name));
}

export const slashOptionId = (menuId: string, name: string) => `${menuId}-${name.replace(/[^\w-]/g, "_")}`;

export function SlashMenu({
  id,
  items,
  active,
  grouped,
  loading,
  error,
  below,
  maxHeight,
  onHover,
  onPick,
  ref,
}: {
  id: string;
  items: SlashCommand[];
  active: number;
  grouped: boolean;
  loading: boolean;
  error: unknown;
  /** Open under the composer (not enough room above it) */
  below: boolean;
  maxHeight: number;
  onHover: (index: number) => void;
  onPick: (command: SlashCommand) => void;
  ref?: Ref<HTMLDivElement>;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, items]);

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: below ? -4 : 4, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: below ? -4 : 4, scale: 0.99 }}
      transition={{ duration: 0.14, ease: [0.2, 0.8, 0.2, 1] }}
      className={cn(
        "absolute inset-x-0 z-30 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-float",
        below ? "top-full mt-2 origin-top" : "bottom-full mb-2 origin-bottom",
      )}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div ref={listRef} id={id} role="listbox" aria-label="Slash commands" style={{ maxHeight }} className="overflow-y-auto p-1.5">
        {items.map((c, i) => {
          const header = grouped && (i === 0 || items[i - 1]!.builtin !== c.builtin);
          return (
            <div key={c.name}>
              {header && <div className="eyebrow px-2.5 pt-2 pb-1 text-[10px]">{c.builtin ? "Claude Code" : "This agent"}</div>}
              <div
                id={slashOptionId(id, c.name)}
                role="option"
                aria-selected={i === active}
                data-active={i === active}
                onMouseMove={() => i !== active && onHover(i)}
                onClick={() => onPick(c)}
                className={cn(
                  "flex h-9 cursor-pointer items-center gap-3 rounded-lg px-2.5 text-[13px] transition-colors",
                  i === active ? "bg-accent text-foreground" : "text-foreground/90",
                )}
              >
                <span className="shrink-0 font-mono font-medium">/{c.name}</span>
                {c.argumentHint && <span className="max-w-[38%] shrink-0 truncate font-mono text-[12px] text-muted-foreground/75">{c.argumentHint}</span>}
                <span className="min-w-0 flex-1 truncate text-muted-foreground" title={c.description}>
                  {c.description}
                </span>
              </div>
            </div>
          );
        })}
        {items.length === 0 && (
          <div className="flex h-9 items-center gap-2 px-2.5 text-[13px] text-muted-foreground">
            {loading ? (
              <>
                <Loader2 className="size-3.5 animate-spin" /> Loading Claude Code commands…
              </>
            ) : error ? (
              <span className="truncate">Couldn't load commands — {errorMessage(error)}</span>
            ) : (
              "No matching command — it will be sent as a message."
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> navigate
        </span>
        <span className="flex items-center gap-1">
          <Kbd>tab</Kbd> complete
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Kbd>esc</Kbd> close
        </span>
      </div>
    </motion.div>
  );
}

/** Slim strip above the textarea once a known command is typed: what it does and which arguments it takes. */
export function SlashHint({ command }: { command: SlashCommand }) {
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      className="overflow-hidden"
    >
      <div className="flex min-w-0 items-center gap-2 px-4 pt-3 text-[12px] text-muted-foreground">
        <SquareSlash className="size-3.5 shrink-0" />
        <span className="shrink-0 font-mono font-medium text-foreground">/{command.name}</span>
        {command.argumentHint && <span className="max-w-[45%] shrink-0 truncate font-mono">{command.argumentHint}</span>}
        <span className="min-w-0 truncate" title={command.description}>
          {command.description}
        </span>
      </div>
    </motion.div>
  );
}

/** Message text with a leading `/command` shown as a token. */
export function CommandText({ text }: { text: string }) {
  const cmd = parseSlashCommand(text);
  if (!cmd) return <>{text}</>;
  return (
    <>
      <span className="mr-1.5 inline-flex translate-y-[-1px] rounded-md bg-foreground/[0.07] px-1.5 py-px font-mono text-[0.85em] font-medium">
        /{cmd.name}
      </span>
      {cmd.args}
    </>
  );
}
