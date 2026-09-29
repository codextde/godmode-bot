import type { SVGProps } from "react";
import type { MessagingConnection, MessagingProvider, MessagingState } from "@godmode/shared";
import { cn } from "@/lib/utils";

function SlackGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...props}>
      <path fill="#E01E5A" d="M5.04 15.17a2.53 2.53 0 0 1-2.52 2.52A2.53 2.53 0 0 1 0 15.17a2.53 2.53 0 0 1 2.52-2.52h2.52v2.52Zm1.27 0a2.53 2.53 0 0 1 2.52-2.52 2.53 2.53 0 0 1 2.52 2.52v6.31A2.53 2.53 0 0 1 8.83 24a2.53 2.53 0 0 1-2.52-2.52v-6.31Z" />
      <path fill="#36C5F0" d="M8.83 5.04a2.53 2.53 0 0 1-2.52-2.52A2.53 2.53 0 0 1 8.83 0a2.53 2.53 0 0 1 2.52 2.52v2.52H8.83Zm0 1.27a2.53 2.53 0 0 1 2.52 2.52 2.53 2.53 0 0 1-2.52 2.52H2.52A2.53 2.53 0 0 1 0 8.83a2.53 2.53 0 0 1 2.52-2.52h6.31Z" />
      <path fill="#2EB67D" d="M18.96 8.83a2.53 2.53 0 0 1 2.52-2.52A2.53 2.53 0 0 1 24 8.83a2.53 2.53 0 0 1-2.52 2.52h-2.52V8.83Zm-1.27 0a2.53 2.53 0 0 1-2.52 2.52 2.53 2.53 0 0 1-2.52-2.52V2.52A2.53 2.53 0 0 1 15.17 0a2.53 2.53 0 0 1 2.52 2.52v6.31Z" />
      <path fill="#ECB22E" d="M15.17 18.96a2.53 2.53 0 0 1 2.52 2.52A2.53 2.53 0 0 1 15.17 24a2.53 2.53 0 0 1-2.52-2.52v-2.52h2.52Zm0-1.27a2.53 2.53 0 0 1-2.52-2.52 2.53 2.53 0 0 1 2.52-2.52h6.31A2.53 2.53 0 0 1 24 15.17a2.53 2.53 0 0 1-2.52 2.52h-6.31Z" />
    </svg>
  );
}

function TelegramGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...props}>
      <circle cx="12" cy="12" r="12" fill="#27A6E5" />
      <path
        fill="#fff"
        d="M5.43 11.87c3.5-1.52 5.83-2.53 7-3.01 3.33-1.39 4.02-1.63 4.47-1.64.1 0 .32.02.47.14.12.1.15.23.17.33.02.09.04.3.02.47-.18 1.9-.96 6.5-1.36 8.63-.17.9-.5 1.2-.82 1.23-.7.06-1.23-.46-1.9-.9-1.06-.7-1.66-1.13-2.68-1.8-1.19-.78-.42-1.21.26-1.91.18-.18 3.25-2.98 3.3-3.23.01-.03.02-.15-.05-.21-.07-.06-.18-.04-.25-.02-.1.02-1.8 1.14-5.07 3.35-.48.33-.91.49-1.3.48-.43-.01-1.25-.24-1.87-.44-.75-.25-1.35-.38-1.3-.79.03-.21.33-.43.9-.66Z"
      />
    </svg>
  );
}

function TeamsGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...props}>
      <circle cx="19.3" cy="5.6" r="2.3" fill="#5059C9" />
      <path fill="#5059C9" d="M16.2 9.1h5.6c.67 0 1.2.54 1.2 1.2v4.9a3.6 3.6 0 0 1-3.6 3.6h-.2a3.6 3.6 0 0 1-3-1.6V9.1Z" />
      <circle cx="12.6" cy="4.6" r="3.2" fill="#7B83EB" />
      <path fill="#7B83EB" d="M7.5 9.1h9.3c.66 0 1.2.54 1.2 1.2v5.7a5.7 5.7 0 0 1-11.4 0v-5.7c0-.66.4-1.2.9-1.2Z" />
      <rect x="1" y="6.6" width="11.4" height="11.4" rx="1.4" fill="#4B53BC" />
      <path fill="#fff" d="M9.6 9.9H7.3v5.9H5.9V9.9H3.6V8.7h6v1.2Z" />
    </svg>
  );
}

export const PLATFORMS: Record<MessagingProvider, { label: string; glyph: typeof SlackGlyph; blurb: string; noun: string }> = {
  slack: {
    label: "Slack",
    glyph: SlackGlyph,
    blurb: "DM the bot or mention it in a channel — it answers in the thread. No public address needed.",
    noun: "workspace",
  },
  telegram: {
    label: "Telegram",
    glyph: TelegramGlyph,
    blurb: "Chat with your agents from your phone, in private or in groups. Set up in a minute with @BotFather.",
    noun: "chat",
  },
  teams: {
    label: "Microsoft Teams",
    glyph: TeamsGlyph,
    blurb: "Bring agents into chats and channels through an Azure bot. Needs a public https address.",
    noun: "tenant",
  },
};

export function PlatformLogo({ provider, size = "md", className }: { provider: MessagingProvider; size?: "sm" | "md" | "lg"; className?: string }) {
  const Glyph = PLATFORMS[provider].glyph;
  const tile = { sm: "size-7 rounded-md", md: "size-10 rounded-lg", lg: "size-12 rounded-xl" }[size];
  const glyph = { sm: "size-3.5", md: "size-5", lg: "size-6" }[size];
  return (
    <span className={cn("grid shrink-0 place-items-center border bg-paper-2 shadow-card", tile, className)}>
      <Glyph className={glyph} />
    </span>
  );
}

const STATE_META: Record<MessagingState, { label: string; dot: string; text: string }> = {
  connected: { label: "Connected", dot: "bg-success", text: "text-foreground/80" },
  connecting: { label: "Connecting…", dot: "bg-warning animate-pulse", text: "text-muted-foreground" },
  error: { label: "Needs attention", dot: "bg-destructive", text: "text-destructive" },
  off: { label: "Off", dot: "bg-muted-foreground/40", text: "text-muted-foreground" },
};

export function StatusPill({ connection, className }: { connection: MessagingConnection; className?: string }) {
  const state = connection.status.state;
  const meta = STATE_META[state];
  const label = state === "off" && connection.enabled ? "Waiting for the vault" : meta.label;
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-[5px] border bg-card px-1.5 py-0.5 text-[11px] font-medium", meta.text, className)}>
      <span className={cn("size-1.5 rounded-full", meta.dot)} />
      {label}
    </span>
  );
}

/** "@godmode_bot", "Acme workspace" — how the bot is known on its platform. */
export function botHandle(c: MessagingConnection): string | null {
  if (c.bot.username && c.provider === "telegram") return `@${c.bot.username}`;
  if (c.bot.team) return c.bot.team;
  return null;
}
