import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowRight, Globe, Layers, Trash2 } from "lucide-react";
import { AGENT_COLORS, MAX_INSTRUCTIONS_LENGTH, type Project, type Workspace, type WorkspaceSourceInput } from "@godmode/shared";
import { DraftStatus } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/integrations/confirm-dialog";
import { toastApiError } from "@/components/vault/vault-utils";
import { ColorRadios, ICONS, IconPicker } from "@/components/workspaces/icon-picker";
import { WorkspaceSourcesField, toSourceInput } from "@/components/workspaces/workspace-sources";
import { WorkspaceTile } from "@/components/workspaces/workspace-tile";
import { api } from "@/lib/api";
import { clearDraft, useDraft } from "@/lib/drafts";
import { qk } from "@/lib/queryKeys";
import { useUi } from "@/stores/ui";

const MAX_NAME = 60;
const WORKSPACE_DEFAULT = "__workspace";
const CONTEXT_EXAMPLE = "Shopware 6 to Shopify Plus migration for ACME.\nStaging store: acme-staging.myshopify.com\nNever publish the live theme.";

interface ProjectForm {
  name: string;
  icon: string;
  color: string;
  description: string;
  instructions: string;
  browserProfileId: string | null;
  sources: WorkspaceSourceInput[];
}

function formFrom(project: Project | null | undefined, look: { icon: string; color: string }): ProjectForm {
  return {
    name: project?.name ?? "",
    icon: project?.icon || look.icon,
    color: project?.color || look.color,
    description: project?.description ?? "",
    instructions: project?.instructions ?? "",
    browserProfileId: project?.browserProfileId ?? null,
    sources: project?.sources.map(toSourceInput) ?? [],
  };
}

function randomLook(workspace: Workspace) {
  return { icon: ICONS[Math.floor(Math.random() * ICONS.length)]!, color: workspace.color || AGENT_COLORS[0]! };
}

/** Create or edit a project of a workspace: its context, folders and repositories, and browser profile. */
export function ProjectDialog({
  open,
  onOpenChange,
  workspace,
  project,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: Workspace;
  /** Edit this project; omitted = create one in `workspace`. */
  project?: Project | null;
}) {
  const qc = useQueryClient();
  const setScope = useUi((s) => s.setWorkspace);
  const scope = useUi((s) => s.workspace);
  const scopedProject = useUi((s) => s.project);
  const editing = !!project;
  const newKey = `project:new:${workspace.id}`;
  const draftKey = project ? `project:${project.id}` : newKey;
  const [look, setLook] = useState(() => randomLook(workspace));
  const newLook = useRef(false);
  const base = useMemo(() => formFrom(project, look), [open, project?.id, look]);
  const [live, setForm, kept] = useDraft(open ? draftKey : undefined, base);
  const closing = useRef(live);
  if (open) closing.current = live;
  const form = open ? live : closing.current;
  const { name, icon, color, description, instructions, browserProfileId, sources } = form;
  const set =
    <K extends keyof ProjectForm>(key: K) =>
    (value: ProjectForm[K]) =>
      setForm((f) => ({ ...f, [key]: value }));
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (newLook.current) setLook(randomLook(workspace));
    newLook.current = false;
  }, [open]);

  const save = useMutation({
    mutationFn: (_key: string) => {
      const input = { name: name.trim(), icon, color, description: description.trim(), instructions: instructions.trim(), browserProfileId, sources };
      return project ? api.projects.update(project.id, input) : api.projects.create({ ...input, workspaceId: workspace.id });
    },
    onSuccess: (saved, key) => {
      const created = key === newKey;
      clearDraft(key);
      if (created) newLook.current = true;
      void qc.invalidateQueries({ queryKey: qk.workspaces });
      if (!created) toast.success("Project updated");
      else
        toast.success(`${saved.icon} ${saved.name} created`, {
          description: `A project in ${workspace.name}. Chats and tickets in it get its context and folders.`,
          action: { label: "Switch to it", onClick: () => setScope(workspace.id, saved.id) },
        });
      onOpenChange(false);
    },
    onError: (e) => toastApiError(e, editing ? "Could not update the project" : "Could not create the project", qc),
  });

  const remove = useMutation({
    mutationFn: () => api.projects.delete(project!.id),
    onSuccess: () => {
      clearDraft(draftKey);
      if (scope === workspace.id && scopedProject === project!.id) setScope(workspace.id);
      void qc.invalidateQueries({ queryKey: qk.workspaces });
      void qc.invalidateQueries({ queryKey: qk.conversationsAll });
      toast.success(`${project!.name} deleted`, { description: `Its chats, tickets and agents stay in ${workspace.name}.` });
      onOpenChange(false);
    },
    onError: (e) => toastApiError(e, "Could not delete the project", qc),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && !save.isPending) save.mutate(draftKey);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-xl"
        onEscapeKeyDown={(e) => {
          if (e.target instanceof Element && e.target.closest("[data-escape-local]")) e.preventDefault();
        }}
      >
        <form onSubmit={submit} className="min-w-0">
          <div className="relative overflow-hidden border-b bg-paper-2 px-6 pt-6 pb-5">
            <DialogHeader>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <WorkspaceTile icon={workspace.icon} color={workspace.color} size="sm" className="size-4.5 rounded text-[10px]" />
                <span className="truncate">{workspace.name}</span>
                <span className="opacity-40">/</span>
                <span>{editing ? "Project" : "New project"}</span>
              </div>
              <DialogTitle className="mt-1">{editing ? "Edit project" : "New project"}</DialogTitle>
              <DialogDescription>
                Projects are optional. Each one brings its own context, folders, repositories and browser on top of {workspace.name}'s.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-5 flex items-center gap-4">
              <IconPicker icon={icon} color={color} onChange={set("icon")} size="lg" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-lg font-medium tracking-[-0.02em]">{name.trim() || "Untitled project"}</p>
                <p className="line-clamp-1 text-sm text-muted-foreground">{description.trim() || "Click the icon to change it"}</p>
              </div>
            </div>
          </div>

          <div className="max-h-[min(36rem,calc(100dvh-18rem))] space-y-5 overflow-y-auto px-6 py-5">
            <div className="space-y-2">
              <Label htmlFor="project-name">Name</Label>
              <Input
                id="project-name"
                autoFocus
                required
                maxLength={MAX_NAME}
                placeholder="e.g. Shop relaunch, Phone support, Website"
                value={name}
                onChange={(e) => set("name")(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label id="project-color-label">Color</Label>
              <ColorRadios value={color} onChange={set("color")} labelledBy="project-color-label" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="project-desc">
                Description <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id="project-desc"
                rows={2}
                placeholder="What is this project about? Agents see it as context."
                value={description}
                onChange={(e) => set("description")(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <div className="space-y-0.5">
                <Label htmlFor="project-instructions">
                  Agent context <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <p className="text-xs text-muted-foreground">Given on every run in this project, after the workspace's context.</p>
              </div>
              <Textarea
                id="project-instructions"
                rows={5}
                maxLength={MAX_INSTRUCTIONS_LENGTH}
                placeholder={CONTEXT_EXAMPLE}
                value={instructions}
                onChange={(e) => set("instructions")(e.target.value)}
                className="max-h-72 min-h-28 resize-y leading-relaxed"
              />
            </div>
            <div className="space-y-2">
              <div className="space-y-0.5">
                <Label>
                  Folders &amp; repositories <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <p className="text-xs text-muted-foreground">
                  Added to every run in this project, next to the workspace's. A ticket's worktree comes from the project's first repository.
                </p>
              </div>
              <WorkspaceSourcesField workspaceId={workspace.id} projectId={project?.id ?? null} value={sources} onChange={set("sources")} />
            </div>
            <ProjectProfileField workspace={workspace} value={browserProfileId} onChange={set("browserProfileId")} />
          </div>

          <DialogFooter className="items-center border-t bg-paper-2 px-6 py-4">
            {editing && (
              <Button type="button" variant="ghost" className="mr-auto text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2 /> Delete
              </Button>
            )}
            {kept.saved && <DraftStatus onDiscard={kept.discard} className={editing ? undefined : "mr-auto"} />}
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || save.isPending}>
              {save.isPending && <Spinner />}
              {editing ? "Save changes" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
      {project && (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={`Delete ${project.name}?`}
          description={`Its chats, tickets and agents stay in ${workspace.name} without a project. Its cloned repositories move to the trash; your own folders are not touched.`}
          confirmLabel="Delete project"
          onConfirm={() => remove.mutate()}
        />
      )}
    </Dialog>
  );
}

/** A global browser profile or one of the workspace's; none = the workspace's default. Nothing moves. */
function ProjectProfileField({ workspace, value, onChange }: { workspace: Workspace; value: string | null; onChange: (id: string | null) => void }) {
  const { data: profiles } = useQuery({ queryKey: qk.browserProfiles, queryFn: api.browser.profiles, retry: false });
  if (!profiles) return null;
  const own = profiles.filter((p) => p.workspaceId === workspace.id);
  const shared = profiles.filter((p) => !p.workspaceId);
  const fallback = profiles.find((p) => p.id === workspace.browserProfileId) ?? profiles.find((p) => !p.workspaceId && p.isDefault);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="project-browser">Browser profile</Label>
        <Link to="/browser" className="flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground">
          Manage profiles <ArrowRight className="size-3" />
        </Link>
      </div>
      <Select value={value ?? WORKSPACE_DEFAULT} onValueChange={(v) => onChange(v === WORKSPACE_DEFAULT ? null : v)}>
        <SelectTrigger id="project-browser" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value={WORKSPACE_DEFAULT}>
            <Layers className="size-4" />
            Workspace default
            {fallback && <span className="text-xs text-muted-foreground">{fallback.name}</span>}
          </SelectItem>
          {own.length > 0 && (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>{workspace.name}</SelectLabel>
                {own.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <Globe className="size-4" />
                    {p.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          )}
          {shared.length > 0 && (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Global</SelectLabel>
                {shared.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <Globe className="size-4" />
                    {p.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          )}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">Runs in this project browse with this profile, unless the chat or the agent picks its own.</p>
    </div>
  );
}
