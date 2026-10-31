import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GitMerge, GitPullRequestArrow, Wrench } from "lucide-react";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
import { hostedRepo, type LogIssue } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { useAllAgents, useSettings } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

const MAX_NOTE = 4000;
const PREVIEW = 3;

export type FixSource = { kind: "local"; issues?: LogIssue[] };

function repoName(url: string): string {
  return hostedRepo(url)?.path ?? url.replace(/^https?:\/\//, "").replace(/\.git$/, "");
}

/**
 * Hand a log to an agent as a ticket: it finds the causes in Godmode's code, fixes them and — unless switched off —
 * merges the fix into the base branch by itself.
 */
export function FixInCodeDialog({ source, onClose }: { source: FixSource | null; onClose: () => void }) {
  const { t } = useTranslation(["tasks", "common"]);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const settings = useSettings().data?.selfRepair;
  const agents = useAllAgents().data ?? [];
  const [note, setNote] = useState("");
  // null = follow the setting (it may still be loading when the dialog opens).
  const [picked, setPicked] = useState<boolean | null>(null);
  const merge = picked ?? settings?.autoMerge ?? true;
  const open = !!source;

  useEffect(() => {
    if (open) return;
    setNote("");
    setPicked(null);
  }, [open]);

  const file = useMutation({
    mutationFn: () => api.logs.fix({ note: note.trim() || undefined, autoMerge: merge }),
    onSuccess: ({ task }) => {
      void qc.invalidateQueries({ queryKey: qk.tasks });
      onClose();
      if (!task) return;
      toast.success(t("fix.filed", { number: task.number }), {
        description: merge ? t("fix.filedMerge", { branch: task.baseBranch || "main" }) : t("fix.filedReview"),
        action: { label: t("common:actions.open"), onClick: () => navigate(`/tasks?task=${task.id}`) },
      });
    },
    onError: (e) => toastApiError(e, t("fix.fileError"), qc),
  });

  if (!source) return null;
  const agent = agents.find((a) => a.id === settings?.agentId) ?? agents.find((a) => a.isDefault);
  const who = agent?.name ?? t("fix.anAgent");
  const base = settings?.baseBranch || "main";
  const noRepo = !!settings && !settings.repoUrl;
  const issues = source.issues ?? [];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!file.isPending) file.mutate();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !file.isPending && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>{t("fix.title")}</DialogTitle>
            <DialogDescription>
              {t("fix.description", { who })}
            </DialogDescription>
          </DialogHeader>

          {noRepo && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-warning/30 bg-warning/[0.07] px-3 py-2.5 text-xs">
              <p className="min-w-0 flex-1 basis-56 leading-relaxed text-muted-foreground">
                <Trans t={t} i18nKey="fix.noRepo" components={{ b: <span className="font-medium text-foreground" /> }} />
              </p>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => {
                  onClose();
                  navigate("/settings/logs");
                }}
              >
                {t("fix.openSettings")}
              </Button>
            </div>
          )}

          {issues.length > 0 && (
            <ul className="divide-y rounded-lg border bg-paper-2/50 text-xs">
              {issues.slice(0, PREVIEW).map((i) => (
                <li key={`${i.level}${i.scope}${i.msg}`} className="flex items-baseline gap-2.5 px-3 py-2">
                  <span aria-hidden className={cn("size-1.5 shrink-0 translate-y-[-1px] rounded-full", i.level === "error" ? "bg-destructive" : "bg-warning")} />
                  <span className="min-w-0 flex-1 truncate" title={i.msg}>
                    {i.msg}
                  </span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">{i.count}×</span>
                </li>
              ))}
              {issues.length > PREVIEW && <li className="px-3 py-2 text-muted-foreground">{t("fix.moreInLog", { count: issues.length - PREVIEW })}</li>}
            </ul>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="fix-note">{t("fix.noteLabel")}</Label>
            <Textarea
              id="fix-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={MAX_NOTE}
              rows={3}
              autoFocus
              placeholder={t("fix.notePlaceholder")}
              className="resize-none"
            />
          </div>

          <label htmlFor="fix-merge" className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition hover:bg-paper-2/60">
            <span className="mt-0.5 text-muted-foreground [&_svg]:size-4">{merge ? <GitMerge /> : <GitPullRequestArrow />}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{t("fix.mergeLabel", { branch: base })}</span>
              <span className="block text-xs leading-relaxed text-muted-foreground">
                {merge ? t("fix.mergeOn") : t("fix.mergeOff")}
              </span>
            </span>
            <Switch id="fix-merge" checked={merge} onCheckedChange={setPicked} className="mt-0.5" />
          </label>

          <DialogFooter className="items-center sm:justify-between">
            <span className="hidden min-w-0 truncate font-mono text-[11px] text-muted-foreground sm:block" title={settings?.repoUrl}>
              {settings?.repoUrl ? `${repoName(settings.repoUrl)} · ${base}` : ""}
            </span>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={onClose} disabled={file.isPending}>
                {t("common:actions.cancel")}
              </Button>
              <Button type="submit" disabled={file.isPending || !settings || noRepo}>
                {file.isPending ? <Spinner /> : <Wrench />}
                {file.isPending ? t("fix.filing") : t("fix.submit")}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
