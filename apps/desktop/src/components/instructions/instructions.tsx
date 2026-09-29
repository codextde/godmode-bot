import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ArrowUpRight, Globe2, ScrollText } from "lucide-react";
import type { Agent } from "@godmode/shared";
import { AgentAvatar, Kbd } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { WorkspaceTile } from "@/pages/workspaces/workspace-tile";
import { modKey } from "@/lib/desktop";
import { useBootstrap, useWorkspaces } from "@/lib/hooks";
import { cn } from "@/lib/utils";

export interface InstructionLayer {
  key: "global" | "workspace" | "agent";
  label: string;
  text: string;
  icon: ReactNode;
  href: string;
}

export function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
      .find(Boolean) ?? ""
  );
}

/** Instructions an agent receives besides a chat's own, most general first. Only layers with text. */
export function useInheritedInstructions(agent: Pick<Agent, "id" | "name" | "avatar" | "color" | "instructions" | "workspaceId"> | undefined, opts?: { includeAgent?: boolean }): InstructionLayer[] {
  const { data: boot } = useBootstrap();
  const { data: workspaces } = useWorkspaces();
  const global = boot?.settings.runner.appendSystemPrompt?.trim() ?? "";
  const workspace = agent?.workspaceId ? workspaces?.find((w) => w.id === agent.workspaceId) : undefined;
  const includeAgent = opts?.includeAgent ?? true;
  return useMemo(() => {
    const layers: InstructionLayer[] = [];
    if (global)
      layers.push({
        key: "global",
        label: "Global",
        text: global,
        icon: (
          <span className="grid size-6 place-items-center rounded-md border bg-card text-muted-foreground">
            <Globe2 className="size-3.5" />
          </span>
        ),
        href: "/settings/instructions",
      });
    if (workspace?.instructions.trim())
      layers.push({
        key: "workspace",
        label: workspace.name,
        text: workspace.instructions,
        icon: <WorkspaceTile icon={workspace.icon} color={workspace.color} size="sm" />,
        href: `/workspaces?edit=${workspace.id}`,
      });
    if (includeAgent && agent?.instructions.trim())
      layers.push({ key: "agent", label: agent.name, text: agent.instructions, icon: <AgentAvatar agent={agent} size="sm" />, href: `/agents/${agent.id}/settings#instructions` });
    return layers;
  }, [global, workspace, agent, includeAgent]);
}

const LAYER_HINT: Record<InstructionLayer["key"], string> = {
  global: "Every agent",
  workspace: "Workspace",
  agent: "Agent",
};

export function InheritedInstructions({ layers, onNavigate, className }: { layers: InstructionLayer[]; onNavigate?: () => void; className?: string }) {
  return (
    <ul className={cn("space-y-0.5", className)}>
      {layers.map((l) => (
        <li key={l.key}>
          <Link
            to={l.href}
            onClick={onNavigate}
            className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
          >
            <span className="shrink-0">{l.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-1.5">
                <span className="truncate text-[13px] font-medium">{l.label}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{LAYER_HINT[l.key]}</span>
              </span>
              <span className="block truncate text-xs text-muted-foreground">{firstLine(l.text)}</span>
            </span>
            <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Composer tray button: this chat's own instructions, plus what it inherits from the agent, workspace and globally. */
export function InstructionsChip({
  value,
  agent,
  onChange,
  busy,
}: {
  value: string;
  agent?: Agent;
  onChange: (text: string) => Promise<unknown> | void;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const inherited = useInheritedInstructions(agent);
  const own = value.trim().length > 0;
  const dirty = draft.trim() !== value.trim();

  useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);

  const save = async (text: string) => {
    try {
      await onChange(text.trim());
      setOpen(false);
    } catch {
      /* the caller reports the error; keep the draft */
    }
  };

  const summary = [own && "this chat", ...inherited.map((l) => (l.key === "global" ? "every agent" : l.label))].filter(Boolean).join(" · ");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={own ? "Instructions for this chat (set)" : "Instructions for this chat"}
              className={cn(
                "flex h-8 min-w-0 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[13px] transition focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                own ? "border bg-card font-medium hover:bg-accent" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                open && !own && "bg-accent text-foreground",
              )}
            >
              {busy ? <Spinner className="size-3.5" /> : <ScrollText className={cn("size-4 shrink-0", own && "size-3.5 text-muted-foreground")} />}
              <span className="@max-md/composer:sr-only">Instructions</span>
              {own ? (
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-brand" />
              ) : (
                inherited.length > 0 && (
                  <span aria-hidden className="rounded-[4px] border bg-card px-1 font-mono text-[10px] leading-4 tabular-nums">
                    {inherited.length}
                  </span>
                )
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{summary ? `Instructions: ${summary}` : "Add instructions for this chat"}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" side="top" sideOffset={8} className="w-[min(28rem,calc(100vw-2rem))] overflow-hidden rounded-xl p-0">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty && !busy) void save(draft);
          }}
        >
          <div className="px-4 pt-4 pb-3">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <ScrollText className="size-4 text-muted-foreground" /> Instructions for this chat
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Followed on every message here. When they disagree with the agent's, workspace or global instructions, these win.
            </p>
            <Textarea
              autoFocus
              aria-label="Instructions for this chat"
              value={draft}
              maxLength={20_000}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={"e.g. Reply in German.\nWork on the feature/checkout branch and open a draft pull request."}
              className="mt-3 max-h-72 min-h-28 resize-y text-[13px] leading-relaxed"
            />
          </div>
          <div className="border-t bg-muted/40 px-2 py-2">
            {inherited.length > 0 ? (
              <>
                <p className="px-2 pt-0.5 pb-1 text-[11px] font-medium text-muted-foreground">Also applies</p>
                <InheritedInstructions layers={inherited} onNavigate={() => setOpen(false)} />
              </>
            ) : (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                Rules for every agent or a whole workspace live in{" "}
                <Link to="/settings/instructions" onClick={() => setOpen(false)} className="font-medium text-foreground underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground">
                  Settings → Instructions
                </Link>
                .
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 border-t px-3 py-2.5">
            {own && (
              <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" disabled={busy} onClick={() => void save("")}>
                Clear
              </Button>
            )}
            <span className="ml-auto hidden items-center gap-1 text-[11px] text-muted-foreground sm:flex">
              <Kbd>{modKey}</Kbd>
              <Kbd>↵</Kbd>
            </span>
            <Button type="submit" size="sm" disabled={!dirty || busy}>
              {busy && <Spinner />}
              Save
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
