import { router, type Href } from "expo-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Group, LinkRow } from "./form";
import type { IconName } from "./icon";
import { norm } from "./settings-scroll";
import { EmptyState } from "./ui";

/** Every settings screen with what is on it (`manage:search.items.<id>`): the desktop's settings search, on the phone. */
const ITEMS = [
  { id: "thisPhone", route: "/settings/this-phone", icon: "phone" },
  { id: "general", route: "/settings/general", icon: "slider" },
  { id: "notifications", route: "/settings/notifications", icon: "bell" },
  { id: "ai", route: "/settings/ai", icon: "sparkles" },
  { id: "accounts", route: "/settings/accounts", icon: "personCircle" },
  { id: "instructions", route: "/settings/instructions", icon: "text" },
  { id: "browser", route: "/settings/browser", icon: "globe" },
  { id: "computer", route: "/settings/computer", icon: "display" },
  { id: "voice", route: "/settings/voice", icon: "waveform" },
  { id: "memory", route: "/settings/memory", icon: "brain" },
  { id: "review", route: "/settings/review", icon: "review" },
  { id: "workspaces", route: "/settings/workspaces", icon: "layers" },
  { id: "agents", route: "/settings/agents", icon: "agents" },
  { id: "archive", route: "/settings/archive", icon: "archive" },
  { id: "vault", route: "/settings/vault", icon: "key" },
  { id: "logins", route: "/settings/vault/logins", icon: "key" },
  { id: "totp", route: "/settings/vault/totp", icon: "lock" },
  { id: "passkeys", route: "/settings/vault/passkeys", icon: "passkey" },
  { id: "cards", route: "/settings/vault/cards", icon: "creditCard" },
  { id: "apiKeys", route: "/settings/vault/api-keys", icon: "key" },
  { id: "sshKeys", route: "/settings/vault/ssh-keys", icon: "sshKey" },
  { id: "files", route: "/settings/files", icon: "files" },
  { id: "integrations", route: "/settings/integrations", icon: "plug" },
  { id: "plugins", route: "/settings/plugins", icon: "puzzle" },
  { id: "messaging", route: "/settings/messaging", icon: "chats" },
  { id: "ssh", route: "/settings/ssh", icon: "server" },
  { id: "vms", route: "/settings/vms", icon: "vm" },
  { id: "android", route: "/settings/android", icon: "phone" },
  { id: "features", route: "/settings/features", icon: "puzzle" },
  { id: "calls", route: "/settings/calls", icon: "call" },
  { id: "security", route: "/settings/security", icon: "lock" },
  { id: "backup", route: "/settings/backup", icon: "download" },
  { id: "cleanup", route: "/settings/cleanup", icon: "broom" },
  { id: "health", route: "/settings/health", icon: "pulse" },
  { id: "upkeep", route: "/settings/upkeep", icon: "refresh" },
  { id: "programs", route: "/settings/programs", icon: "terminal" },
  { id: "license", route: "/settings/license", icon: "key" },
  { id: "cloud", route: "/settings/cloud", icon: "network" },
  { id: "devices", route: "/settings/devices", icon: "cpu" },
  { id: "phones", route: "/settings/phones", icon: "phone" },
  { id: "connected", route: "/settings/connected-apps", icon: "plug" },
  { id: "logs", route: "/settings/logs", icon: "list" },
  { id: "about", route: "/settings/about", icon: "bolt" },
  { id: "advanced", route: "/settings/advanced", icon: "more" },
] as const satisfies readonly { id: string; route: Href; icon: IconName }[];

/**
 * Settings → search: screens whose name or contents hold every word typed, in this language and in English. A hit in
 * a screen's contents names the row it found, and opening it leads to that row.
 */
export function SettingsSearchResults({ query }: { query: string }) {
  const { t, i18n } = useTranslation("manage");
  const hits = useMemo(() => {
    const words = norm(query).split(/\s+/).filter(Boolean);
    const en = i18n.getFixedT("en", "manage");
    const other = i18n.language !== "en";
    return ITEMS.flatMap((item) => {
      const title = t(`search.items.${item.id}.title`);
      const terms = [
        ...t(`search.items.${item.id}.terms`).split(","),
        ...(other ? [en(`search.items.${item.id}.title`), ...en(`search.items.${item.id}.terms`).split(",")] : []),
      ].map((s) => s.trim());
      if (!words.every((w) => norm([title, ...terms].join(" ")).includes(w))) return [];
      const named = norm(title);
      const inTitle = words.every((w) => named.includes(w));
      const term = inTitle ? undefined : (terms.find((x) => words.every((w) => norm(x).includes(w))) ?? terms.find((x) => words.some((w) => norm(x).includes(w))));
      return [{ item, title, term, rank: inTitle ? (named.startsWith(words[0]!) ? 0 : 1) : 2 }];
    }).sort((a, b) => a.rank - b.rank);
  }, [t, i18n, query]);

  if (!hits.length) return <EmptyState icon="search" title={t("search.empty")} body={t("search.emptyBody")} />;
  return (
    <Group title={t("search.results")}>
      {hits.map(({ item, title, term }) => (
        <LinkRow key={item.id} icon={item.icon} title={title} detail={term ? term.charAt(0).toUpperCase() + term.slice(1) : undefined} onPress={() => router.push(term ? { pathname: item.route, params: { focus: term } } : item.route)} />
      ))}
    </Group>
  );
}
