import { isValidElement, memo, useMemo, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { Link } from "react-router";
import { cn } from "@/lib/utils";
import { CodeBlock as AicssCodeBlock } from "@/components/aicss/CodeBlock";
import { CoreFileLink, CoreImage, isCoreFile } from "./core-file";
import { FileLink, MessageFilesScope, Picture, content, rehypeLocalFiles, useMessageFiles, type HastNode } from "./local-files";

/** Fenced code in chat — aicss code block (line numbers + copy), height-capped for long snippets. */
export function CodeBlock({ lang, code, className }: { lang: string; code: string; className?: string }) {
  return (
    <div className={cn("max-h-[32rem] overflow-y-auto rounded-[10px]", className)}>
      <AicssCodeBlock lang={lang || "text"} code={code} />
    </div>
  );
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

/** The image a list item consists of, if that is all there is. */
function onlyImage(n: HastNode): HastNode | null {
  const [child, ...rest] = content(n);
  if (!child || rest.length) return null;
  return child.tagName === "img" ? child : child.tagName === "p" ? onlyImage(child) : null;
}

const components: Components = {
  pre({ children }) {
    const child = (Array.isArray(children) ? children[0] : children) as ReactElement<{ className?: string; children?: ReactNode }>;
    const className = isValidElement(child) ? (child.props.className ?? "") : "";
    const lang = /language-([\w+#.-]+)/.exec(className)?.[1] ?? "";
    const code = textOf(isValidElement(child) ? child.props.children : children).replace(/\n$/, "");
    return <CodeBlock lang={lang} code={code} />;
  },
  a({ node, href, children, ...rest }) {
    const local = (node as HastNode | undefined)?.data;
    if (local?.gmFile) return <FileLink file={local.gmFile} chip={local.gmChip}>{children}</FileLink>;
    if (href && isCoreFile(href)) return <CoreFileLink href={href}>{children}</CoreFileLink>;
    if (href && href.startsWith("/") && !href.startsWith("//")) {
      return <Link to={href}>{children}</Link>;
    }
    return (
      <a {...rest} href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  ul({ node, className, children }) {
    // A list of pictures (the screenshots of a result) reads best side by side.
    const images = node ? content(node as HastNode).map(onlyImage) : [];
    const gallery = images.length > 0 && images.every(Boolean);
    // Pictures from this computer sit in an even grid of tiles.
    const tiles = gallery && images.every((image) => image?.data?.gmFile);
    return <ul className={cn(className, gallery && "gm-gallery", tiles && "gm-shots")}>{children}</ul>;
  },
  table({ children }) {
    return (
      <div className="overflow-x-auto rounded-lg border bg-card shadow-card">
        <table>{children}</table>
      </div>
    );
  },
  img({ node, src, alt }) {
    const local = (node as HastNode | undefined)?.data?.gmFile;
    if (local) return <Picture file={local} />;
    if (!src || typeof src !== "string") return null;
    if (isCoreFile(src)) return <CoreImage src={src} alt={alt} />;
    return <img src={src} alt={alt ?? ""} loading="lazy" className="max-h-96 max-w-full rounded-lg border" />;
  },
  input({ type, checked, ...rest }) {
    // GFM task lists
    if (type === "checkbox") {
      return <input type="checkbox" checked={!!checked} readOnly className="mr-1.5 translate-y-px accent-[var(--primary)]" {...rest} />;
    }
    return <input type={type} {...rest} />;
  },
};

const remarkPlugins = [remarkGfm];
/** Every line break is kept, as typed: for text people write by hand (task descriptions), not model output. */
const remarkPluginsWithBreaks = [remarkGfm, remarkBreaks];

/**
 * GitHub-flavoured markdown with the chat prose styles, copyable code blocks and safe external links. In a chat, the
 * files and folders it names open in the file manager and its pictures are shown.
 */
export const Markdown = memo(function Markdown({ children, className, breaks }: { children: string; className?: string; breaks?: boolean }) {
  const files = useMessageFiles(children);
  const rehypePlugins = useMemo<Options["rehypePlugins"]>(() => (files ? [[rehypeLocalFiles, files.byRef]] : undefined), [files]);
  return (
    <MessageFilesScope files={files}>
      <div className={cn("prose-chat min-w-0 break-words", className)}>
        <ReactMarkdown remarkPlugins={breaks ? remarkPluginsWithBreaks : remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
          {children}
        </ReactMarkdown>
      </div>
    </MessageFilesScope>
  );
});
