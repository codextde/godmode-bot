import { useEffect, useState, type FormEvent } from "react";
import { ChevronRight, Download, FolderInput, FolderSearch, Plus, Trash2, TriangleAlert } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { githubRepoOf, MOD_MANIFEST_PATH, modNameFrom, type Mod } from "@godmode/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { FolderPickerDialog } from "@/components/chat/folder-picker";
import { cn } from "@/lib/utils";
import { GitHubMark } from "./mod-parts";
import { installChoices, type ModActions } from "./use-mod-actions";

const MAX_TITLE = 80;

/** "Start from scratch": a title is all it takes; the plugin name follows from it. */
export function NewModDialog({
  open,
  onOpenChange,
  actions,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: ModActions;
  onCreated: (mod: Mod) => void;
}) {
  const { t } = useTranslation(["mods", "common"]);
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (open) setTitle("");
  }, [open]);
  const trimmed = title.trim();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!trimmed || pending) return;
    setPending(true);
    actions.create
      .mutateAsync({ title: trimmed })
      .then((mod) => {
        onOpenChange(false);
        onCreated(mod);
      })
      .catch(() => undefined)
      .finally(() => setPending(false));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader className="border-b bg-paper-2 px-6 pt-6 pb-5">
            <DialogTitle>{t("newDialog.title")}</DialogTitle>
            <DialogDescription>{t("newDialog.description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 px-6 py-5">
            <Label htmlFor="mod-new-title">{t("sheet.titleLabel")}</Label>
            <Input
              id="mod-new-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={MAX_TITLE}
              placeholder={t("newDialog.placeholder")}
              autoComplete="off"
              autoFocus
              aria-describedby="mod-new-name"
            />
            <p id="mod-new-name" className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pt-1 text-xs text-muted-foreground">
              {t("newDialog.pluginName")}
              <span className="rounded-[5px] border bg-paper-2 px-1.5 py-px font-mono text-[11.5px] text-foreground/85">{modNameFrom(title)}</span>
              <span>{t("newDialog.nameStays")}</span>
            </p>
          </div>
          <DialogFooter className="border-t bg-paper-2 px-6 py-4">
            <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" disabled={!trimmed || pending}>
              {pending ? <Spinner /> : <Plus />} {t("newDialog.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Add a Claude Code plugin folder that already lives on the computer running Godmode. */
export function ImportModDialog({
  open,
  onOpenChange,
  actions,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: ModActions;
  onImported: (mod: Mod) => void;
}) {
  const { t } = useTranslation(["mods", "common"]);
  const [path, setPath] = useState("");
  const [picking, setPicking] = useState(false);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (open) setPath("");
  }, [open]);
  const trimmed = path.trim();
  const absolute = /^(\/|~|[a-zA-Z]:[\\/])/.test(trimmed);
  const problem = trimmed && !absolute ? t("importDialog.fullPath") : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!trimmed || problem || pending) return;
    setPending(true);
    actions.importFolder
      .mutateAsync({ path: trimmed })
      .then((mod) => {
        onOpenChange(false);
        onImported(mod);
      })
      .catch(() => undefined)
      .finally(() => setPending(false));
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
        <DialogContent className="gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-lg">
          <form onSubmit={submit}>
            <DialogHeader className="border-b bg-paper-2 px-6 pt-6 pb-5">
              <DialogTitle>{t("importDialog.title")}</DialogTitle>
              <DialogDescription>
                <Trans
                  t={t}
                  i18nKey="importDialog.description"
                  values={{ manifest: MOD_MANIFEST_PATH }}
                  components={{ code: <span className="font-mono text-[12px] text-foreground/85" /> }}
                />
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5 px-6 py-5">
              <Label htmlFor="mod-import-path">{t("importDialog.pathLabel")}</Label>
              <div className="flex gap-2">
                <Input
                  id="mod-import-path"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/Users/you/plugins/my-mod"
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  autoFocus
                  aria-invalid={!!problem}
                  aria-describedby="mod-import-hint"
                  className="font-mono text-[13px] md:text-[13px]"
                />
                <Button type="button" variant="outline" onClick={() => setPicking(true)}>
                  <FolderSearch /> {t("importDialog.browse")}
                </Button>
              </div>
              <p id="mod-import-hint" className={problem ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                {problem ?? t("importDialog.hint")}
              </p>
            </div>
            <DialogFooter className="border-t bg-paper-2 px-6 py-4">
              <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
                {t("common:actions.cancel")}
              </Button>
              <Button type="submit" disabled={!trimmed || !!problem || pending}>
                {pending ? <Spinner /> : <FolderInput />} {t("importDialog.import")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <FolderPickerDialog
        open={picking}
        onOpenChange={setPicking}
        value={absolute ? trimmed : null}
        onPick={setPath}
        title={t("importDialog.pickTitle")}
        description={t("importDialog.pickDescription", { manifest: MOD_MANIFEST_PATH })}
      />
    </>
  );
}

export function DeleteModDialog({ mod, onClose, actions }: { mod: Mod | null; onClose: () => void; actions: ModActions }) {
  // Kept while the dialog closes, so its words don't change mid-animation.
  const { t } = useTranslation(["mods", "common"]);
  const [last, setLast] = useState(mod);
  if (mod && mod !== last) setLast(mod);
  const shown = mod ?? last;
  const git = !!shown?.source;
  return (
    <AlertDialog open={!!mod} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {git ? t("deleteDialog.uninstallTitle", { title: shown?.title }) : t("deleteDialog.deleteTitle", { title: shown?.title })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {git ? t("deleteDialog.descGit") : t("deleteDialog.descLocal")}
            {shown?.enabled ? ` ${t("toasts.stopsLoading")}` : ""}
            {git ? "" : ` ${t("deleteDialog.cantUndo")}`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              if (mod) actions.remove.mutate(mod);
              onClose();
            }}
          >
            <Trash2 /> {git ? t("overview.uninstall") : t("overview.deletePlugin")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Install a plugin from a git repository: "owner/repo", a GitHub link or a clone URL. */
export function InstallPluginDialog({
  open,
  onOpenChange,
  actions,
  onInstalled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: ModActions;
  onInstalled: (mod: Mod) => void;
}) {
  const { t } = useTranslation(["mods", "common"]);
  const [source, setSource] = useState("");
  const [ref, setRef] = useState("");
  const [showRef, setShowRef] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [choices, setChoices] = useState<{ name: string; description: string }[] | null>(null);
  const [plugin, setPlugin] = useState<string>("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!open) return;
    setSource("");
    setRef("");
    setShowRef(false);
    setEnabled(true);
    setChoices(null);
    setPlugin("");
  }, [open]);

  const trimmed = source.trim();
  const repo = githubRepoOf(trimmed);
  const url = /^(https?:\/\/|ssh:\/\/|git@)/.test(trimmed);
  const problem = trimmed && !repo && !url ? t("installDialog.invalid") : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!trimmed || problem || pending) return;
    setPending(true);
    actions.install
      .mutateAsync({ source: trimmed, ref: ref.trim() || undefined, plugin: plugin || undefined, enabled, label: repo ?? trimmed })
      .then((mod) => {
        onOpenChange(false);
        onInstalled(mod);
      })
      .catch((err: unknown) => {
        const found = installChoices(err);
        if (found?.length) {
          setChoices(found);
          setPlugin(found[0]!.name);
        }
      })
      .finally(() => setPending(false));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader className="flex-row items-start gap-3.5 border-b bg-paper-2 px-6 pt-6 pb-5 text-left">
            <div className="grid size-10 shrink-0 place-items-center rounded-lg border bg-card text-foreground shadow-card">
              <GitHubMark className="size-5" />
            </div>
            <div className="min-w-0 space-y-1.5">
              <DialogTitle>{t("installDialog.title")}</DialogTitle>
              <DialogDescription>{t("installDialog.description")}</DialogDescription>
            </div>
          </DialogHeader>

          <div className="space-y-5 px-6 py-5">
            <div className="space-y-1.5">
              <Label htmlFor="plugin-install-source">{t("installDialog.repository")}</Label>
              <Input
                id="plugin-install-source"
                value={source}
                onChange={(e) => {
                  setSource(e.target.value);
                  setChoices(null);
                  setPlugin("");
                }}
                placeholder="owner/repo"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                autoFocus
                disabled={pending}
                aria-invalid={!!problem}
                aria-describedby="plugin-install-hint"
                className="font-mono text-[13px] md:text-[13px]"
              />
              <p id="plugin-install-hint" className={cn("flex min-h-4 flex-wrap items-center gap-1.5 text-xs", problem ? "text-destructive" : "text-muted-foreground")}>
                {problem ??
                  (repo ? (
                    <>
                      <GitHubMark className="size-3" />
                      <span className="font-mono text-[11.5px] text-foreground/85">github.com/{repo}</span>
                    </>
                  ) : (
                    t("installDialog.hint")
                  ))}
              </p>
            </div>

            {showRef ? (
              <div className="space-y-1.5">
                <Label htmlFor="plugin-install-ref">{t("installDialog.ref")}</Label>
                <Input
                  id="plugin-install-ref"
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                  placeholder="main"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending}
                  className="font-mono text-[13px] md:text-[13px]"
                />
                <p className="text-xs text-muted-foreground">{t("installDialog.refHint")}</p>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowRef(true)}
                className="-mt-2 inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <ChevronRight className="size-3.5" aria-hidden /> {t("installDialog.followRef")}
              </button>
            )}

            {choices && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{t("installDialog.choices", { count: choices.length })}</legend>
                <RadioGroup value={plugin} onValueChange={setPlugin} className="gap-0 divide-y rounded-lg border bg-card">
                  {choices.map((c) => (
                    <label key={c.name} className="flex cursor-pointer items-start gap-3 px-3.5 py-2.5 has-[:focus-visible]:bg-accent/50">
                      <RadioGroupItem value={c.name} className="mt-0.5" />
                      <span className="min-w-0">
                        <span className="block font-mono text-[12.5px] text-foreground">{c.name}</span>
                        {c.description && <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{c.description}</span>}
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              </fieldset>
            )}

            <label className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border bg-card px-3.5 py-3">
              <span className="min-w-0">
                <span className="block text-sm font-medium">{t("installDialog.enable")}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{t("installDialog.enableHint")}</span>
              </span>
              <Switch checked={enabled} onCheckedChange={setEnabled} disabled={pending} className="mt-0.5 shrink-0" />
            </label>

            <p className="flex gap-2 text-xs leading-relaxed text-muted-foreground">
              <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
              {t("installDialog.warning")}
            </p>
          </div>

          <DialogFooter className="items-center border-t bg-paper-2 px-6 py-4 sm:justify-between">
            <p className="text-xs text-muted-foreground">{pending ? t("installDialog.pending") : ""}</p>
            <div className="flex gap-2">
              <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
                {t("common:actions.cancel")}
              </Button>
              <Button type="submit" disabled={!trimmed || !!problem || pending || (!!choices && !plugin)}>
                {pending ? <Spinner /> : <Download />} {pending ? t("featured.installing") : t("featured.install")}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
