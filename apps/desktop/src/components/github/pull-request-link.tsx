import { useContext, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { parsePullRequestUrl } from "@godmode/shared";
import { SidePanelScope, useChatSidePanel } from "@/components/side-panel/store";

export function isPullRequestLink(href: string | undefined): href is string {
  return !!href && parsePullRequestUrl(href) !== null;
}

export function opensElsewhere(e: MouseEvent) {
  return e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}

export function PullRequestLink({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children?: ReactNode }) {
  const { t } = useTranslation("chat");
  const scope = useContext(SidePanelScope);
  const show = useChatSidePanel((s) => s.show);
  if (!scope) {
    return (
      <a {...rest} href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  }
  const current = scope.current;
  return (
    <a
      {...rest}
      href={href}
      rel="noreferrer noopener"
      data-gm-panel=""
      title={t("pullRequest.linkHint")}
      aria-current={current?.kind === "pull" && current.url === href ? "true" : undefined}
      onClick={(e) => {
        if (opensElsewhere(e)) return;
        e.preventDefault();
        show(scope.conversationId, { kind: "pull", url: href });
      }}
    >
      {children}
    </a>
  );
}
