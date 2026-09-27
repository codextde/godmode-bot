import { isValidElement, memo, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router";
import { Code2 } from "lucide-react";
import { openExternal } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";

export function CodeBlock({ lang, code, className }: { lang: string; code: string; className?: string }) {
  return (
    <div className={cn("group/code overflow-hidden rounded-xl border bg-muted/50 dark:bg-black/30", className)}>
      <div className="flex h-8 items-center gap-2 border-b bg-background/30 pr-1 pl-3 text-xs text-muted-foreground">
        <Code2 className="size-3.5" />
        <span className="font-mono">{lang || "text"}</span>
        <CopyButton text={code} label="Copy code" className="ml-auto" />
      </div>
      <pre className="m-0! max-h-[32rem] overflow-auto rounded-none! border-0! bg-transparent! p-3! text-[0.8rem]! leading-relaxed">
        <code>{code}</code>
      </pre>
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
      <div className="overflow-x-auto rounded-lg">
        <table>{children}</table>
      </div>
    );
  },
  img({ src, alt }) {
    if (!src || typeof src !== "string") return null;
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

/** GitHub-flavoured markdown with the chat prose styles, copyable code blocks and safe external links. */
export const Markdown = memo(function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("prose-chat min-w-0 break-words", className)}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
