import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { EditorContent, Node, NodeViewWrapper, ReactNodeViewRenderer, mergeAttributes, useEditor, useEditorState, type Editor, type JSONContent, type NodeViewProps } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import HardBreak from "@tiptap/extension-hard-break";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { TableKit } from "@tiptap/extension-table";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import {
  Bold,
  Code,
  Heading2,
  ImageOff,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Paperclip,
  Quote,
  SquareCode,
  Strikethrough,
  X,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { MAX_TASK_ATTACHMENT_BYTES } from "@godmode/shared";
import { fileIcon, formatBytes } from "@/components/chat/attachments";
import { downloadCoreFile, isCoreFile, useCoreFileUrl } from "@/components/chat/core-file";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { modKey } from "@/lib/desktop";
import { cn } from "@/lib/utils";

export type TextUpdate = string | ((prev: string) => string);

export interface DescriptionEditorHandle {
  /** Open the file picker; the picked files are uploaded and placed where the cursor is. */
  pickFiles: () => void;
  focus: () => void;
  /** Uploading, or the file picker is open: leaving the editor now isn't "done editing". */
  busy: () => boolean;
  /** Files on their way up (they land in the text when done). */
  uploading: () => boolean;
}

/** Markdown labels: `]` and `\` would end or escape them. */
const label = (name: string) => name.replace(/[[\]\\]/g, "\\$&");

/** A task attachment that isn't an image (PDF, archive…): a chip in the text, `[spec.pdf](/api/tasks/attachments/…)` in the Markdown. */
const FileChip = Node.create({
  name: "fileChip",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes: () => ({ href: { default: "" }, name: { default: "file" } }),
  parseHTML: () => [{ tag: "span[data-file-chip]", getAttrs: (el) => ({ href: el.getAttribute("data-href"), name: el.textContent }) }],
  renderHTML: ({ node, HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { "data-file-chip": "", "data-href": node.attrs.href }), node.attrs.name],
  renderMarkdown: (node) => `[${label(node.attrs?.name ?? "file")}](${node.attrs?.href ?? ""})`,
  addNodeView: () => ReactNodeViewRenderer(FileChipView, { as: "span" }),
  addProseMirrorPlugins() {
    const type = this.type;
    // Markdown brings task attachments in as plain links: they become chips (on load, paste, undo…).
    return [
      new Plugin({
        key: new PluginKey("fileChips"),
        appendTransaction: (trs, _old, state) => {
          if (!trs.some((t) => t.docChanged)) return null;
          const found: { from: number; to: number; href: string; text: string }[] = [];
          state.doc.descendants((node, pos) => {
            if (!node.isText) return;
            const href = node.marks.find((m) => m.type.name === "link")?.attrs.href as string | undefined;
            if (!href || !isCoreFile(href)) return;
            const last = found.at(-1);
            if (last && last.href === href && last.to === pos) {
              last.to = pos + node.nodeSize;
              last.text += node.text;
            } else found.push({ from: pos, to: pos + node.nodeSize, href, text: node.text ?? "" });
          });
          if (!found.length) return null;
          const tr = state.tr;
          for (const f of found.reverse()) tr.replaceWith(f.from, f.to, type.create({ href: f.href, name: f.text || "file" }));
          return tr;
        },
      }),
    ];
  },
});

/** A file on its way up: shown where it will land, left out of the Markdown. */
const Uploading = Node.create({
  name: "uploading",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addAttributes: () => ({ id: { default: "" }, name: { default: "file" }, preview: { default: null } }),
  parseHTML: () => [],
  renderHTML: ({ node }) => ["span", { "data-uploading": "" }, node.attrs.name],
  renderMarkdown: () => "",
  addNodeView: () => ReactNodeViewRenderer(UploadingView, { as: "span" }),
});

/** Images of task attachments need the app's login: fetched, not linked (see core-file.tsx). */
const TaskImage = Image.extend({
  draggable: true,
  addAttributes() {
    return { ...this.parent?.(), src: { default: null, parseHTML: (el) => el.getAttribute("src") ?? el.getAttribute("data-src") } };
  },
  parseHTML() {
    return [...(this.parent?.() ?? []), { tag: "img[data-src]" }];
  },
  // The plain <img> (before the view mounts, when it unmounts, on copy) must not load it without the login.
  renderHTML({ HTMLAttributes: { src, ...rest } }) {
    return ["img", mergeAttributes(rest, isCoreFile(src) ? { "data-src": src } : { src })];
  },
  renderMarkdown: (node) => {
    const title = node.attrs?.title as string | undefined;
    return `![${label(node.attrs?.alt ?? "")}](${node.attrs?.src ?? ""}${title ? ` "${title.replace(/"/g, '\\"')}"` : ""})`;
  },
  addNodeView: () => ReactNodeViewRenderer(ImageView, { as: "span" }),
}).configure({ inline: true });

/** A bare URL stays one (`https://…`), not `[https://…](https://…)`. */
const TaskLink = Link.extend({
  renderMarkdown(node, h, ctx) {
    const href = (node.attrs?.href as string | undefined) ?? "";
    const title = node.attrs?.title as string | undefined;
    // Marks render around a placeholder; the linked text itself comes in the context.
    const shown = (ctx?.meta as { markText?: string } | undefined)?.markText;
    // As is: its text would come out escaped (`a\_b`), and that would end up in the link on the next load.
    if (shown === href && !title && /^https?:\/\/\S+$/.test(href)) return href;
    return `[${h.renderChildren(node)}](${href}${title ? ` "${title}"` : ""})`;
  },
}).configure({ openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { rel: "noreferrer noopener", target: null } });

/** A line break is just a new line: descriptions keep every line break as typed (Markdown `breaks`). */
const PlainBreak = HardBreak.extend({ renderMarkdown: () => "\n" });

let uploadSeq = 0;

/**
 * The task description, as you'll read it: headings, lists, checklists and code render while you type (Markdown
 * shortcuts work too), and screenshots, PDFs and other files pasted, dropped or picked land where the cursor is, like in
 * Linear, Multica or Trello. Stored as Markdown — that's what the agent reads.
 */
export const DescriptionEditor = forwardRef<
  DescriptionEditorHandle,
  {
    /** Markdown. */
    value: string;
    onChange: (markdown: string) => void;
    placeholder?: string;
    autoFocus?: boolean;
    className?: string;
    /** Text size and leading. */
    textClassName?: string;
    /** Minimum height of the text in px (it grows with the text). */
    minHeight?: number;
    /** Formatting buttons above the text (and Attach); without them, Markdown shortcuts and ⌘B/⌘I still work. */
    toolbar?: boolean;
    onBusyChange?: (busy: boolean) => void;
    "aria-label"?: string;
  }
>(function DescriptionEditor(
  { value, onChange, placeholder, autoFocus, className, textClassName = "text-[15px]", minHeight = 96, toolbar, onBusyChange, "aria-label": ariaLabel },
  ref,
) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const picking = useRef(false);
  const [uploads, setUploads] = useState(0);
  /** The same, right away (the state lags a render): an edit must not end with an upload just started. */
  const pending = useRef(0);
  const [dragging, setDragging] = useState(false);
  /** What the editor last reported: a value that differs came from outside (reset, draft) and replaces the text. */
  const emitted = useRef(value);
  // The editor is set up once: its handlers read the latest props through these.
  const props = useRef({ onChange, qc });
  props.current = { onChange, qc };
  const uploadRef = useRef<(files: File[], at?: number) => void>(() => {});

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        underline: false, // no Markdown for it
        link: false,
        hardBreak: false,
      }),
      PlainBreak,
      TaskLink,
      // Not in the toolbar, but a description (an agent's, say) may have them: they must survive an edit.
      TableKit.configure({ table: { resizable: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TaskImage,
      FileChip,
      Uploading,
      Placeholder.configure({ placeholder: placeholder ?? "" }),
      // Every line break is kept, as typed (and as the description shows them).
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
    ],
    onCreate: ({ editor }) => {
      escapeLess(editor);
      load(editor, value);
      if (autoFocus) editor.commands.focus("end");
    },
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { "aria-label": ariaLabel ?? "Description", "aria-multiline": "true", role: "textbox", class: cn("gm-editor prose-chat", textClassName) },
      // ⌘↵ is the form's (save, create; it bubbles up to it) — not a line break.
      handleKeyDown: (_view, e) => e.key === "Enter" && (e.metaKey || e.ctrlKey),
      handlePaste: (view, e) => {
        const files = [...(e.clipboardData?.files ?? [])];
        if (!files.length) return false;
        uploadRef.current(files.map((f, i) => (f.name && f.name !== "image.png" ? f : renamed(f, i))), view.state.selection.from);
        return true;
      },
      handleDrop: (view, e, _slice, moved) => {
        setDragging(false);
        const files = [...(e.dataTransfer?.files ?? [])];
        if (moved || !files.length) return false;
        const at = view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos;
        uploadRef.current(files, at);
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      const md = markdownOf(editor);
      if (md === emitted.current) return;
      emitted.current = md;
      props.current.onChange(md);
    },
  });

  // Changed from outside (reset after "create another", a draft coming back): show it.
  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    load(editor, value);
  }, [value, editor]);

  useEffect(() => onBusyChange?.(uploads > 0), [uploads, onBusyChange]);

  uploadRef.current = (files, at) => {
    if (!files.length) return;
    for (const file of files) {
      if (file.size > MAX_TASK_ATTACHMENT_BYTES) {
        toast.error(`${file.name} is too large`, { description: `Files can be up to ${formatBytes(MAX_TASK_ATTACHMENT_BYTES)}.` });
        continue;
      }
      const id = `upload-${++uploadSeq}`;
      const image = file.type.startsWith("image/");
      const preview = image ? URL.createObjectURL(file) : null;
      const node = { type: "uploading", attrs: { id, name: file.name || "file", preview } };
      const pos = at ?? editor.state.selection.from;
      const $pos = editor.state.doc.resolve(Math.min(pos, editor.state.doc.content.size));
      // An image gets a line of its own; a file chip goes where the cursor is.
      const own = image && $pos.parent.isTextblock && $pos.parent.content.size > 0;
      // A file right after an image goes on the next line, not glued to it.
      const before = $pos.nodeBefore;
      const afterImage = before?.type.name === "image" || (before?.type.name === "uploading" && !!before.attrs.preview);
      editor
        .chain()
        .focus()
        // Not an undo step: undoing it would drop the file when it lands (remove a file with its ×).
        .setMeta("addToHistory", false)
        .insertContentAt(
          pos,
          image
            ? own
              ? { type: "paragraph", content: [node] }
              : [node]
            : [...(afterImage ? [{ type: "hardBreak" }] : []), node, { type: "text", text: " " }],
        )
        .run();
      // Where it can't go (a code block, say): at the end.
      if (!findUpload(editor, id)) {
        editor
          .chain()
          .setMeta("addToHistory", false)
          .insertContentAt(editor.state.doc.content.size, { type: "paragraph", content: [node] })
          .run();
      }
      at = undefined; // the next one goes after this one
      pending.current++;
      setUploads((n) => n + 1);
      api.tasks
        .upload(file)
        .then((a) => {
          const done = a.mime.startsWith("image/")
            ? editor.schema.nodes.image!.create({ src: a.url, alt: a.name })
            : editor.schema.nodes.fileChip!.create({ href: a.url, name: a.name });
          replaceUpload(editor, id, done);
        })
        .catch((err) => {
          replaceUpload(editor, id, null);
          toastApiError(err, `Could not attach ${file.name}`, props.current.qc);
        })
        .finally(() => {
          if (preview) URL.revokeObjectURL(preview);
          pending.current--;
          setUploads((n) => n - 1);
        });
    }
  };

  useImperativeHandle(
    ref,
    () => ({
      pickFiles: () => {
        picking.current = true;
        input.current?.click();
      },
      focus: () => editor.commands.focus("end"),
      busy: () => pending.current > 0 || picking.current,
      uploading: () => pending.current > 0,
    }),
    [editor],
  );

  // The picker closed without a choice: the window gets the focus back.
  useEffect(() => {
    const done = () => setTimeout(() => (picking.current = false), 300);
    window.addEventListener("focus", done);
    return () => window.removeEventListener("focus", done);
  }, []);

  const pickFiles = () => {
    picking.current = true;
    input.current?.click();
  };

  return (
    <div
      className={cn("relative", className)}
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        // Dropped next to the text (not on it): the files go at the end.
        setDragging(false);
        if (e.defaultPrevented || !e.dataTransfer.files.length) return;
        e.preventDefault();
        uploadRef.current([...e.dataTransfer.files], editor.state.doc.content.size);
      }}
    >
      {toolbar && <Toolbar editor={editor} onAttach={pickFiles} />}
      <EditorContent
        editor={editor}
        className="cursor-text"
        style={{ ["--gm-editor-min" as string]: `${minHeight}px` }}
        onClick={(e) => {
          // A click under the last line still puts the cursor in the text.
          if (e.target === e.currentTarget) editor.commands.focus("end");
        }}
      />
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          picking.current = false;
          uploadRef.current([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
      {dragging && (
        <div className="pointer-events-none absolute -inset-1 grid place-items-center rounded-xl border-2 border-dashed border-primary/50 bg-background/80 text-sm font-medium text-foreground backdrop-blur-[1px]">
          <span className="flex items-center gap-2">
            <Paperclip className="size-4" /> Drop to attach
          </span>
        </div>
      )}
    </div>
  );
});

/** Shows `markdown` (not an undo step, not a change). */
function load(editor: Editor, markdown: string) {
  editor.chain().setMeta("addToHistory", false).setContent(contentOf(editor, markdown), { emitUpdate: false }).run();
}

/**
 * Markdown → the editor's content. The parser lifts a picture that's alone on its line out of its paragraph — images
 * are inline here (next to text, like in the Markdown), so it goes back into one; otherwise the document is invalid.
 */
function contentOf(editor: Editor, markdown: string): JSONContent {
  const { schema } = editor;
  const fix = (node: JSONContent): JSONContent => {
    if (!node.content) return node;
    const type = node.type ? schema.nodes[node.type] : undefined;
    const children = node.content.map(fix);
    if (!type || type.inlineContent) return { ...node, content: children };
    const content: JSONContent[] = [];
    for (const child of children) {
      if (!child.type || !schema.nodes[child.type]?.isInline) content.push(child);
      else if (content.at(-1)?.type === "paragraph" && content.at(-1)!.loose) content.at(-1)!.content!.push(child);
      else content.push({ type: "paragraph", content: [child], loose: true } as JSONContent);
    }
    return { ...node, content: content.map(({ loose: _, ...n }) => n) };
  };
  const doc = fix(editor.markdown!.parse(markdown));
  return doc.content?.length ? doc : { type: "doc", content: [{ type: "paragraph" }] };
}

function markdownOf(editor: Editor): string {
  // Outside code: empty paragraphs (`&nbsp;`) and runs of blank lines go. Code is left exactly as written.
  const out: string[] = [];
  let fence: string | null = null;
  let blank = 0;
  for (const line of editor.getMarkdown().split("\n")) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      out.push(line);
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = null;
      continue;
    }
    if (mark) fence = mark;
    const text = line.trim() === "&nbsp;" ? "" : line;
    if (text.trim()) blank = 0;
    else if (++blank > 1) continue;
    out.push(text.trim() ? text : "");
  }
  return out.join("\n").trim();
}

/**
 * The stored Markdown is what the agent reads: `user_service.py`, not `user\_service.py`; `a & b`, not `a &amp; b`.
 * Only what would turn into formatting on the next load is escaped (TipTap escapes every `_*[]~` and `&<>`).
 */
function escapeLess(editor: Editor) {
  const md = editor.markdown as unknown as {
    codeTypes: Set<string>;
    encodeTextForMarkdown: (text: string, node: JSONContent, parent?: JSONContent) => string;
  };
  md.encodeTextForMarkdown = (text, node, parent) => {
    const inCode = (parent?.type && md.codeTypes.has(parent.type)) || (node.marks ?? []).some((m) => md.codeTypes.has(typeof m === "string" ? m : m.type));
    return inCode ? text : escapeText(text);
  };
}

const PUNCT = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;

export function escapeText(text: string): string {
  const tildes = (text.match(/~/g) ?? []).length;
  // At the start (of a line, maybe): what would make it a heading, list item or quote.
  const lead = /^(#{1,6}|[-+*]|>)(\s|$)/.test(text) ? 0 : /^\d+[.)](\s|$)/.test(text) ? text.search(/[.)]/) : -1;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const prev = text[i - 1] ?? " ";
    const next = text[i + 1] ?? " ";
    const spaced = /\s/.test(prev) && /\s/.test(next);
    if (i === lead) out += `\\${c}`;
    else if (c === "\\") out += PUNCT.test(next) ? "\\\\" : c;
    else if (c === "`") out += "\\`";
    else if (c === "*") out += spaced ? c : "\\*";
    // Inside a word (snake_case) it's never emphasis.
    else if (c === "_") out += spaced || (WORD.test(prev) && WORD.test(next)) ? c : "\\_";
    else if (c === "~") out += tildes > 1 ? "\\~" : c;
    // A link needs `](` (or a reference `]:`/`][`).
    else if (c === "]") out += /[(:[]/.test(next) ? "\\]" : c;
    else if (c === "[") out += next === " " || next === "x" || next === "X" ? "\\[" : c;
    else if (c === "<") out += /[A-Za-z/!?]/.test(next) ? "&lt;" : c;
    else if (c === "&") out += /^&(#\d+|#x[\da-f]+|[a-z][a-z\d]*);/i.test(text.slice(i)) ? "&amp;" : c;
    else out += c;
  }
  return out;
}

function findUpload(editor: Editor, id: string): number | null {
  let at: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (at !== null) return false;
    if (node.type.name === "uploading" && node.attrs.id === id) at = pos;
  });
  return at;
}

function replaceUpload(editor: Editor, id: string, next: PMNode | null) {
  if (editor.isDestroyed) return;
  const at = findUpload(editor, id);
  if (at === null) return; // removed meanwhile
  const tr = editor.state.tr;
  if (next) tr.replaceWith(at, at + 1, next);
  else tr.delete(at, at + 1);
  editor.view.dispatch(tr.setMeta("addToHistory", false));
}

/** Pasted screenshots are all called image.png: give them a readable, unique name. */
function renamed(file: File, i: number): File {
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return new File([file], `screenshot-${stamp}${i ? `-${i + 1}` : ""}.${ext}`, { type: file.type });
}

/* -------------------------------------------------------------------------- */
/* Node views                                                                 */
/* -------------------------------------------------------------------------- */

function RemoveButton({ name, onRemove, className }: { name: string; onRemove: () => void; className?: string }) {
  return (
    <button
      type="button"
      contentEditable={false}
      aria-label={`Remove ${name}`}
      title="Remove"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        onRemove();
      }}
      className={cn(
        "grid size-5 place-items-center rounded-full border bg-background text-muted-foreground opacity-0 shadow-sm transition group-hover/node:opacity-100 hover:text-foreground focus-visible:opacity-100",
        className,
      )}
    >
      <X className="size-3" />
    </button>
  );
}

function ImageView({ node, selected, deleteNode, editor }: NodeViewProps) {
  const src = node.attrs.src as string;
  const alt = (node.attrs.alt as string) || "";
  const core = isCoreFile(src);
  const file = useCoreFileUrl(core ? src : undefined);
  const shown = core ? file.src : src;
  return (
    <NodeViewWrapper as="span" className="group/node relative inline-block max-w-full align-top" data-drag-handle="">
      {core && file.failed ? (
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-dashed px-2.5 py-1.5 text-xs text-muted-foreground">
          <ImageOff className="size-3.5" /> {alt || "Image"} isn't available anymore
        </span>
      ) : shown ? (
        <img src={shown} alt={alt} draggable={false} className={cn("max-h-96 max-w-full rounded-lg border transition", selected && "ring-2 ring-ring/60 ring-offset-2 ring-offset-background")} />
      ) : (
        <span aria-label={alt} className="inline-block h-40 w-64 max-w-full animate-pulse rounded-lg border bg-muted" />
      )}
      {editor.isEditable && <RemoveButton name={alt || "image"} onRemove={deleteNode} className="absolute top-1.5 right-1.5" />}
    </NodeViewWrapper>
  );
}

function FileChipView({ node, selected, deleteNode, editor }: NodeViewProps) {
  const name = node.attrs.name as string;
  const href = node.attrs.href as string;
  const Icon = fileIcon("", name);
  return (
    <NodeViewWrapper as="span" className="group/node relative mx-0.5 inline-flex max-w-full align-middle" data-drag-handle="">
      <span
        title={`${name} — double-click to download`}
        onDoubleClick={() => void downloadCoreFile(href, name)}
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 rounded-lg border bg-card py-0.5 pr-2 pl-1 text-[13px] leading-6 font-medium shadow-xs",
          selected && "ring-2 ring-ring/60",
        )}
      >
        <span className="grid size-5 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          <Icon className="size-3" />
        </span>
        <span className="truncate">{name}</span>
      </span>
      {editor.isEditable && <RemoveButton name={name} onRemove={deleteNode} className="absolute -top-2 -right-2" />}
    </NodeViewWrapper>
  );
}

function UploadingView({ node }: NodeViewProps) {
  const name = node.attrs.name as string;
  const preview = node.attrs.preview as string | null;
  if (preview) {
    return (
      <NodeViewWrapper as="span" className="relative inline-block max-w-full align-top">
        <img src={preview} alt="" className="max-h-96 max-w-full rounded-lg border opacity-50 blur-[1px]" />
        <span className="absolute inset-0 grid place-items-center">
          <span className="flex items-center gap-1.5 rounded-full bg-background/90 px-2.5 py-1 text-xs font-medium shadow-sm">
            <Paperclip className="size-3 animate-pulse" /> Uploading…
          </span>
        </span>
      </NodeViewWrapper>
    );
  }
  return (
    <NodeViewWrapper as="span" className="mx-0.5 inline-flex max-w-full items-center gap-1.5 rounded-lg border border-dashed py-0.5 pr-2 pl-1.5 align-middle text-[13px] leading-6 text-muted-foreground">
      <Paperclip className="size-3 shrink-0 animate-pulse" />
      <span className="truncate">Uploading {name}…</span>
    </NodeViewWrapper>
  );
}

/* -------------------------------------------------------------------------- */
/* Toolbar                                                                    */
/* -------------------------------------------------------------------------- */

function Toolbar({ editor, onAttach }: { editor: Editor; onAttach: () => void }) {
  const on = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      heading: e.isActive("heading"),
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      bulletList: e.isActive("bulletList"),
      orderedList: e.isActive("orderedList"),
      taskList: e.isActive("taskList"),
      blockquote: e.isActive("blockquote"),
      codeBlock: e.isActive("codeBlock"),
      link: e.isActive("link"),
    }),
  });
  const chain = () => editor.chain().focus();
  return (
    // Clicks here keep the focus (and the selection) in the text.
    <div className="-mx-1 mb-2 flex flex-wrap items-center gap-0.5 border-b pb-1.5" onMouseDown={(e) => e.target instanceof HTMLInputElement || e.preventDefault()}>
      <Tool icon={Heading2} label="Heading" active={on.heading} onClick={() => chain().toggleHeading({ level: 2 }).run()} />
      <Tool icon={Bold} label="Bold" keys={`${modKey}B`} active={on.bold} onClick={() => chain().toggleBold().run()} />
      <Tool icon={Italic} label="Italic" keys={`${modKey}I`} active={on.italic} onClick={() => chain().toggleItalic().run()} />
      <Tool icon={Strikethrough} label="Strikethrough" active={on.strike} onClick={() => chain().toggleStrike().run()} />
      <Tool icon={Code} label="Inline code" active={on.code} onClick={() => chain().toggleCode().run()} />
      <Divider />
      <Tool icon={List} label="Bulleted list" active={on.bulletList} onClick={() => chain().toggleBulletList().run()} />
      <Tool icon={ListOrdered} label="Numbered list" active={on.orderedList} onClick={() => chain().toggleOrderedList().run()} />
      <Tool icon={ListChecks} label="Checklist" active={on.taskList} onClick={() => chain().toggleTaskList().run()} />
      <Divider />
      <Tool icon={Quote} label="Quote" active={on.blockquote} onClick={() => chain().toggleBlockquote().run()} />
      <Tool icon={SquareCode} label="Code block" active={on.codeBlock} onClick={() => chain().toggleCodeBlock().run()} />
      <LinkTool editor={editor} active={on.link} />
      <Tool icon={Paperclip} label="Attach files" hint="or paste / drop them into the text" className="ml-auto" onClick={onAttach} />
    </div>
  );
}

function Divider() {
  return <span className="mx-1 h-4 w-px bg-border" />;
}

function Tool({
  icon: Icon,
  label: name,
  keys,
  hint,
  active,
  className,
  onClick,
}: {
  icon: LucideIcon | ComponentType<{ className?: string }>;
  label: string;
  keys?: string;
  hint?: ReactNode;
  active?: boolean;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={name}
          aria-pressed={active}
          onClick={onClick}
          className={cn(
            "grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            active && "bg-accent text-foreground",
            className,
          )}
        >
          <Icon className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="flex items-center gap-1.5">
        {name}
        {keys && <span className="opacity-60">{keys}</span>}
        {hint && <span className="opacity-60">{hint}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

function LinkTool({ editor, active }: { editor: Editor; active: boolean }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const apply = () => {
    const href = url.trim();
    const chain = editor.chain().focus().extendMarkRange("link");
    if (!href) chain.unsetLink().run();
    else {
      const full = /^[a-z][a-z0-9+.-]*:|^\//i.test(href) ? href : `https://${href}`;
      if (editor.state.selection.empty && !active) chain.insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href: full } }] }).run();
      else chain.setLink({ href: full }).run();
    }
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setUrl((editor.getAttributes("link").href as string | undefined) ?? "");
        setOpen(next);
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Link"
              aria-pressed={active}
              className={cn(
                "grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                (active || open) && "bg-accent text-foreground",
              )}
            >
              <Link2 className="size-3.5" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Link</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-80 p-2" onCloseAutoFocus={(e) => (e.preventDefault(), editor.commands.focus())}>
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <Input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" aria-label="Link address" className="h-8 text-sm" />
          <Button type="submit" size="sm" className="h-8">
            {url.trim() || !active ? "Link" : "Remove"}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** Saved descriptions don't carry unfinished uploads (the editor leaves them out); kept for the callers' sake. */
export function withoutPlaceholders(markdown: string): string {
  return markdown.trim();
}
