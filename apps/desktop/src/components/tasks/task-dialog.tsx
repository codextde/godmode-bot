import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderGit2, Globe2 } from "lucide-react";
import { toast } from "sonner";
import type { Agent, Task, TaskStatus, TaskType, Workspace } from "@godmode/shared";
import { MAX_TASK_TITLE_LENGTH } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { AgentSelect, TypePicker, agentsInReach } from "./task-fields";
import { workspaceRepos } from "./task-meta";

const GLOBAL = "__global";
const OTHER_REPO = "__other";

export function TaskDialog({
  open,
  onOpenChange,
  workspaces,
  agents,
  defaultWorkspaceId,
  defaultStatus,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaces: Workspace[];
  agents: Agent[];
  defaultWorkspaceId: string | null;
  defaultStatus?: TaskStatus;
  onCreated?: (task: Task) => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<TaskType>("general");
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [start, setStart] = useState(true);
  const [repoChoice, setRepoChoice] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [baseBranch, setBaseBranch] = useState("");

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDescription("");
    setType("general");
    setWorkspaceId(defaultWorkspaceId);
    setAgentId(null);
    setStart(defaultStatus !== "backlog");
    setRepoChoice("");
    setRepoUrl("");
    setBaseBranch("");
  }, [open, defaultWorkspaceId, defaultStatus]);

  const workspace = workspaces.find((w) => w.id === workspaceId) ?? null;
  const repos = workspaceRepos(workspace);
  const choice = repos.length ? (repoChoice === OTHER_REPO || repos.some((r) => r.url === repoChoice) ? repoChoice : repos[0]!.url) : OTHER_REPO;
  const picked = repos.find((r) => r.url === choice);
  const chosenUrl = choice === OTHER_REPO ? repoUrl.trim() : choice;
  const reachable = useMemo(() => agentsInReach(agents, workspaceId), [agents, workspaceId]);
  const agent = reachable.find((a) => a.id === agentId);
  const needsRepo = type === "coding" && !chosenUrl;
  const starting = !!agent && start;

  const create = useMutation({
    mutationFn: () =>
      api.tasks.create({
        workspaceId,
        title: title.trim(),
        description: description.trim(),
        type,
        agentId,
        status: starting ? "todo" : agentId ? "backlog" : (defaultStatus ?? "backlog"),
        ...(type === "coding" ? { repoUrl: chosenUrl, baseBranch: baseBranch.trim() || picked?.branch || "" } : {}),
      }),
    onSuccess: (task) => {
      void qc.invalidateQueries({ queryKey: qk.tasks });
      toast.success(starting ? `${agent!.name} is on it` : `#${task.number} created`, { description: task.title });
      onOpenChange(false);
      onCreated?.(task);
    },
    onError: (e) => toastApiError(e, "Could not create the task", qc),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim() && !needsRepo && !create.isPending) create.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-2xl">
        <form onSubmit={submit}>
          <DialogHeader className="border-b bg-paper-2 px-6 pt-6 pb-4">
            <DialogTitle>New task</DialogTitle>
            <DialogDescription>Describe the work, pick who does it. Agents start on tasks in Todo.</DialogDescription>
          </DialogHeader>

          <div className="max-h-[min(40rem,calc(100dvh-14rem))] space-y-5 overflow-y-auto px-6 py-5">
            <div className="space-y-3">
              <Input
                autoFocus
                required
                aria-label="Title"
                maxLength={MAX_TASK_TITLE_LENGTH}
                placeholder="Title — e.g. Add dark mode to the settings page"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="h-11 text-[15px] font-medium"
              />
              <Textarea
                aria-label="Description"
                rows={5}
                placeholder="Details, acceptance criteria, links… (Markdown)"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="max-h-72 min-h-28 resize-y leading-relaxed"
              />
            </div>

            <div className="space-y-2">
              <Label>Type</Label>
              <TypePicker value={type} onChange={setType} />
            </div>

            {type === "coding" && (
              <div className="grid gap-3 rounded-xl border bg-paper-2 p-3.5 sm:grid-cols-[1fr_11rem]">
                <div className="space-y-1.5">
                  <Label htmlFor="task-repo" className="flex items-center gap-1.5">
                    <FolderGit2 className="size-3.5 text-muted-foreground" /> Repository
                  </Label>
                  {repos.length > 0 && (
                    <Select value={choice} onValueChange={setRepoChoice}>
                      <SelectTrigger id="task-repo" className="w-full bg-card">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent position="popper">
                        {repos.map((r) => (
                          <SelectItem key={r.id} value={r.url}>
                            <span className="font-mono text-[13px]">{r.name}</span>
                            {r.branch && <span className="text-xs text-muted-foreground">{r.branch}</span>}
                          </SelectItem>
                        ))}
                        <SelectSeparator />
                        <SelectItem value={OTHER_REPO}>Another repository…</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                  {choice === OTHER_REPO && (
                    <Input
                      id={repos.length ? undefined : "task-repo"}
                      aria-label="Repository URL"
                      autoFocus={repos.length > 0}
                      placeholder="https://github.com/acme/app.git"
                      value={repoUrl}
                      onChange={(e) => setRepoUrl(e.target.value)}
                      aria-invalid={needsRepo && !!title.trim()}
                      className="bg-card font-mono text-[13px]"
                    />
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="task-base">Base branch</Label>
                  <Input
                    id="task-base"
                    placeholder={picked?.branch || "default"}
                    value={baseBranch}
                    onChange={(e) => setBaseBranch(e.target.value)}
                    className="bg-card font-mono text-[13px]"
                  />
                </div>
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  {!repos.length && "Tip: add repositories to the workspace to pick them here. "}
                  Godmode clones it onto a new branch and opens a pull request when the agent is done — with your own git and GitHub CLI login.
                </p>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="task-workspace">Workspace</Label>
                <Select
                  value={workspaceId ?? GLOBAL}
                  onValueChange={(v) => {
                    const next = v === GLOBAL ? null : v;
                    setWorkspaceId(next);
                    if (agentId && !agentsInReach(agents, next).some((a) => a.id === agentId)) setAgentId(null);
                  }}
                >
                  <SelectTrigger id="task-workspace" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    <SelectItem value={GLOBAL}>
                      <Globe2 className="size-4" /> Global
                    </SelectItem>
                    {workspaces.length > 0 && <SelectSeparator />}
                    {workspaces.map((w) => (
                      <SelectItem key={w.id} value={w.id}>
                        <span>{w.icon}</span> {w.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="task-agent">Agent</Label>
                <AgentSelect id="task-agent" agents={reachable} value={agentId} onChange={setAgentId} />
              </div>
            </div>
          </div>

          <DialogFooter className="items-center border-t bg-paper-2 px-6 py-4 sm:justify-between">
            <label className="flex items-center gap-2.5 text-sm">
              <Switch checked={starting} disabled={!agent} onCheckedChange={setStart} />
              <span className={agent ? "" : "text-muted-foreground"}>
                {agent ? `Start right away` : "Assign an agent to start it"}
              </span>
            </label>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!title.trim() || needsRepo || create.isPending}>
                {create.isPending && <Spinner />}
                {starting ? "Create & start" : "Create task"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
