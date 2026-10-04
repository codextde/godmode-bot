import { createContext, useCallback, useContext, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Copy, Download, Folder, FolderOpen, ImageOff, Maximize2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";
import type { ChatFile } from "@godmode/shared";
import { fileRefs } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDebouncedValue } from "@/components/vault/use-debounced-value";
import { copyText } from "@/components/vault/clipboard";
import { ApiRequestError, api, errorMessage } from "@/lib/api";
import { isTauri } from "@/lib/core";
import { isMac } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { fileIcon } from "./attachments";
import { downloadCoreFile, useCoreFileUrl } from "./core-file";
import { Lightbox } from "./lightbox";

/* ------------------------------------------------------------------ */
/* Which of the paths a message names exist                             */
/* ------------------------------------------------------------------ */

/**
 * The chat whose messages are shown below: the paths they name are looked up where its agent works — on the runner, for
 * a chat that lives on one.
 */
const ChatScope = createContext<{ conversationId: string | null; runnerId: string | null }>({ conversationId: null, runnerId: null });

export function ChatFilesScope({
  conversationId,
  runnerId,
  children,
}: {
  conversationId: string | null | undefined;
  /** The runner the chat works on; null or omitted = this computer. */
  runnerId?: string | null;
  children: ReactNode;
}) {
  const scope = useMemo(() => ({ conversationId: conversationId ?? null, runnerId: runnerId ?? null }), [conversationId, runnerId]);
  return <ChatScope.Provider value={scope}>{children}</ChatScope.Provider>;
}

/** A picture of a runner's chat is on the runner: the address says which one, and the core fetches it over the link. */
function onRunner(image: string, runnerId: string): string {
  return `${image}${image.includes("?") ? "&" : "?"}runner=${encodeURIComponent(runnerId)}`;
}

type Answer = { local: boolean; files: ChatFile[] };
type Ask = { refs: string[]; done: (answer: Answer) => void; fail: (err: unknown) => void };

const asks = new Map<string, Ask[]>();
let flushing: ReturnType<typeof setTimeout> | null = null;

function flush() {
  flushing = null;
  const waiting = [...asks];
  asks.clear();
  for (const [conversationId, list] of waiting) {
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      api.files.resolve(conversationId, chunk.map((a) => a.refs)).then(
        (res) => chunk.forEach((a, n) => a.done({ local: res.local, files: res.files[n] ?? [] })),
        (err) => chunk.forEach((a) => a.fail(err)),
      );
    }
  }
}

/** One request for all the messages that ask within a moment: a chat opens with many. */
function resolveFiles(conversationId: string, refs: string[]): Promise<Answer> {
  return new Promise((done, fail) => {
    asks.set(conversationId, [...(asks.get(conversationId) ?? []), { refs, done, fail }]);
    flushing ??= setTimeout(flush, 20);
  });
}

export interface MessageFiles {
  byRef: ReadonlyMap<string, ChatFile>;
  /** The pictures among them, each once. */
  pictures: ChatFile[];
  local: boolean;
}

/** The files and folders a message names that exist; null outside a chat and while nothing is found. */
export function useMessageFiles(markdown: string): MessageFiles | null {
  const { conversationId, runnerId } = useContext(ChatScope);
  const refs = useMemo(() => (conversationId ? fileRefs(markdown).join("\n") : ""), [conversationId, markdown]);
  // A message that is still being written names a longer path with every word.
  const asked = useDebouncedValue(refs, 300);
  const { data } = useQuery({
    queryKey: qk.chatFiles(conversationId ?? "", asked),
    queryFn: () => resolveFiles(conversationId!, asked.split("\n")),
    enabled: !!conversationId && asked !== "",
    staleTime: 15_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
  return useMemo(() => {
    if (!data?.files.length) return null;
    const files = runnerId ? data.files.map((f) => (f.image ? { ...f, image: onRunner(f.image, runnerId) } : f)) : data.files;
    const pictures = new Map(files.filter((f) => f.image).map((f) => [f.path, f]));
    // The runner answers for its own machine; this computer's file manager has nothing to show for its paths.
    return { byRef: new Map(files.map((f) => [f.ref, f])), pictures: [...pictures.values()], local: runnerId ? false : data.local };
  }, [data, runnerId]);
}

/* ------------------------------------------------------------------ */
/* Shown in the chat                                                    */
/* ------------------------------------------------------------------ */

const SHOW_IN_FOLDER = isMac ? "Show in Finder" : "Show in folder";

const MessageScope = createContext<{ local: boolean; preview: (path: string) => void }>({ local: false, preview: () => {} });

/** What a click on a file does: it opens the file manager there, or — from another computer — copies the path. */
function useShowInFolder(): { label: string; icon: LucideIcon; show: (file: ChatFile) => void } {
  const { local } = useContext(MessageScope);
  const show = useCallback(
    (file: ChatFile) => {
      if (!local) return void copyText(file.path, "Path copied");
      api.files.reveal(file.path).catch((err) => {
        const gone = err instanceof ApiRequestError && err.status === 404;
        toast.error(gone ? `${file.name} doesn't exist anymore` : `Couldn't open ${isMac ? "Finder" : "the file manager"}`, gone ? undefined : { description: errorMessage(err) });
      });
    },
    [local],
  );
  return local ? { label: SHOW_IN_FOLDER, icon: FolderOpen, show } : { label: "Copy path", icon: Copy, show };
}

/** Everything the files of one message share: where they are, and the preview its pictures open in. */
export function MessageFilesScope({ files, children }: { files: MessageFiles | null; children: ReactNode }) {
  const [previewed, setPreviewed] = useState<string | null>(null);
  const local = files?.local ?? false;
  const scope = useMemo(() => ({ local, preview: setPreviewed }), [local]);
  return (
    <MessageScope.Provider value={scope}>
      {children}
      {!!files?.pictures.length && <PicturePreview pictures={files.pictures} path={previewed} onChange={setPreviewed} />}
    </MessageScope.Provider>
  );
}

/** A file or folder named in a message; `chip` when it was written as code or a bare path. */
export function FileLink({ file, chip, children }: { file: ChatFile; chip?: boolean; children?: ReactNode }) {
  const { label, show } = useShowInFolder();
  const Icon = file.kind === "folder" ? Folder : fileIcon(file.image ? "image/" : "", file.name);
  // The icon stays with the first letter: a long path wraps as a whole, and must not leave its icon behind.
  const start = typeof children === "string" ? [...children][0] : undefined;
  const activate = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
    e.preventDefault();
    e.stopPropagation();
    show(file);
  };
  return (
    <span
      role="button"
      tabIndex={0}
      title={`${label} · ${file.path}`}
      className={cn("gm-file", chip && "gm-file-chip")}
      onClick={activate}
      onKeyDown={(e: KeyboardEvent) => (e.key === "Enter" || e.key === " ") && activate(e)}
    >
      {start ? (
        <>
          <span className="whitespace-nowrap">
            <Icon aria-hidden />
            {start}
          </span>
          {(children as string).slice(start.length)}
        </>
      ) : (
        <>
          <Icon aria-hidden />
          {children}
        </>
      )}
    </span>
  );
}

function TileAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={label} className="text-muted-foreground hover:text-foreground" onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** A long name is cut in the middle: its end (`…-total.png`) tells pictures apart. */
const NAME_END = 9;

/** A picture a message names, right in the chat: a click (or its button) opens the preview. */
export function Picture({ file }: { file: ChatFile }) {
  const { preview } = useContext(MessageScope);
  const { label, icon: ShowIcon, show } = useShowInFolder();
  const blob = useCoreFileUrl(file.image ?? undefined, true);
  if (blob.failed) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-dashed px-2.5 py-1.5 text-xs text-muted-foreground">
        <ImageOff className="size-3.5" /> {file.name} isn't available anymore
      </span>
    );
  }
  return (
    <span className="gm-shot inline-flex max-w-full min-w-52 flex-col overflow-hidden rounded-xl border bg-card align-top shadow-card transition-shadow hover:shadow-float">
      <button
        type="button"
        onClick={() => preview(file.path)}
        aria-label={`Preview ${file.name}`}
        className="gm-shot-image flex cursor-zoom-in justify-center bg-muted/40 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        {blob.src ? (
          <img src={blob.src} alt={file.name} className="block max-h-96 w-auto max-w-full object-contain" />
        ) : (
          <span className="block h-40 w-64 max-w-full animate-pulse bg-muted" />
        )}
      </button>
      <span className="flex min-w-0 items-center gap-1.5 border-t py-1 pr-1 pl-2.5">
        <span className="flex min-w-0 flex-1 font-mono text-[11.5px] whitespace-pre text-foreground/80" title={file.path}>
          <span className="truncate">{file.name.slice(0, -NAME_END)}</span>
          <span className="shrink-0">{file.name.slice(-NAME_END)}</span>
        </span>
        <TileAction label="Preview" onClick={() => preview(file.path)}>
          <Maximize2 />
        </TileAction>
        <TileAction label={label} onClick={() => show(file)}>
          <ShowIcon />
        </TileAction>
      </span>
    </span>
  );
}

/** The pictures of a message at full size, one at a time: ← and → step through them. */
function PicturePreview({ pictures, path, onChange }: { pictures: ChatFile[]; path: string | null; onChange: (path: string | null) => void }) {
  const { label, icon: ShowIcon, show } = useShowInFolder();
  const index = pictures.findIndex((p) => p.path === path);
  const current = pictures[index];
  // While the dialog closes, and while the next picture loads, the last one stays.
  const [file, setFile] = useState(current);
  if (current && current !== file) setFile(current);
  const blob = useCoreFileUrl(file?.image ?? undefined, true);
  const [src, setSrc] = useState<string | null>(null);
  if (blob.src && blob.src !== src) setSrc(blob.src);

  const many = pictures.length > 1;
  const step = useCallback(
    (by: number) => index >= 0 && onChange(pictures[(index + by + pictures.length) % pictures.length]!.path),
    [index, pictures, onChange],
  );
  useEffect(() => {
    if (index < 0 || !many) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, many, step]);

  if (!file) return null;
  return (
    <Lightbox
      src={src}
      alt={file.name}
      open={index >= 0}
      onOpenChange={(open) => !open && onChange(null)}
      footer={
        <div className="flex min-w-0 items-center gap-1 pl-2">
          <span className="min-w-0 truncate text-[13px] font-medium" title={file.path}>
            {file.name}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            {many && (
              <>
                <Button type="button" variant="ghost" size="icon-xs" aria-label="Previous picture" className="size-7" onClick={() => step(-1)}>
                  <ChevronLeft className="size-4" />
                </Button>
                <span className="min-w-10 text-center text-xs text-muted-foreground tabular-nums">
                  {index + 1} / {pictures.length}
                </span>
                <Button type="button" variant="ghost" size="icon-xs" aria-label="Next picture" className="mr-1 size-7" onClick={() => step(1)}>
                  <ChevronRight className="size-4" />
                </Button>
              </>
            )}
            <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 px-2.5 text-xs" onClick={() => show(file)}>
              <ShowIcon className="size-3.5" /> {label}
            </Button>
            {!isTauri && file.image && (
              <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 px-2.5 text-xs" onClick={() => void downloadCoreFile(file.image!, file.name)}>
                <Download className="size-3.5" /> Save
              </Button>
            )}
          </span>
        </div>
      }
    />
  );
}
