import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import type { Agent, MessagingAccess, MessagingConnection, MessagingProvider, MessagingState } from "@godmode/shared";
import { CharacterAvatar } from "./character";
import { ChoiceRow } from "./form";
import { Icon } from "./icon";
import { ActionRow, TextRow } from "./tool-form";
import { Badge, T, tap, type Tone } from "./ui";
import { RowPressable } from "./row-pressable";
import { t as tr } from "@/lib/i18n";
import type { CredentialFields } from "@/lib/messaging-admin";
import { space, useColors } from "@/lib/theme";

/** The platforms' own marks (brand colors, the same in light and dark), on a neutral tile. */
export function PlatformLogo({ provider, size = 30 }: { provider: MessagingProvider; size?: number }) {
  const c = useColors();
  const glyph = size * 0.56;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.tile, { width: size, height: size, borderRadius: size * 0.3, backgroundColor: c.sunken }]}
    >
      <Svg width={glyph} height={glyph} viewBox="0 0 24 24">
        {provider === "slack" ? (
          <>
            <Path fill="#E01E5A" d="M5.04 15.17a2.53 2.53 0 0 1-2.52 2.52A2.53 2.53 0 0 1 0 15.17a2.53 2.53 0 0 1 2.52-2.52h2.52v2.52Zm1.27 0a2.53 2.53 0 0 1 2.52-2.52 2.53 2.53 0 0 1 2.52 2.52v6.31A2.53 2.53 0 0 1 8.83 24a2.53 2.53 0 0 1-2.52-2.52v-6.31Z" />
            <Path fill="#36C5F0" d="M8.83 5.04a2.53 2.53 0 0 1-2.52-2.52A2.53 2.53 0 0 1 8.83 0a2.53 2.53 0 0 1 2.52 2.52v2.52H8.83Zm0 1.27a2.53 2.53 0 0 1 2.52 2.52 2.53 2.53 0 0 1-2.52 2.52H2.52A2.53 2.53 0 0 1 0 8.83a2.53 2.53 0 0 1 2.52-2.52h6.31Z" />
            <Path fill="#2EB67D" d="M18.96 8.83a2.53 2.53 0 0 1 2.52-2.52A2.53 2.53 0 0 1 24 8.83a2.53 2.53 0 0 1-2.52 2.52h-2.52V8.83Zm-1.27 0a2.53 2.53 0 0 1-2.52 2.52 2.53 2.53 0 0 1-2.52-2.52V2.52A2.53 2.53 0 0 1 15.17 0a2.53 2.53 0 0 1 2.52 2.52v6.31Z" />
            <Path fill="#ECB22E" d="M15.17 18.96a2.53 2.53 0 0 1 2.52 2.52A2.53 2.53 0 0 1 15.17 24a2.53 2.53 0 0 1-2.52-2.52v-2.52h2.52Zm0-1.27a2.53 2.53 0 0 1-2.52-2.52 2.53 2.53 0 0 1 2.52-2.52h6.31A2.53 2.53 0 0 1 24 15.17a2.53 2.53 0 0 1-2.52 2.52h-6.31Z" />
          </>
        ) : provider === "telegram" ? (
          <>
            <Circle cx={12} cy={12} r={12} fill="#27A6E5" />
            <Path
              fill="#fff"
              d="M5.43 11.87c3.5-1.52 5.83-2.53 7-3.01 3.33-1.39 4.02-1.63 4.47-1.64.1 0 .32.02.47.14.12.1.15.23.17.33.02.09.04.3.02.47-.18 1.9-.96 6.5-1.36 8.63-.17.9-.5 1.2-.82 1.23-.7.06-1.23-.46-1.9-.9-1.06-.7-1.66-1.13-2.68-1.8-1.19-.78-.42-1.21.26-1.91.18-.18 3.25-2.98 3.3-3.23.01-.03.02-.15-.05-.21-.07-.06-.18-.04-.25-.02-.1.02-1.8 1.14-5.07 3.35-.48.33-.91.49-1.3.48-.43-.01-1.25-.24-1.87-.44-.75-.25-1.35-.38-1.3-.79.03-.21.33-.43.9-.66Z"
            />
          </>
        ) : (
          <>
            <Circle cx={19.3} cy={5.6} r={2.3} fill="#5059C9" />
            <Path fill="#5059C9" d="M16.2 9.1h5.6c.67 0 1.2.54 1.2 1.2v4.9a3.6 3.6 0 0 1-3.6 3.6h-.2a3.6 3.6 0 0 1-3-1.6V9.1Z" />
            <Circle cx={12.6} cy={4.6} r={3.2} fill="#7B83EB" />
            <Path fill="#7B83EB" d="M7.5 9.1h9.3c.66 0 1.2.54 1.2 1.2v5.7a5.7 5.7 0 0 1-11.4 0v-5.7c0-.66.4-1.2.9-1.2Z" />
            <Rect x={1} y={6.6} width={11.4} height={11.4} rx={1.4} fill="#4B53BC" />
            <Path fill="#fff" d="M9.6 9.9H7.3v5.9H5.9V9.9H3.6V8.7h6v1.2Z" />
          </>
        )}
      </Svg>
    </View>
  );
}

const TONE: Record<MessagingState, Tone> = { connected: "success", connecting: "warning", error: "danger", off: "neutral" };

/** Connected, connecting, needs attention, off, or waiting for the vault to open. */
export function botState(c: MessagingConnection): { label: string; tone: Tone } {
  const state = c.status.state;
  return { label: state === "off" && c.enabled ? tr("messaging:state.waitingForVault") : tr(`messaging:state.${state}`), tone: TONE[state] };
}

export function BotStateBadge({ connection: c }: { connection: MessagingConnection }) {
  useTranslation("messaging");
  const { label, tone } = botState(c);
  return <Badge label={label} tone={tone} live={c.status.state === "connecting"} />;
}

/**
 * The agents a bot talks to, as rows for a Group: the chosen ones (the first, where new chats start, on top), and all
 * of them once opened up. A tap adds or removes one; another chosen one can be made the first.
 */
export function useAgentChooserRows({
  agents,
  value,
  defaultId,
  onChange,
}: {
  agents: Agent[];
  value: string[];
  defaultId: string | null;
  onChange: (ids: string[], defaultId: string | null) => void;
}) {
  const { t } = useTranslation("messaging");
  const [all, setAll] = useState(false);
  const chosen = agents.filter((a) => value.includes(a.id)).sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId));
  const rows = (all ? agents : chosen).map((a) => <AgentChoice key={a.id} agent={a} value={value} defaultId={defaultId} onChange={onChange} />);
  if (agents.length > chosen.length || all) {
    rows.push(<ActionRow key="more" icon={all ? "up" : "plus"} title={all ? t("agents.fewer") : t("agents.more")} onPress={() => setAll((v) => !v)} />);
  }
  return rows;
}

function AgentChoice({
  agent: a,
  value,
  defaultId,
  onChange,
}: {
  agent: Agent;
  value: string[];
  defaultId: string | null;
  onChange: (ids: string[], defaultId: string | null) => void;
}) {
  const c = useColors();
  const { t } = useTranslation("messaging");
  const on = value.includes(a.id);
  const first = on && defaultId === a.id;
  const toggle = () => {
    if (on) {
      const next = value.filter((x) => x !== a.id);
      onChange(next, defaultId === a.id ? (next[0] ?? null) : defaultId);
    } else onChange([...value, a.id], defaultId ?? a.id);
  };
  return (
    <RowPressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      accessibilityLabel={a.name}
      onPress={() => {
        tap();
        toggle();
      }}
      style={styles.agent}
    >
      <View style={[styles.check, on ? { backgroundColor: c.brand, borderColor: c.brand } : { borderColor: c.border }]}>
        {on ? <Icon name="check" size={11} color={c.onPrimary} weight="bold" /> : null}
      </View>
      <CharacterAvatar agent={a} size={28} />
      <T variant="callout" numberOfLines={1} style={{ flex: 1, fontWeight: "500" }} color={a.enabled ? c.text : c.textMuted}>
        {a.name}
      </T>
      {first ? (
        <Badge label={t("agents.startsHere")} tone="brand" dot={false} />
      ) : on ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("agents.startHereA11y", { name: a.name })}
          hitSlop={8}
          onPress={() => {
            tap();
            onChange(value, a.id);
          }}
        >
          <T variant="footnote" color={c.brandStrong} style={{ fontWeight: "500" }}>
            {t("agents.startHere")}
          </T>
        </Pressable>
      ) : null}
    </RowPressable>
  );
}

/** "People you approve" or "Anyone": two rows for a Group; opening up says what it means on that platform. */
export function accessRows({
  provider,
  team,
  value,
  onChange,
}: {
  provider: MessagingProvider;
  team: string | null;
  value: MessagingAccess;
  onChange: (next: MessagingAccess) => void;
}) {
  return [
    <AccessChoice key="approved" provider={provider} team={team} option="approved" value={value} onChange={onChange} />,
    <AccessChoice key="anyone" provider={provider} team={team} option="anyone" value={value} onChange={onChange} />,
  ];
}

function AccessChoice({
  provider,
  team,
  option,
  value,
  onChange,
}: {
  provider: MessagingProvider;
  team: string | null;
  option: MessagingAccess;
  value: MessagingAccess;
  onChange: (next: MessagingAccess) => void;
}) {
  const { t } = useTranslation("messaging");
  const open =
    provider === "telegram" ? t("access.openTelegram") : provider === "slack" ? (team ? t("access.openSlackTeam", { team }) : t("access.openSlack")) : t("access.openTeams");
  return (
    <ChoiceRow
      icon={option === "approved" ? "shield" : "globe"}
      title={option === "approved" ? t("access.approved") : t("access.anyone")}
      detail={option === "anyone" ? open : undefined}
      selected={value === option}
      onPress={() => onChange(option)}
    />
  );
}

/**
 * The fields a platform's tokens need, as rows for a Group. Tokens and secrets are typed hidden and never come back
 * from the computer; Teams' app and tenant IDs aren't secret.
 */
export function credentialRows(provider: MessagingProvider, fields: CredentialFields, onChange: (key: keyof CredentialFields, value: string) => void) {
  const row = (key: keyof CredentialFields, label: string, placeholder?: string, secure = true) => (
    <TextRow key={key} label={label} value={fields[key]} onChange={(v) => onChange(key, v)} placeholder={placeholder} secure={secure} mono={!secure} stacked />
  );
  if (provider === "telegram") return [row("botToken", tr("messaging:fields.botToken"), "123456789:AAE…")];
  if (provider === "slack") return [row("botToken", tr("messaging:fields.slackBot"), "xoxb-…"), row("appToken", tr("messaging:fields.slackApp"), "xapp-…")];
  return [
    row("appId", tr("messaging:fields.appId"), "1f2e3d4c-…", false),
    row("tenantId", tr("messaging:fields.tenantId"), "72f988bf-…", false),
    row("appPassword", tr("messaging:fields.clientSecret")),
  ];
}

/** Two letters for someone who wrote to a bot. */
export function Initials({ name, muted }: { name: string; muted?: boolean }) {
  const c = useColors();
  const letters =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?";
  return (
    <View style={[styles.initials, { backgroundColor: c.sunken, opacity: muted ? 0.5 : 1 }]}>
      <T variant="caption" style={{ fontWeight: "600" }}>
        {letters}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    alignItems: "center",
    justifyContent: "center",
  },
  agent: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 52,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
  check: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  initials: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
});
