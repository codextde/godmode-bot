import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Trans, useTranslation } from "react-i18next";
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
  { icon: Globe2, labelKey: "instructions.layers.every", whereKey: "instructions.layers.everyWhere" },
  { icon: Layers, labelKey: "instructions.layers.workspace", whereKey: "instructions.layers.workspaceWhere" },
  { icon: Bot, labelKey: "instructions.layers.agent", whereKey: "instructions.layers.agentWhere" },
  { icon: MessageSquare, labelKey: "instructions.layers.chat", whereKey: "instructions.layers.chatWhere" },
] as const;

export function InstructionsSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation(["settings", "common"]);
  const { patch } = useSettingsPatch();
  const workspaces = useWorkspaces();
  const agents = useAllAgents();
  const [editing, setEditing] = useState<Workspace | null>(null);

  return (
    <div className="space-y-6">
      <SectionHeading title={t("instructions.title")} description={t("instructions.description")} />

      <div>
        <ol className="grid grid-cols-2 gap-2 @2xl:grid-cols-4">
          {LAYERS.map(({ icon: Icon, labelKey, whereKey }, i) => (
            <li key={labelKey} className="relative flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5 shadow-card">
              <span className="grid size-7 shrink-0 place-items-center rounded-md bg-paper-2 text-muted-foreground ring-1 ring-border ring-inset">
                <Icon className="size-3.5" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium">{t(labelKey)}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{t(whereKey)}</span>
              </span>
              {i < LAYERS.length - 1 && (
                <ChevronRight aria-hidden className="absolute top-1/2 -right-[13px] z-10 hidden size-4 -translate-y-1/2 text-muted-foreground/60 @2xl:block" />
              )}
            </li>
          ))}
        </ol>
        <p className="mt-2 text-xs text-muted-foreground">
          {t("instructions.precedence")}
        </p>
      </div>

      <SettingsGroup title={t("instructions.every.title")} icon={<Globe2 />} description={t("instructions.every.description")}>
        <div className="py-4">
          <CommitTextarea
            id="global-instructions"
            aria-label={t("instructions.every.label")}
            maxLength={MAX_INSTRUCTIONS_LENGTH}
            className="min-h-48 resize-y font-sans text-sm leading-relaxed"
            placeholder={t("instructions.every.example")}
            value={settings.runner.appendSystemPrompt}
            onCommit={(appendSystemPrompt) => patch({ runner: { appendSystemPrompt } })}
          />
          <p className="mt-2 text-xs text-muted-foreground">{t("instructions.every.savedHint")}</p>
        </div>
      </SettingsGroup>

      <SettingsGroup
        title={t("instructions.workspaces.title")}
        icon={<Layers />}
        description={t("instructions.workspaces.description")}
        actions={
          workspaces.data?.length ? (
            <Button variant="ghost" size="sm" asChild className="text-muted-foreground">
              <Link to="/workspaces?new=1">
                <Plus /> {t("instructions.workspaces.new")}
              </Link>
            </Button>
          ) : undefined
        }
      >
        {workspaces.isLoading ? (
          <RowSkeleton />
        ) : !workspaces.data?.length ? (
          <p className="py-4 text-sm text-muted-foreground">
            <Trans
              t={t}
              i18nKey="instructions.workspaces.empty"
              components={{ link: <Link to="/workspaces?new=1" className="font-medium text-foreground underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground" /> }}
            />
          </p>
        ) : (
          workspaces.data.map((ws) => (
            <LayerRow
              key={ws.id}
              tile={<WorkspaceTile icon={ws.icon} color={ws.color} size="md" className="size-8 rounded-lg text-base" />}
              title={ws.name}
              text={ws.instructions}
              empty={t("instructions.workspaces.noContext")}
              action={
                <Button variant="outline" size="sm" onClick={() => setEditing(ws)}>
                  {ws.instructions.trim() ? t("common:actions.edit") : t("common:actions.add")}
                </Button>
              }
            />
          ))
        )}
      </SettingsGroup>

      <SettingsGroup title={t("instructions.agents.title")} icon={<Bot />} description={t("instructions.agents.description")}>
        {agents.isLoading ? (
          <RowSkeleton />
        ) : (
          (agents.data ?? []).map((a) => (
            <LayerRow
              key={a.id}
              tile={<AgentAvatar agent={a} size="md" />}
              title={a.name}
              text={a.instructions}
              empty={t("instructions.agents.empty")}
              action={
                <Button variant="outline" size="sm" asChild>
                  <Link to={`/agents/${a.id}/settings#instructions`}>{a.instructions.trim() ? t("common:actions.edit") : t("common:actions.add")}</Link>
                </Button>
              }
            />
          ))
        )}
      </SettingsGroup>

      <div className="flex items-start gap-3 rounded-xl border border-dashed px-5 py-4">
        <MessageSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          <Trans t={t} i18nKey="instructions.oneChat" components={{ b: <span className="font-medium text-foreground" /> }} />
        </p>
      </div>

      <WorkspaceDialog open={!!editing} workspace={editing} focus="instructions" onOpenChange={(o) => !o && setEditing(null)} />
    </div>
  );
}

function LayerRow({ tile, title, text, empty, action }: { tile: ReactNode; title: string; text: string; empty: string; action: ReactNode }) {
  const { t } = useTranslation("settings");
  const set = text.trim().length > 0;
  const lines = set ? text.trim().split("\n").filter((l) => l.trim()).length : 0;
  return (
    <div className="flex items-center gap-3 py-3">
      {tile}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          {set && <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{t("instructions.lines", { count: lines })}</span>}
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
