import { useQuery } from "@tanstack/react-query";
import { Copy, FileSearch, FolderInput, MoreHorizontal, PencilLine, Trash2 } from "lucide-react";
import { chatImageUrl, formatBytes } from "@godmode/shared";
import type { Agent } from "@godmode/shared";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useCoreFileUrl } from "@/components/chat/core-file";
import { FileEditor, IMAGE_FILE, nameOf } from "./file-editor";
import { isLocked } from "./browse-pane";
import { REVEAL_LABEL } from "./use-files";

export interface DetailActions {
  onRename: (path: string) => void;
  onMove: (paths: string[]) => void;
  onDelete: (paths: string[]) => void;
  onReveal: (path: string) => void;
  onOpenFile: (path: string) => void;
  onSaved: (path: string) => void;
}

function FileMenu({ path, frozen, actions }: { path: string; frozen: boolean; actions: DetailActions }) {
  const locked = isLocked(path);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`More for ${nameOf(path)}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onSelect={() => actions.onReveal(path)}>
          <Copy /> {REVEAL_LABEL}
        </DropdownMenuItem>
        {!locked && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={frozen} onSelect={() => actions.onRename(path)}>
              <PencilLine /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem disabled={frozen} onSelect={() => actions.onMove([path])}>
              <FolderInput /> Move to…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={frozen} onSelect={() => actions.onDelete([path])}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ImageView({ agent, path, frozen, actions }: { agent: Agent; path: string; frozen: boolean; actions: DetailActions }) {
  const info = useQuery({ queryKey: ["files", agent.id, "inspect", [path]], queryFn: () => api.agents.inspectFiles(agent.id, [path]), staleTime: 30_000 });
  const entry = info.data?.[0];
  const version = entry?.modifiedAt ? Date.parse(entry.modifiedAt) : 0;
  const image = useCoreFileUrl(entry ? chatImageUrl(`${agent.repoPath}/${path}`, version) : undefined, true);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <span className="min-w-0 truncate font-mono text-[13px]">{path}</span>
        {entry && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatBytes(entry.bytes)}</span>}
        <div className="ml-auto">
          <FileMenu path={path} frozen={frozen} actions={actions} />
        </div>
      </div>
      <div className="grid min-h-0 flex-1 place-items-center overflow-auto bg-[repeating-conic-gradient(var(--color-muted)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] p-6">
        {image.src ? (
          <img src={image.src} alt={nameOf(path)} className="max-h-full max-w-full rounded-md object-contain shadow-card" />
        ) : image.failed ? (
          <p className="text-sm text-muted-foreground">This picture can't be shown here (too large or not readable).</p>
        ) : (
          <div className="h-48 w-72 animate-pulse rounded-lg bg-muted" />
        )}
      </div>
      {entry && entry.namedBy.length > 0 && <p className="border-t px-4 py-2 text-xs text-muted-foreground">Named in {entry.namedBy.join(", ")}</p>}
    </div>
  );
}

export function DetailPane({
  agent,
  file,
  dreaming,
  frozen,
  defaultView,
  onDirtyChange,
  actions,
}: {
  agent: Agent;
  file: { path: string; size: number } | null;
  dreaming: boolean;
  frozen: boolean;
  defaultView?: "edit" | "split" | "preview";
  onDirtyChange: (dirty: boolean) => void;
  actions: DetailActions;
}) {
  if (!file) {
    return (
      <div className="grid h-full place-items-center p-10 text-center">
        <div>
          <div className="mx-auto mb-3 grid size-11 place-items-center rounded-lg border bg-card shadow-card">
            <FileSearch className="size-5 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium">Pick a file to read or edit it</p>
          <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">Notes open with a preview; changes are saved into {agent.name}'s history, so they can be undone.</p>
        </div>
      </div>
    );
  }
  if (IMAGE_FILE.test(file.path)) return <ImageView key={file.path} agent={agent} path={file.path} frozen={frozen} actions={actions} />;
  return (
    <FileEditor
      key={file.path}
      agentId={agent.id}
      agentName={agent.name}
      path={file.path}
      size={file.size}
      dreaming={dreaming}
      onDirtyChange={onDirtyChange}
      onOpenFile={actions.onOpenFile}
      onSaved={actions.onSaved}
      fill
      defaultView={defaultView}
      actions={<FileMenu path={file.path} frozen={frozen} actions={actions} />}
    />
  );
}
