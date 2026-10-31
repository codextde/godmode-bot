import { createContext, useContext, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { create } from "zustand";
import { useTranslation } from "react-i18next";
import { parsePullRequestUrl } from "@godmode/shared";

interface PanelState {
  open: Record<string, string | null>;
  show: (conversationId: string, url: string) => void;
  hide: (conversationId: string) => void;
}

export const usePullRequestPanel = create<PanelState>()((set) => ({
  open: {},
  show: (conversationId, url) => set((s) => ({ open: { ...s.open, [conversationId]: url } })),
  hide: (conversationId) => set((s) => ({ open: { ...s.open, [conversationId]: null } })),
}));

export const PullRequestScope = createContext<{ conversationId: string; openUrl: string | null } | null>(null);
export const PullRequestScopeProvider = PullRequestScope.Provider;

export function isPullRequestLink(href: string | undefined): href is string {
  return !!href && parsePullRequestUrl(href) !== null;
}

function opensElsewhere(e: MouseEvent) {
  return e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}

export function PullRequestLink({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children?: ReactNode }) {
  const { t } = useTranslation("chat");
  const scope = useContext(PullRequestScope);
  const show = usePullRequestPanel((s) => s.show);
  if (!scope) {
    return (
      <a {...rest} href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  }
  return (
    <a
      {...rest}
      href={href}
      rel="noreferrer noopener"
      data-gm-panel=""
      title={t("pullRequest.linkHint")}
      aria-current={scope.openUrl === href ? "true" : undefined}
      onClick={(e) => {
        if (opensElsewhere(e)) return;
        e.preventDefault();
        show(scope.conversationId, href);
      }}
    >
      {children}
    </a>
  );
}
