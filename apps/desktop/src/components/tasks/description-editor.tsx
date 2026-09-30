import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Paperclip, X } from "lucide-react";
import { toast } from "sonner";
import { MAX_TASK_ATTACHMENT_BYTES, TASK_ATTACHMENT_URL, taskAttachmentMarkdown } from "@godmode/shared";
import { formatBytes, fileIcon } from "@/components/chat/attachments";
import { useCoreFileUrl } from "@/components/chat/core-file";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export type TextUpdate = string | ((prev: string) => string);

export interface DescriptionEditorHandle {
  /** Open the file picker; the picked files are uploaded and linked where the cursor is. */
  pickFiles: () => void;
  focus: () => void;
  /** Uploading, or the file picker is open: leaving the editor now isn't "done editing". */
  busy: () => boolean;
}

/** `![img.png](/api/tasks/attachments/tat_…/img.png)` and `[spec.pdf](…)` links in a description. */
const LINK = new RegExp(String.raw`(!?)\[((?:\\.|[^\]\\])*)\]\(` + `(${TASK_ATTACHMENT_URL.source})` + String.raw`\)`, "g");
const PLACEHOLDER = /\[Uploading [^\]]*…\]\(#upload-\d+\)/g;

export interface LinkedFile {
  markdown: string;
  image: boolean;
  name: string;
  url: string;
}

export function linkedFiles(markdown: string): LinkedFile[] {
  const seen = new Set<string>();
  const out: LinkedFile[] = [];
  for (const m of markdown.matchAll(LINK)) {
    if (seen.has(m[3]!)) continue;
    seen.add(m[3]!);
    out.push({ markdown: m[0], image: m[1] === "!", name: m[2]!.replace(/\\(.)/g, "$1") || "file", url: m[3]! });
  }
  return out;
}

/** Without that file's links (and the blank lines they leave). */
function unlink(markdown: string, url: string): string {
  return markdown
    .replace(LINK, (whole: string, _bang: string, _label: string, href: string) => (href === url ? "" : whole))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

let uploadSeq = 0;

/**
 * Markdown description with files: paste or drop screenshots, PDFs and other files (or pick them) — each is uploaded
 * and linked where the cursor is, like in Multica or Linear. The linked files are listed below the text.
 */
export const DescriptionEditor = forwardRef<
  DescriptionEditorHandle,
  {
    value: string;
    onChange: (update: TextUpdate) => void;
    placeholder?: string;
    autoFocus?: boolean;
    className?: string;
    /** Text size and leading of the text area. */
    textClassName?: string;
    /** Minimum height of the text area in px (it grows with the text). */
    minHeight?: number;
    onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
    onBusyChange?: (busy: boolean) => void;
    "aria-label"?: string;
  }
>(function DescriptionEditor({ value, onChange, placeholder, autoFocus, className, textClassName = "text-[15px] leading-relaxed", minHeight = 96, onKeyDown, onBusyChange, ...rest }, ref) {
  const qc = useQueryClient();
  const area = useRef<HTMLTextAreaElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const picking = useRef(false);
  const [uploads, setUploads] = useState(0);
  const [dragging, setDragging] = useState(false);
  /** Where the caret was before an upload changed the text: it stays there instead of jumping to the end. */
  const caret = useRef<{ start: number; end: number; text: string } | null>(null);
  const change = useCallback(
    (update: (prev: string) => string) => {
      const el = area.current;
      if (el && document.activeElement === el) caret.current = { start: el.selectionStart, end: el.selectionEnd, text: el.value };
      onChange(update);
    },
    [onChange],
  );

  useEffect(() => onBusyChange?.(uploads > 0), [uploads, onBusyChange]);

  // Opened to go on writing: the caret starts after the text, not before it.
  useLayoutEffect(() => {
    const el = area.current;
    if (autoFocus && el) el.setSelectionRange(el.value.length, el.value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.max(minHeight, el.scrollHeight)}px`;
    const before = caret.current;
    caret.current = null;
    if (!before || document.activeElement !== el || before.text === value) return;
    const prefix = before.text.slice(0, before.start);
    const suffix = before.text.slice(before.end);
    if (value.startsWith(prefix) && value.endsWith(suffix)) {
      // Inserted where the caret was (a new upload): continue after it.
      const at = value.length - suffix.length;
      el.setSelectionRange(at, at);
      return;
    }
    // Changed before the caret (an upload finished there): shift it; changed after it: it stays.
    const shift = value.startsWith(prefix) ? 0 : value.length - before.text.length;
    el.setSelectionRange(Math.max(0, before.start + shift), Math.max(0, before.end + shift));
  }, [value, minHeight]);

  const upload = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      const el = area.current;
      const at = el && document.activeElement === el ? el.selectionEnd : null;
      const jobs = files.map((file) => ({ file, token: `[Uploading ${file.name.replace(/[[\]]/g, "") || "file"}…](#upload-${++uploadSeq})` }));
      change((prev) => {
        const pos = at ?? prev.length;
        const before = prev.slice(0, pos);
        const after = prev.slice(pos);
        const lead = before && !before.endsWith("\n") ? "\n" : "";
        const trail = after && !after.startsWith("\n") ? "\n" : "";
        return `${before}${lead}${jobs.map((j) => j.token).join("\n")}${trail}${after}`;
      });
      for (const { file, token } of jobs) {
        if (file.size > MAX_TASK_ATTACHMENT_BYTES) {
          toast.error(`${file.name} is too large`, { description: `Files can be up to ${formatBytes(MAX_TASK_ATTACHMENT_BYTES)}.` });
          change((prev) => prev.replace(token, () => "").replace(/\n{3,}/g, "\n\n"));
          continue;
        }
        setUploads((n) => n + 1);
        api.tasks
          .upload(file)
          .then((a) => {
            // A function: `$` in file names must not act as a replacement pattern.
            const link = taskAttachmentMarkdown(a);
            change((prev) => (prev.includes(token) ? prev.replace(token, () => link) : `${prev}${prev ? "\n" : ""}${link}`));
          })
          .catch((err) => {
            change((prev) => prev.replace(token, () => "").replace(/\n{3,}/g, "\n\n"));
            toastApiError(err, `Could not attach ${file.name}`, qc);
          })
          .finally(() => setUploads((n) => n - 1));
      }
    },
    [change, qc],
  );

  useImperativeHandle(
    ref,
    () => ({
      pickFiles: () => {
        picking.current = true;
        input.current?.click();
      },
      focus: () => area.current?.focus(),
      busy: () => uploads > 0 || picking.current,
    }),
    [uploads],
  );

  // The picker closed without a choice: the window gets the focus back.
  useEffect(() => {
    const done = () => setTimeout(() => (picking.current = false), 300);
    window.addEventListener("focus", done);
    return () => window.removeEventListener("focus", done);
  }, []);

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files];
    if (!files.length) return;
    e.preventDefault();
    upload(files.map((f, i) => (f.name && f.name !== "image.png" ? f : renamed(f, i))));
  };

  const onDrop = (e: DragEvent) => {
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    e.preventDefault();
    area.current?.focus();
    upload(files);
  };

  const files = linkedFiles(value);

  return (
    <div
      className={cn("relative", className)}
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <textarea
        {...rest}
        ref={area}
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
        className={cn("block w-full resize-none bg-transparent outline-none placeholder:text-muted-foreground/70", textClassName)}
      />
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          picking.current = false;
          upload([...(e.target.files ?? [])]);
          e.target.value = "";
          area.current?.focus();
        }}
      />
      {(files.length > 0 || uploads > 0) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {files.map((f) => (
            <LinkedFileChip key={f.url} file={f} onRemove={() => change((prev) => unlink(prev, f.url))} />
          ))}
          {uploads > 0 && (
            <span className="flex h-11 items-center gap-2 rounded-xl border border-dashed px-3 text-xs text-muted-foreground">
              <Paperclip className="size-3.5 animate-pulse" /> Uploading {uploads === 1 ? "a file" : `${uploads} files`}…
            </span>
          )}
        </div>
      )}
      {dragging && (
        <div className="pointer-events-none absolute -inset-2 grid place-items-center rounded-xl border-2 border-dashed border-primary/60 bg-primary/5 text-sm font-medium text-primary">
          Drop files to attach them
        </div>
      )}
    </div>
  );
});

/** Pasted screenshots are all called image.png: give them a readable, unique name. */
function renamed(file: File, i: number): File {
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return new File([file], `screenshot-${stamp}${i ? `-${i + 1}` : ""}.${ext}`, { type: file.type });
}

function LinkedFileChip({ file, onRemove }: { file: LinkedFile; onRemove: () => void }) {
  const preview = useCoreFileUrl(file.image ? file.url : undefined);
  const Icon = fileIcon(file.image ? "image/" : "", file.name);
  return (
    <div
      // Keeps the focus in the text (clicking here isn't leaving the editor).
      onMouseDown={(e) => e.preventDefault()}
      className="group/chip relative flex max-w-60 items-center gap-2 rounded-xl border bg-background/60 py-1.5 pr-2.5 pl-1.5 shadow-xs"
    >
      {preview.src ? (
        <img src={preview.src} alt="" className="size-8 shrink-0 rounded-lg object-cover" />
      ) : (
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
      )}
      <span className="truncate text-xs font-medium">{file.name}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${file.name}`}
        className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border bg-background text-muted-foreground opacity-0 shadow-sm transition group-hover/chip:opacity-100 hover:text-foreground focus-visible:opacity-100"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

/** Placeholders of uploads that never finished (the dialog closed meanwhile): not part of a saved description. */
export function withoutPlaceholders(markdown: string): string {
  return markdown.replace(PLACEHOLDER, "").replace(/\n{3,}/g, "\n\n").trim();
}
