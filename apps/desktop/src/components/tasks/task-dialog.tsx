import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Folder, FolderGit2, FolderKanban, Globe2, Maximize2, Minimize2, Paperclip, Target, X } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { Agent, Task, TaskPriority, TaskStatus, TaskType, Workspace } from "@godmode/shared";
import { MAX_TASK_TITLE_LENGTH, TASK_PRIORITIES, TASK_TYPES } from "@godmode/shared";
import { AgentAvatar, DraftStatus, Kbd } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { modKey } from "@/lib/desktop";
import { clearDraft, useDraft } from "@/lib/drafts";
import { useGoals } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { DescriptionEditor, withoutPlaceholders, type DescriptionEditorHandle, type TextUpdate } from "./description-editor";
import { DueDateField, LabelsInput, agentsInReach } from "./task-fields";
import { PRIORITY_META, PriorityIcon, STATUS_META, StatusIcon, TYPE_META, TypeIcon, sourceLabel, workspaceRepos } from "./task-meta";

const GLOBAL = "__global";
const NONE = "__none";
const OTHER_REPO = "__other";
const DRAFT = "task:new";
/** What a new task can start as: parked, or queued (its agent starts right away). */
const START_STATUSES: TaskStatus[] = ["backlog", "todo"];

interface TaskForm {
  title: string;
  description: string;
  type: TaskType;
  status: TaskStatus;
  workspaceId: string | null;
  projectId: string | null;
  agentId: string | null;
  repoChoice: string;
  repoUrl: string;
  baseBranch: string;
  priority: TaskPriority;
  dueDate: string | null;
  labels: string[];
}

/** Pill-shaped select, as in Multica's and Linear's issue composer. */
const freshForm = (_open: boolean, workspaceId: string | null, projectId: string | null, defaultStatus: TaskStatus | undefined): TaskForm => ({
  title: "",
  description: "",
  type: "general",
  status: defaultStatus && START_STATUSES.includes(defaultStatus) ? defaultStatus : "todo",
  workspaceId,
  projectId,
  agentId: null,
  repoChoice: "",
  repoUrl: "",
  baseBranch: "",
  priority: "none",
  dueDate: null,
  labels: [],
});

const PILL = "h-8 w-auto gap-1.5 rounded-full border-border/80 bg-transparent px-3 text-[13px] shadow-none hover:bg-accent/60 [&>svg:last-child]:hidden";

export function TaskDialog({
  open,
  onOpenChange,
  workspaces,
  agents,
  defaultWorkspaceId,
  defaultProjectId = null,
  defaultStatus,
  onCreated,
  parent,
  defaultGoalId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaces: Workspace[];
  agents: Agent[];
  defaultWorkspaceId: string | null;
  /** The project the board shows: the new ticket belongs to it. */
  defaultProjectId?: string | null;
  defaultStatus?: TaskStatus;
  onCreated?: (task: Task) => void;
  /** A part of this ticket (it waits for it). */
  parent?: Pick<Task, "id" | "number"> | null;
  /** The goal the new ticket serves (the board is filtered by it). */
  defaultGoalId?: string | null;
}) {
  const { t } = useTranslation(["tasks", "common"]);
  const qc = useQueryClient();
  const editor = useRef<DescriptionEditorHandle>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [another, setAnother] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Fresh on every open; a draft (what was typed before closing or leaving) wins over it.
  const base = useMemo(
    () => freshForm(open, defaultWorkspaceId, defaultProjectId, defaultStatus),
    [open, defaultWorkspaceId, defaultProjectId, defaultStatus],
  );
  // A part keeps its own draft (per ticket): it never turns up as a plain new task, or the other way round.
  const draftKey = parent ? `${DRAFT}:part:${parent.id}` : DRAFT;
  const [live, setForm, kept] = useDraft(open ? draftKey : undefined, base);
  // While the dialog animates out, keep showing what it had.
  const [closing, setClosing] = useState(live);
  if (open && closing !== live) setClosing(live);
  const form = open ? live : closing;
  const { title, description, type, status, workspaceId, agentId, repoChoice, repoUrl, baseBranch } = form;
  // Drafts saved before tickets had these fields.
  const priority = form.priority ?? "none";
  const dueDate = form.dueDate ?? null;
  const labels = form.labels ?? [];
  const set = <K extends keyof TaskForm>(key: K, value: TaskForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const setDescription = useCallback(
    (update: TextUpdate) => setForm((f) => ({ ...f, description: typeof update === "function" ? update(f.description) : update })),
    [setForm],
  );

  // The goal the board is filtered by: the new ticket serves it — in its workspace — unless the human takes it off.
  const { data: goals = [] } = useGoals("all");
  const filterGoal = !parent && defaultGoalId ? goals.find((g) => g.id === defaultGoalId) : undefined;
  const [goalOff, setGoalOff] = useState(false);
  useEffect(() => {
    if (open) setGoalOff(false);
  }, [open]);
  const applyGoalWorkspace = useEffectEvent(() => {
    if (open && filterGoal?.workspaceId && workspaceId !== filterGoal.workspaceId) set("workspaceId", filterGoal.workspaceId);
  });
  const filterGoalId = filterGoal?.id;
  // Only when the dialog opens with the goal (the human may pick another workspace afterwards).
  useEffect(() => {
    applyGoalWorkspace();
  }, [open, filterGoalId]);
  const goal = filterGoal && !goalOff && (!filterGoal.workspaceId || filterGoal.workspaceId === workspaceId) ? filterGoal : null;

  const workspace = workspaces.find((w) => w.id === workspaceId) ?? null;
  const projects = workspace?.projects ?? [];
  // Drafts saved before tickets had projects, or a project deleted since.
  const projectId = form.projectId && projects.some((p) => p.id === form.projectId) ? form.projectId : null;
  const project = projects.find((p) => p.id === projectId) ?? null;
  const repos = workspaceRepos(workspace, projectId);
  const choice = repos.length ? (repoChoice === OTHER_REPO || repos.some((r) => r.id === repoChoice) ? repoChoice : repos[0]!.id) : OTHER_REPO;
  const picked = repos.find((r) => r.id === choice);
  const chosenUrl = choice === OTHER_REPO ? repoUrl.trim() : (picked?.url ?? "");
  const reachable = useMemo(() => agentsInReach(agents, workspaceId), [agents, workspaceId]);
  const agent = reachable.find((a) => a.id === agentId);
  const needsRepo = type === "coding" && !picked && !chosenUrl;
  const starting = !!agent && status === "todo";
  const canCreate = !!title.trim() && !needsRepo && !uploading;

  const create = useMutation({
    mutationFn: () =>
      api.tasks.create({
        workspaceId,
        ...(parent ? {} : { projectId }),
        title: title.trim(),
        description: withoutPlaceholders(description),
        type,
        agentId: agent?.id ?? null,
        status,
        priority,
        dueDate,
        labels,
        ...(parent ? { parentId: parent.id } : goal ? { goalId: goal.id } : {}),
        ...(type !== "coding"
          ? {}
          : picked?.kind === "folder"
            ? { repoPath: picked.path, baseBranch: baseBranch.trim() }
            : { repoUrl: chosenUrl, baseBranch: baseBranch.trim() || picked?.branch || "" }),
      }),
    onSuccess: (task) => {
      void qc.invalidateQueries({ queryKey: qk.tasks });
      toast.success(starting ? t("dialog.onIt", { name: agent!.name }) : t("dialog.created", { number: task.number }), { description: task.title });
      if (another) {
        // Same workspace, agent and type for the next one: only the text starts over.
        setForm((f) => ({ ...f, title: "", description: "" }));
        titleRef.current?.focus();
        return;
      }
      clearDraft(draftKey);
      onOpenChange(false);
      onCreated?.(task);
    },
    onError: (e) => toastApiError(e, t("dialog.createError"), qc),
  });

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (canCreate && !create.isPending) create.mutate();
  };

  const shortcut = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  // The upload would land in a closed dialog: its file would be lost.
  const close = (next: boolean) => {
    if (!next && uploading) {
      toast(t("dialog.waitUpload"), { description: t("dialog.waitUploadDescription") });
      return;
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        showCloseButton={false}
        onKeyDown={shortcut}
        className={cn(
          "gap-0 overflow-hidden rounded-2xl p-0 transition-[max-width] duration-200",
          expanded ? "sm:max-w-5xl" : "sm:max-w-3xl",
        )}
      >
        <form onSubmit={submit} className="flex max-h-[calc(100dvh-4rem)] flex-col">
          <header className="flex items-center gap-2 px-6 pt-5 pb-1">
            <DialogTitle className="flex min-w-0 items-center gap-1.5 text-sm font-normal">
              <span className="truncate text-muted-foreground">
                {workspace ? (
                  <>
                    {workspace.icon} {workspace.name}
                  </>
                ) : (
                  t("card.global")
                )}
              </span>
              {project && (
                <>
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
                  <span className="truncate text-muted-foreground">
                    {project.icon} {project.name}
                  </span>
                </>
              )}
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
              <span className="font-medium">{parent ? t("dialog.newPart", { number: parent.number }) : t("dialog.newTask")}</span>
            </DialogTitle>
            <DialogDescription className="sr-only">{t("dialog.srDescription")}</DialogDescription>
            <div className="ml-auto flex items-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground"
                aria-label={expanded ? t("dialog.smaller") : t("dialog.larger")}
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
              </Button>
              <Button type="button" variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={t("common:actions.close")} onClick={() => close(false)}>
                <X className="size-4" />
              </Button>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-4">
            <input
              ref={titleRef}
              autoFocus
              aria-label={t("dialog.title")}
              maxLength={MAX_TASK_TITLE_LENGTH}
              placeholder={t("dialog.titlePlaceholder")}
              value={title}
              onChange={(e) => set("title", e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                  editor.current?.focus();
                }
              }}
              className="w-full bg-transparent text-2xl font-semibold tracking-[-0.02em] outline-none placeholder:text-muted-foreground/60"
            />
            <DescriptionEditor
              ref={editor}
              aria-label={t("common:words.description")}
              value={description}
              onChange={setDescription}
              onBusyChange={setUploading}
              placeholder={t("dialog.descriptionPlaceholder")}
              minHeight={expanded ? 360 : 180}
              className="mt-3"
            />

            {type === "coding" && (
              <div className="mt-4 grid gap-3 rounded-xl border bg-paper-2 p-3.5 sm:grid-cols-[1fr_11rem]">
                <div className="space-y-1.5">
                  <label htmlFor="task-repo" className="flex items-center gap-1.5 text-sm font-medium">
                    <FolderGit2 className="size-3.5 text-muted-foreground" /> {t("dialog.repository")}
                  </label>
                  {repos.length > 0 && (
                    <Select value={choice} onValueChange={(v) => set("repoChoice", v)}>
                      <SelectTrigger id="task-repo" className="w-full bg-card">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent position="popper">
                        {repos.map((r) => (
                          <SelectItem key={r.id} value={r.id}>
                            {r.kind === "folder" && <Folder className="size-3.5 text-muted-foreground" />}
                            <span className="font-mono text-[13px]">{r.kind === "folder" ? r.name : sourceLabel(r)}</span>
                            {r.branch && <span className="text-xs text-muted-foreground">{r.branch}</span>}
                          </SelectItem>
                        ))}
                        <SelectSeparator />
                        <SelectItem value={OTHER_REPO}>{t("dialog.anotherRepo")}</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                  {choice === OTHER_REPO && (
                    <Input
                      id={repos.length ? undefined : "task-repo"}
                      aria-label={t("dialog.repoUrl")}
                      placeholder="https://github.com/acme/app.git"
                      value={repoUrl}
                      onChange={(e) => set("repoUrl", e.target.value)}
                      aria-invalid={needsRepo && !!title.trim()}
                      className="bg-card font-mono text-[13px]"
                    />
                  )}
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="task-base" className="text-sm font-medium">
                    {t("dialog.baseBranch")}
                  </label>
                  <Input
                    id="task-base"
                    placeholder={picked?.branch || t("dialog.defaultBranch")}
                    value={baseBranch}
                    onChange={(e) => set("baseBranch", e.target.value)}
                    className="bg-card font-mono text-[13px]"
                  />
                </div>
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  {!repos.length ? t("dialog.repoHintWithTip") : t("dialog.repoHint")}
                </p>
              </div>
            )}
          </div>

          <div className="space-y-3 px-4 pb-4">
            {starting && (
              <p className="flex items-center gap-2 px-2 text-[13px] text-muted-foreground">
                <AgentAvatar agent={agent!} size="sm" />
                {t("dialog.willStart", { name: agent!.name })}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Pill value={status} onChange={(v) => set("status", v as TaskStatus)} label={t("fields.status")}>
                {START_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    <StatusIcon status={s} /> {STATUS_META[s].label}
                  </SelectItem>
                ))}
              </Pill>
              <Pill value={agentId && agent ? agentId : NONE} onChange={(v) => set("agentId", v === NONE ? null : v)} label={t("common:words.agent")}>
                <SelectItem value={NONE}>
                  <span className="size-4 rounded-full border border-dashed border-muted-foreground/50" /> {t("dialog.noAgent")}
                </SelectItem>
                {reachable.length > 0 && <SelectSeparator />}
                {reachable.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    <AgentAvatar agent={a} size="sm" still className="size-4" /> {a.name}
                    {!a.workspaceId && !a.isDefault && <span className="text-xs text-muted-foreground">· {t("fields.global")}</span>}
                  </SelectItem>
                ))}
              </Pill>
              <Pill value={type} onChange={(v) => set("type", v as TaskType)} label={t("fields.type")}>
                {TASK_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    <TypeIcon type={t} /> {TYPE_META[t].label}
                  </SelectItem>
                ))}
              </Pill>
              <Pill value={priority} onChange={(v) => set("priority", v as TaskPriority)} label={t("fields.priority")}>
                {TASK_PRIORITIES.map((p) => (
                  <SelectItem key={p} value={p}>
                    <PriorityIcon priority={p} /> {PRIORITY_META[p].label}
                  </SelectItem>
                ))}
              </Pill>
              <span className="flex h-8 items-center rounded-full border border-border/80 pr-1 pl-2">
                <DueDateField value={dueDate} status={status} onChange={(d) => set("dueDate", d)} />
              </span>
              {goal && (
                <span className="flex h-8 items-center gap-1.5 rounded-full border border-border/80 pr-1.5 pl-2.5 text-[13px]" title={goal.why || undefined}>
                  <Target className="size-3.5 text-brand-strong" aria-hidden />
                  <span className="max-w-44 truncate">{goal.title}</span>
                  <button type="button" className="grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={t("dialog.removeGoal", { title: goal.title })} onClick={() => setGoalOff(true)}>
                    <X className="size-3" />
                  </button>
                </span>
              )}
              {/* A part is always in its ticket's workspace. */}
              {!parent && (
                <Pill
                  value={workspaceId ?? GLOBAL}
                  label={t("dialog.workspace")}
                  onChange={(v) => {
                    const next = v === GLOBAL ? null : v;
                    setForm((f) => ({
                      ...f,
                      workspaceId: next,
                      projectId: null,
                      agentId: f.agentId && agentsInReach(agents, next).some((a) => a.id === f.agentId) ? f.agentId : null,
                    }));
                  }}
                >
                  <SelectItem value={GLOBAL}>
                    <Globe2 className="size-4" /> {t("card.global")}
                  </SelectItem>
                  {workspaces.length > 0 && <SelectSeparator />}
                  {workspaces.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      <span>{w.icon}</span> {w.name}
                    </SelectItem>
                  ))}
                </Pill>
              )}
              {!parent && projects.length > 0 && (
                <Pill value={projectId ?? NONE} label={t("dialog.project")} onChange={(v) => set("projectId", v === NONE ? null : v)}>
                  <SelectItem value={NONE}>
                    <FolderKanban className="size-4 text-muted-foreground" /> {t("dialog.noProject")}
                  </SelectItem>
                  <SelectSeparator />
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      <span>{p.icon}</span> {p.name}
                    </SelectItem>
                  ))}
                </Pill>
              )}
            </div>
            <div className="rounded-xl border border-border/80 px-2.5">
              <LabelsInput value={labels} onChange={(l) => set("labels", l)} />
            </div>
          </div>

          <footer className="flex items-center gap-3 border-t px-4 py-3">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground"
              aria-label={t("dialog.attach")}
              title={t("dialog.attachTitle")}
              onClick={() => editor.current?.pickFiles()}
            >
              <Paperclip className="size-4" />
            </Button>
            {kept.saved && <DraftStatus onDiscard={kept.discard} />}
            <label className="ml-auto flex items-center gap-2 text-[13px] text-muted-foreground">
              <Switch checked={another} onCheckedChange={setAnother} />
              {t("dialog.createAnother")}
            </label>
            <Button type="submit" disabled={!canCreate || create.isPending} className="gap-2">
              {create.isPending && <Spinner />}
              {uploading ? t("dialog.uploading") : starting ? t("dialog.createStart") : t("dialog.create")}
              <span className="hidden items-center gap-0.5 sm:flex">
                <Kbd>{modKey}</Kbd>
                <Kbd>↵</Kbd>
              </span>
            </Button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Pill({ value, onChange, label, children }: { value: string; onChange: (v: string) => void; label: string; children: ReactNode }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} size="sm" className={PILL}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        {children}
      </SelectContent>
    </Select>
  );
}
