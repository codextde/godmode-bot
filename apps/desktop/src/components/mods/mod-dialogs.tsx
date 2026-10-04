import { useEffect, useState, type FormEvent } from "react";
import { FolderInput, FolderSearch, Plus, Trash2 } from "lucide-react";
import { MOD_MANIFEST_PATH, modNameFrom, type Mod } from "@godmode/shared";
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
import { Spinner } from "@/components/ui/spinner";
import { FolderPickerDialog } from "@/components/chat/folder-picker";
import type { ModActions } from "./use-mod-actions";

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
            <DialogTitle>New mod</DialogTitle>
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
              <span>— it stays as it is once the mod exists.</span>
            </p>
          </div>
          <DialogFooter className="border-t bg-paper-2 px-6 py-4">
            <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!trimmed || pending}>
              {pending ? <Spinner /> : <Plus />} Create mod
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
  return (
    <AlertDialog open={!!mod} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{mod?.title}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Godmode forgets the mod, its code and its saved options.
            {mod?.enabled ? " Runs stop loading it from the next message." : ""} This can't be undone.
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
            <Trash2 /> Delete mod
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
