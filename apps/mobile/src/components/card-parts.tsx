import { memo } from "react";
import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { cardLabel, formatMoney, type CardPurchase, type PaymentCard, type PurchaseStatus } from "@godmode/shared";
import { Icon } from "./icon";
import { Badge, Card, Row, T, type Tone } from "./ui";
import { shortTime } from "@/lib/format";
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
export function CardSummary({ card, onPress }: { card: PaymentCard; onPress?: () => void }) {
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
        {card.frozen ? <Badge label={t("cards.frozen")} tone="sky" dot={false} /> : null}
        {onPress ? <Icon name="chevron" size={12} color={c.textFaint} weight="semibold" /> : null}
      </Row>
      <View style={{ gap: 6 }}>
        <T variant="footnote" muted style={{ fontVariant: ["tabular-nums"] }}>
          {limit
            ? t("cards.spentOf", { spent: formatMoney(card.spentThisMonth, card.currency), limit: formatMoney(limit, card.currency) })
            : t("cards.spentNoLimit", { spent: formatMoney(card.spentThisMonth, card.currency) })}
        </T>
        {limit ? (
          <View style={[styles.track, { backgroundColor: c.sunken }]}>
            <View style={[styles.fill, { width: `${Math.round(share * 100)}%`, backgroundColor: share >= 1 ? c.danger : c.brand }]} />
          </View>
        ) : null}
      </View>
    </Card>
  );
}

export const PurchaseRow = memo(function PurchaseRow({ purchase: p, card }: { purchase: CardPurchase; card?: PaymentCard }) {
  const { t } = useTranslation("vault");
  return (
    <View style={styles.purchase}>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="callout" numberOfLines={1} style={{ fontWeight: "500" }}>
          {p.merchant || p.site}
        </T>
        <T variant="footnote" muted numberOfLines={1}>
          {[p.description, card ? `•••• ${card.last4}` : null, p.recurrence !== "once" ? t(`purchases.recurrence.${p.recurrence}`) : null, shortTime(p.createdAt)].filter(Boolean).join(" · ")}
        </T>
      </View>
      <View style={{ alignItems: "flex-end", gap: 4 }}>
        <T variant="callout" style={{ fontVariant: ["tabular-nums"] }}>
          {formatMoney(p.amount, p.currency)}
        </T>
        <Badge label={t(`purchases.status.${p.status}`)} tone={STATUS_TONE[p.status]} />
      </View>
    </View>
  );
});

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
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 12,
  },
});
