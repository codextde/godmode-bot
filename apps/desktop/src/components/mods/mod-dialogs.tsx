import { useEffect, useState, type FormEvent } from "react";
import { ChevronRight, Download, FolderInput, FolderSearch, Plus, Trash2, TriangleAlert } from "lucide-react";
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
            <DialogTitle>New plugin</DialogTitle>
            <DialogDescription>Give it a title. Its code opens next.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 px-6 py-5">
            <Label htmlFor="mod-new-title">Title</Label>
            <Input
              id="mod-new-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={MAX_TITLE}
              placeholder="Protect .env files"
              autoComplete="off"
              autoFocus
              aria-describedby="mod-new-name"
            />
            <p id="mod-new-name" className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pt-1 text-xs text-muted-foreground">
              Plugin name
              <span className="rounded-[5px] border bg-paper-2 px-1.5 py-px font-mono text-[11.5px] text-foreground/85">{modNameFrom(title)}</span>
              <span>— it stays as it is once the plugin exists.</span>
            </p>
          </div>
          <DialogFooter className="border-t bg-paper-2 px-6 py-4">
            <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!trimmed || pending}>
              {pending ? <Spinner /> : <Plus />} Create plugin
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
  const [path, setPath] = useState("");
  const [picking, setPicking] = useState(false);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (open) setPath("");
  }, [open]);
  const trimmed = path.trim();
  const absolute = /^(\/|~|[a-zA-Z]:[\\/])/.test(trimmed);
  const problem = trimmed && !absolute ? "Enter the full path, starting at the root or with ~." : null;

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
              <DialogTitle>Import a plugin folder</DialogTitle>
              <DialogDescription>
                A Claude Code plugin on the computer running Godmode — the folder that holds <span className="font-mono text-[12px] text-foreground/85">{MOD_MANIFEST_PATH}</span>.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5 px-6 py-5">
              <Label htmlFor="mod-import-path">Folder path</Label>
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
                  <FolderSearch /> Browse
                </Button>
              </div>
              <p id="mod-import-hint" className={problem ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                {problem ?? "The absolute path on that computer. Godmode copies the plugin's files and checks them; the folder itself stays as it is."}
              </p>
            </div>
            <DialogFooter className="border-t bg-paper-2 px-6 py-4">
              <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!trimmed || !!problem || pending}>
                {pending ? <Spinner /> : <FolderInput />} Import
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
        title="Pick the plugin folder"
        description={`The folder that holds ${MOD_MANIFEST_PATH}, on the computer running Godmode.`}
      />
    </>
  );
}

export function DeleteModDialog({ mod, onClose, actions }: { mod: Mod | null; onClose: () => void; actions: ModActions }) {
  // Kept while the dialog closes, so its words don't change mid-animation.
  const [last, setLast] = useState(mod);
  if (mod && mod !== last) setLast(mod);
  const shown = mod ?? last;
  const git = !!shown?.source;
  return (
    <AlertDialog open={!!mod} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {git ? "Uninstall" : "Delete"} “{shown?.title}”?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {git
              ? "Godmode removes the plugin, its downloaded files and its saved options. You can install it again any time."
              : "Godmode forgets the plugin, its code and its saved options."}
            {shown?.enabled ? " Runs stop loading it from the next message." : ""}
            {git ? "" : " This can't be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              if (mod) actions.remove.mutate(mod);
              onClose();
            }}
          >
            <Trash2 /> {git ? "Uninstall" : "Delete plugin"}
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
  const problem = trimmed && !repo && !url ? "Enter owner/repo, a GitHub link or a clone URL." : null;

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
              <DialogTitle>Install from GitHub</DialogTitle>
              <DialogDescription>Any Claude Code plugin in a git repository: skills, subagents, commands, hooks and MCP servers. Godmode downloads it, checks it and keeps it up to date.</DialogDescription>
            </div>
          </DialogHeader>

          <div className="space-y-5 px-6 py-5">
            <div className="space-y-1.5">
              <Label htmlFor="plugin-install-source">Repository</Label>
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
                    "owner/repo, a GitHub link (also to a folder) or a clone URL."
                  ))}
              </p>
            </div>

            {showRef ? (
              <div className="space-y-1.5">
                <Label htmlFor="plugin-install-ref">Branch or tag</Label>
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
                <p className="text-xs text-muted-foreground">Updates follow it. Empty: the repository's default branch.</p>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowRef(true)}
                className="-mt-2 inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <ChevronRight className="size-3.5" aria-hidden /> Follow a branch or tag
              </button>
            )}

            {choices && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">This repository has {choices.length} plugins</legend>
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
                <span className="block text-sm font-medium">Switch it on after installing</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">It loads into every agent's runs from the next message. Choose who runs it on its page.</span>
              </span>
              <Switch checked={enabled} onCheckedChange={setEnabled} disabled={pending} className="mt-0.5 shrink-0" />
            </label>

            <p className="flex gap-2 text-xs leading-relaxed text-muted-foreground">
              <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
              Plugins work with your agents' access, and their hooks and servers start programs on this computer. Install the ones you trust.
            </p>
          </div>

          <DialogFooter className="items-center border-t bg-paper-2 px-6 py-4 sm:justify-between">
            <p className="text-xs text-muted-foreground">{pending ? "Downloading and checking…" : ""}</p>
            <div className="flex gap-2">
              <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!trimmed || !!problem || pending || (!!choices && !plugin)}>
                {pending ? <Spinner /> : <Download />} {pending ? "Installing…" : "Install"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
