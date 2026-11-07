import { useMutation } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import type { TFunction } from "i18next";
import { memo } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { cardLabel, formatMoney, type CardPurchase, type CardPurchasePatch, type PaymentCard, type PurchaseStatus } from "@godmode/shared";
import { CharacterAvatar } from "./character";
import { Tile } from "./form";
import { confirmWithBiometrics } from "./full-access";
import { Icon } from "./icon";
import { openChat } from "./rows";
import { RowMenu, type MenuItem } from "./secret-parts";
import { Badge, Card, Row, T, tap, type Tone } from "./ui";
import { ScopeBadge } from "./vault-scope";
import { api, errorText } from "@/lib/api";
import { shortTime } from "@/lib/format";
import { useAgents } from "@/lib/hooks";
import { qk, queryClient } from "@/lib/query";
import { isCancelled, withConfirmedGrant } from "@/lib/secrets";
import { fullVaultApi, isCardExpired, vk } from "@/lib/vault";
import { radius, space, useColors } from "@/lib/theme";

const STATUS_TONE: Record<PurchaseStatus, Tone> = {
  pending: "warning",
  approved: "sky",
  declined: "neutral",
  paid: "success",
  failed: "danger",
  expired: "neutral",
  cancelled: "neutral",
};

/** A card as its owner knows it: name, brand and last four digits, frozen or not, and this month's spending. */
export function CardSummary({ card, scopeName, onPress }: { card: PaymentCard; scopeName?: string | null; onPress?: () => void }) {
  const c = useColors();
  const { t } = useTranslation("vault");
  const limit = card.limitMonthly;
  const share = limit ? Math.min(1, card.spentThisMonth / Math.max(1, limit)) : 0;
  return (
    <Card onPress={onPress} style={styles.card}>
      <Row style={{ gap: space.md }}>
        <View style={[styles.tile, { backgroundColor: c.sunken }]}>
          <Icon name="creditCard" size={19} color={c.text} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T variant="headline" numberOfLines={1}>
            {card.name}
          </T>
          <T variant="footnote" muted numberOfLines={1} style={{ fontVariant: ["tabular-nums"] }}>
            {cardLabel(card)}
          </T>
        </View>
        {isCardExpired(card) ? <Badge label={t("cards.expired")} tone="danger" dot={false} /> : null}
        {card.frozen ? <Badge label={t("cards.frozen")} tone="sky" dot={false} /> : null}
        {onPress ? <Icon name="chevron" size={12} color={c.textFaint} weight="semibold" /> : null}
      </Row>
      <View style={{ gap: 6 }}>
        <Row style={{ gap: space.sm }}>
          <T variant="footnote" muted style={{ flex: 1, fontVariant: ["tabular-nums"] }}>
            {limit
              ? t("cards.spentOf", { spent: formatMoney(card.spentThisMonth, card.currency), limit: formatMoney(limit, card.currency) })
              : t("cards.spentNoLimit", { spent: formatMoney(card.spentThisMonth, card.currency) })}
          </T>
          <ScopeBadge name={scopeName ?? null} global={!card.workspaceId} />
        </Row>
        {limit ? (
          <View style={[styles.track, { backgroundColor: c.sunken }]}>
            <View style={[styles.fill, { width: `${Math.round(share * 100)}%`, backgroundColor: share >= 1 ? c.danger : c.brand }]} />
          </View>
        ) : null}
      </View>
    </Card>
  );
}

/** What a purchase's badge says, like the desktop's ledger: a typed-in card and an agent's failure report are told apart. */
function statusOf(p: CardPurchase, t: TFunction<"vault">): { label: string; tone: Tone } {
  if (p.status === "approved" && p.filledAt) return { label: t("purchaseActions.filled"), tone: "sky" };
  if (p.status === "failed") {
    return p.settledBy === "agent" && p.filledAt ? { label: t("purchaseActions.reportedFailed"), tone: "warning" } : { label: t("purchaseActions.notCharged"), tone: "neutral" };
  }
  return { label: t(`purchases.status.${p.status}`), tone: STATUS_TONE[p.status] };
}

/**
 * A purchase an agent made or asked to make. `actions` (a phone with full access): approve or decline one that waits,
 * mark it paid or not charged, end a subscription or count it again, open the chat, like the desktop's ledger.
 */
export const PurchaseRow = memo(function PurchaseRow({ purchase: p, cardText, actions }: { purchase: CardPurchase; cardText?: string; actions?: boolean }) {
  const c = useColors();
  const { t } = useTranslation("vault");
  const { byId } = useAgents();
  const agent = p.agentId ? byId.get(p.agentId) : undefined;
  const status = statusOf(p, t);
  const title = p.merchant || p.site || t("purchaseActions.purchase");
  const subscription = p.recurrence !== "once";
  const canSettle = p.status === "approved" || (p.status === "failed" && p.settledBy === "agent");
  const canEnd = p.status === "paid" && subscription;
  const update = useMutation({
    mutationFn: (patch: CardPurchasePatch) => withConfirmedGrant(t("purchaseActions.freesRoom"), (grant) => fullVaultApi.updatePurchase(p.id, patch, grant)),
    onSuccess: () => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      void queryClient.invalidateQueries({ queryKey: vk.all });
    },
    onError: (err) => {
      if (!isCancelled(err)) Alert.alert(t("purchaseActions.updateFailed"), errorText(err));
    },
  });
  const decide = useMutation({
    mutationFn: (decision: "approve" | "decline") => api.questions.answer(p.questionId!, { decision }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: vk.all });
      void queryClient.invalidateQueries({ queryKey: qk.questions });
      void queryClient.invalidateQueries({ queryKey: qk.bootstrap });
    },
    onError: (err) => Alert.alert(t("purchaseActions.answerFailed"), errorText(err)),
  });
  const items: MenuItem[] = !actions
    ? []
    : [
        ...(canSettle
          ? [
              { label: t("purchaseActions.markPaid"), icon: "checkCircle" as const, onPress: () => update.mutate({ status: "paid" }) },
              { label: t("purchaseActions.notCharged"), icon: "closeCircle" as const, onPress: () => update.mutate({ status: "failed" }) },
            ]
          : []),
        ...(canEnd
          ? [
              p.endedAt
                ? { label: t("purchaseActions.markActive"), icon: "refresh" as const, onPress: () => update.mutate({ ended: false }) }
                : { label: t("purchaseActions.endSubscription"), icon: "stop" as const, onPress: () => update.mutate({ ended: true }) },
            ]
          : []),
        ...(p.conversationId ? [{ label: t("purchaseActions.openChat"), icon: "chats" as const, onPress: () => openChat(p.conversationId!) }] : []),
      ];
  const approve = async () => {
    if (await confirmWithBiometrics(t("purchaseActions.approveReason", { amount: formatMoney(p.amount, p.currency), merchant: title }))) decide.mutate("approve");
  };
  const waiting = actions && p.status === "pending" && !!p.questionId;
  const recurrence = p.recurrence !== "once" ? `${t(`purchases.recurrence.${p.recurrence}`)}${p.endedAt ? ` · ${t("purchaseActions.ended")}` : ""}` : null;
  const detail = [cardText, p.site && p.site !== title ? p.site : null, recurrence, p.description].filter(Boolean).join(" · ");

  return (
    <View style={styles.purchase}>
      <Row style={{ gap: space.md }}>
        {agent ? <CharacterAvatar agent={agent} size={30} /> : <Tile icon="agents" tint={c.textMuted} />}
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T variant="callout" numberOfLines={1} style={{ fontWeight: "500" }}>
            {title}
          </T>
          <T variant="footnote" muted numberOfLines={1}>
            {[agent?.name ?? t("purchases.deletedAgent"), shortTime(p.createdAt)].join(" · ")}
          </T>
          {detail ? (
            <T variant="footnote" muted numberOfLines={1}>
              {detail}
            </T>
          ) : null}
        </View>
        <View style={{ alignItems: "flex-end", gap: 4 }}>
          <T variant="callout" color={p.endedAt || status.tone === "neutral" ? c.textMuted : c.text} style={{ fontVariant: ["tabular-nums"] }}>
            {formatMoney(p.amount, p.currency)}
          </T>
          <Badge label={status.label} tone={status.tone} />
        </View>
        {update.isPending ? (
          <View style={styles.menu}>
            <ActivityIndicator size="small" color={c.textMuted} />
          </View>
        ) : items.length ? (
          <RowMenu label={t("purchaseActions.actionsFor", { name: title })} items={items} />
        ) : actions ? (
          // Keeps the amounts in one column with the rows that have a menu.
          <View style={styles.menu} />
        ) : null}
      </Row>
      {waiting ? (
        <Row style={{ gap: space.sm }}>
          <Pill
            title={t("purchaseActions.approve", { amount: formatMoney(p.amount, p.currency) })}
            icon="check"
            primary
            busy={decide.isPending && decide.variables === "approve"}
            disabled={decide.isPending}
            onPress={() => void approve()}
          />
          <Pill title={t("purchaseActions.decline")} icon="close" busy={decide.isPending && decide.variables === "decline"} disabled={decide.isPending} onPress={() => decide.mutate("decline")} />
        </Row>
      ) : null}
    </View>
  );
});

function Pill({ title, icon, primary, busy, disabled, onPress }: { title: string; icon: "check" | "close"; primary?: boolean; busy?: boolean; disabled?: boolean; onPress: () => void }) {
  const c = useColors();
  const fg = primary ? c.onPrimary : c.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy, disabled }}
      disabled={disabled}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.pill, { backgroundColor: primary ? c.primary : c.sunken, opacity: disabled && !busy ? 0.5 : pressed ? 0.7 : 1 }]}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : <Icon name={icon} size={11} color={fg} weight="semibold" />}
      <T variant="footnote" color={fg} style={{ fontWeight: "600" }}>
        {title}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: space.lg,
    gap: space.md,
  },
  tile: {
    width: 40,
    height: 40,
    borderRadius: 12,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  track: {
    height: 6,
    borderRadius: radius.pill,
    overflow: "hidden",
  },
  fill: {
    height: 6,
    borderRadius: radius.pill,
  },
  purchase: {
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: 12,
  },
  menu: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 30,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
  },
});
