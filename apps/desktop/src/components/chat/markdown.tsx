import { isValidElement, memo, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { Link } from "react-router";
import { openExternal } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { CodeBlock as AicssCodeBlock } from "@/components/aicss/CodeBlock";
import { CoreFileLink, CoreImage, isCoreFile } from "./core-file";

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

const components: Components = {
  pre({ children }) {
    const child = (Array.isArray(children) ? children[0] : children) as ReactElement<{ className?: string; children?: ReactNode }>;
    const className = isValidElement(child) ? (child.props.className ?? "") : "";
    const lang = /language-([\w+#.-]+)/.exec(className)?.[1] ?? "";
    const code = textOf(isValidElement(child) ? child.props.children : children).replace(/\n$/, "");
    return <CodeBlock lang={lang} code={code} />;
  },
  a({ href, children, ...rest }) {
    if (href && isCoreFile(href)) return <CoreFileLink href={href}>{children}</CoreFileLink>;
    if (href && href.startsWith("/") && !href.startsWith("//")) {
      return <Link to={href}>{children}</Link>;
    }
    return (
      <a
        {...rest}
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        onClick={(e) => {
          if (!href) return;
          e.preventDefault();
          void openExternal(href);
        }}
      >
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="overflow-x-auto rounded-lg border bg-card shadow-card">
        <table>{children}</table>
      </div>
    );
  },
  img({ src, alt }) {
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

/** GitHub-flavoured markdown with the chat prose styles, copyable code blocks and safe external links. */
export const Markdown = memo(function Markdown({ children, className, breaks }: { children: string; className?: string; breaks?: boolean }) {
  return (
    <div className={cn("prose-chat min-w-0 break-words", className)}>
      <ReactMarkdown remarkPlugins={breaks ? remarkPluginsWithBreaks : remarkPlugins} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
