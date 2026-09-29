import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Bot, ChevronRight, Globe2, Layers, MessageSquare, Plus } from "lucide-react";
import { MAX_INSTRUCTIONS_LENGTH, type Settings, type Workspace } from "@godmode/shared";
import { AgentAvatar } from "@/components/common";
import { firstLine } from "@/components/instructions/instructions";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAllAgents, useWorkspaces } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { WorkspaceDialog } from "@/components/workspaces/workspace-dialog";
import { WorkspaceTile } from "@/components/workspaces/workspace-tile";
import { CommitTextarea, SectionHeading, SettingsGroup, useSettingsPatch } from "./settings-kit";

const LAYERS = [
  { icon: Globe2, label: "Every agent", where: "Right here" },
  { icon: Layers, label: "Workspace", where: "Agent context" },
  { icon: Bot, label: "Agent", where: "Agent settings" },
  { icon: MessageSquare, label: "Chat", where: "Under the message box" },
];

const EXAMPLE = `1. Commit as me only — never add an AI co-author.
2. Keep code comments to a minimum.
3. Merge main into your branch and fix conflicts before opening a pull request.
4. For UI changes, attach screenshots of the new feature.`;

export function InstructionsSection({ settings }: { settings: Settings }) {
  const { patch } = useSettingsPatch();
  const workspaces = useWorkspaces();
  const agents = useAllAgents();
  const [editing, setEditing] = useState<Workspace | null>(null);

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Instructions"
        description="Rules your agents follow on every run. Set them once for everyone, then refine them per workspace, agent or chat."
      />

      <div>
        <ol className="grid grid-cols-2 gap-2 @2xl:grid-cols-4">
          {LAYERS.map(({ icon: Icon, label, where }, i) => (
            <li key={label} className="relative flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5 shadow-card">
              <span className="grid size-7 shrink-0 place-items-center rounded-md bg-paper-2 text-muted-foreground ring-1 ring-border ring-inset">
                <Icon className="size-3.5" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium">{label}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{where}</span>
              </span>
              {i < LAYERS.length - 1 && (
                <ChevronRight aria-hidden className="absolute top-1/2 -right-[13px] z-10 hidden size-4 -translate-y-1/2 text-muted-foreground/60 @2xl:block" />
              )}
            </li>
          ))}
        </ol>
        <p className="mt-2 text-xs text-muted-foreground">
          All of them go into every run. When two disagree, the more specific one wins — a chat beats its agent, an agent beats its workspace, a
          workspace beats every agent.
        </p>
      </div>

      <SettingsGroup title="Every agent" icon={<Globe2 />} description="Included in every run performed on your behalf.">
        <div className="py-4">
          <CommitTextarea
            id="global-instructions"
            aria-label="Instructions for every agent"
            maxLength={MAX_INSTRUCTIONS_LENGTH}
            className="min-h-48 resize-y font-sans text-sm leading-relaxed"
            placeholder={EXAMPLE}
            value={settings.runner.appendSystemPrompt}
            onCommit={(appendSystemPrompt) => patch({ runner: { appendSystemPrompt } })}
          />
          <p className="mt-2 text-xs text-muted-foreground">Saved as you type. Ongoing chats pick up changes with their next message.</p>
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Workspaces"
        icon={<Layers />}
        description="Agent context — given to every agent in a workspace on every run."
        actions={
          workspaces.data?.length ? (
            <Button variant="ghost" size="sm" asChild className="text-muted-foreground">
              <Link to="/workspaces?new=1">
                <Plus /> New
              </Link>
            </Button>
          ) : undefined
        }
      >
        {workspaces.isLoading ? (
          <RowSkeleton />
        ) : !workspaces.data?.length ? (
          <p className="py-4 text-sm text-muted-foreground">
            No workspaces yet.{" "}
            <Link to="/workspaces?new=1" className="font-medium text-foreground underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground">
              Create one
            </Link>{" "}
            to give a client or project its own agents, logins and context.
          </p>
        ) : (
          workspaces.data.map((ws) => (
            <LayerRow
              key={ws.id}
              tile={<WorkspaceTile icon={ws.icon} color={ws.color} size="md" className="size-8 rounded-lg text-base" />}
              title={ws.name}
              text={ws.instructions}
              empty="No agent context yet"
              action={
                <Button variant="outline" size="sm" onClick={() => setEditing(ws)}>
                  {ws.instructions.trim() ? "Edit" : "Add"}
                </Button>
              }
            />
          ))
        )}
      </SettingsGroup>

      <SettingsGroup title="Agents" icon={<Bot />} description="Each agent's own role and standing orders, kept in its CLAUDE.md.">
        {agents.isLoading ? (
          <RowSkeleton />
        ) : (
          (agents.data ?? []).map((a) => (
            <LayerRow
              key={a.id}
              tile={<AgentAvatar agent={a} size="md" />}
              title={a.name}
              text={a.instructions}
              empty="Works from your messages alone"
              action={
                <Button variant="outline" size="sm" asChild>
                  <Link to={`/agents/${a.id}/settings#instructions`}>{a.instructions.trim() ? "Edit" : "Add"}</Link>
                </Button>
              }
            />
          ))
        )}
      </SettingsGroup>

      <div className="flex items-start gap-3 rounded-xl border border-dashed px-5 py-4">
        <MessageSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Just one chat?</span> Use <span className="font-medium text-foreground">Instructions</span> under the
          message box. They only apply to that chat and win over everything above.
        </p>
      </div>

      <WorkspaceDialog open={!!editing} workspace={editing} focus="instructions" onOpenChange={(o) => !o && setEditing(null)} />
    </div>
  );
}

function LayerRow({ tile, title, text, empty, action }: { tile: ReactNode; title: string; text: string; empty: string; action: ReactNode }) {
  const set = text.trim().length > 0;
  const lines = set ? text.trim().split("\n").filter((l) => l.trim()).length : 0;
  return (
    <div className="flex items-center gap-3 py-3">
      {tile}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          {set && <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{lines === 1 ? "1 line" : `${lines} lines`}</span>}
        </div>
        <p className={cn("truncate text-xs", set ? "text-muted-foreground" : "text-muted-foreground/70")}>{set ? firstLine(text) : empty}</p>
      </div>
      {action}
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="space-y-3 py-3">
      {[0, 1].map((i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-10 rounded-lg" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-56" />
          </div>
        </div>
      ))}
    </div>
  );
}
