import { router, Stack } from "expo-router";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { CardSummary, PurchaseRow } from "@/components/card-parts";
import { Group, LinkRow } from "@/components/form";
import { useFullAccess } from "@/components/full-access";
import { HeaderActions } from "@/components/header-actions";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui";
import { ScopeChips, useVaultScope } from "@/components/vault-scope";
import { errorText } from "@/lib/api";
import { queryClient } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { isOutdated, useCards, usePurchases, vk } from "@/lib/vault";
import { space } from "@/lib/theme";

const RECENT = 10;

/** Payment cards agents may pay with: masked, with this month's spending and the latest purchases. Added here with full access. */
export default function Cards() {
  const { t } = useTranslation("vault");
  const { fullAccess } = useFullAccess();
  const cards = useCards();
  const purchases = usePurchases();
  const scope = useVaultScope();
  const pull = usePullRefresh(() => queryClient.invalidateQueries({ queryKey: vk.all }));
  const byId = new Map((cards.data ?? []).map((c) => [c.id, c]));
  const shown = scope.filter(cards.data ?? []);
  const inView = new Set(shown.map((c) => c.id));
  const purchased = (purchases.data ?? []).filter((p) => !scope.filtered || inView.has(p.cardId));
  const last4 = (cardId: string) => {
    const card = byId.get(cardId);
    return card ? `•••• ${card.last4}` : t("purchases.removedCard");
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Screen options={{ title: t("cards.title") }} />
      {fullAccess ? <HeaderActions actions={[{ icon: "plus", label: t("cardEdit.addTitle"), onPress: () => router.push("/vault/card-edit") }]} /> : null}
      {cards.isLoading ? (
        <View style={{ gap: space.md }}>
          <Skeleton height={112} radius={12} />
          <Skeleton height={112} radius={12} />
        </View>
      ) : isOutdated(cards.error) ? (
        <EmptyState icon="creditCard" title={t("list.outdatedTitle")} body={t("list.outdatedBody")} />
      ) : cards.isError ? (
        <ErrorState title={t("cards.loadFailed")} error={errorText(cards.error)} onRetry={() => void cards.refetch()} />
      ) : !cards.data?.length ? (
        <EmptyState icon="creditCard" title={t("cards.emptyTitle")} />
      ) : (
        <View style={{ gap: space.md }}>
          <ScopeChips state={scope} bleed={space.lg} />
          {shown.length ? (
            shown.map((card) => (
              <CardSummary key={card.id} card={card} scopeName={scope.nameOf(card.workspaceId)} onPress={() => router.push({ pathname: "/settings/vault/card/[id]", params: { id: card.id } })} />
            ))
          ) : (
            <EmptyState icon="creditCard" title={t("cards.emptyScopeTitle")} />
          )}
        </View>
      )}
      {purchased.length ? (
        <Group title={t("purchases.title")}>
          {purchased.slice(0, RECENT).map((p) => (
            <PurchaseRow key={p.id} purchase={p} cardText={last4(p.cardId)} actions={!!fullAccess} />
          ))}
          {purchased.length > RECENT ? <LinkRow title={t("purchases.all")} value={String(purchased.length)} onPress={() => router.push("/settings/vault/purchases")} /> : null}
        </Group>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
});
