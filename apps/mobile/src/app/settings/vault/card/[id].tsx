import { Stack, useLocalSearchParams } from "expo-router";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { formatMoney } from "@godmode/shared";
import { CardSummary, PurchaseRow } from "@/components/card-parts";
import { Group } from "@/components/form";
import { EmptyState, Row, Skeleton, T } from "@/components/ui";
import { useAgents } from "@/lib/hooks";
import { queryClient } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { useCards, usePurchases, vk } from "@/lib/vault";
import { space } from "@/lib/theme";

/** One card's limits and what agents bought with it. Read-only: limits, freezing and the card itself change on the computer. */
export default function CardDetail() {
  const { t } = useTranslation("vault");
  const { id } = useLocalSearchParams<{ id: string }>();
  const cards = useCards();
  const purchases = usePurchases(id);
  const { byId } = useAgents();
  const pull = usePullRefresh(() => queryClient.invalidateQueries({ queryKey: vk.all }));
  const card = cards.data?.find((c) => c.id === id);

  if (!card) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: t("cards.title"), headerLargeTitleEnabled: false }} />
        {cards.isLoading ? <Skeleton height={112} radius={12} /> : <EmptyState icon="creditCard" title={t("cards.gone")} />}
      </View>
    );
  }
  const money = (minor: number | null, none: string) => (minor === null ? none : formatMoney(minor, card.currency));
  const agents = card.agentIds === null ? t("cards.allAgents") : card.agentIds.map((a) => byId.get(a)?.name).filter(Boolean).join(", ") || t("cards.noAgents");

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Screen options={{ title: card.name, headerLargeTitleEnabled: false }} />
      <CardSummary card={card} />
      <Group title={t("cards.limits")}>
        <Fact label={t("cards.perPurchase")} value={money(card.limitPerPurchase, t("cards.noLimit"))} />
        <Fact label={t("cards.monthly")} value={money(card.limitMonthly, t("cards.noLimit"))} />
        <Fact label={t("cards.askAbove")} value={card.askAbove === null ? t("cards.never") : card.askAbove === 0 ? t("cards.always") : formatMoney(card.askAbove, card.currency)} />
        <Fact label={t("cards.agents")} value={agents} />
        <Fact label={t("cards.sites")} value={card.allowedSites.length ? card.allowedSites.join(", ") : t("cards.anySite")} />
      </Group>
      {purchases.data?.length ? (
        <Group title={t("purchases.title")}>
          {purchases.data.map((p) => (
            <PurchaseRow key={p.id} purchase={p} />
          ))}
        </Group>
      ) : purchases.isSuccess ? (
        <T variant="footnote" muted style={{ textAlign: "center" }}>
          {t("purchases.none")}
        </T>
      ) : null}
    </ScrollView>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <Row style={styles.fact}>
      <T variant="callout" style={{ flex: 1 }}>
        {label}
      </T>
      <T variant="subhead" muted numberOfLines={2} style={{ flexShrink: 1, maxWidth: "60%", textAlign: "right", fontVariant: ["tabular-nums"] }}>
        {value}
      </T>
    </Row>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  center: {
    flex: 1,
    padding: space.lg,
    justifyContent: "center",
  },
  fact: {
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },
});
