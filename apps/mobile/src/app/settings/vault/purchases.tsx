import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CardPurchase } from "@godmode/shared";
import { PurchaseRow } from "@/components/card-parts";
import { FilterChips } from "@/components/filter-chips";
import { useFullAccess } from "@/components/full-access";
import { ReadonlyList } from "@/components/readonly-list";
import { space } from "@/lib/theme";
import { useCards, usePurchases } from "@/lib/vault";

const ALL = "all";

/** The whole ledger, like the desktop's: every purchase agents made or asked to make, by card. */
export default function Purchases() {
  const { t } = useTranslation("vault");
  const { fullAccess } = useFullAccess();
  const cards = useCards();
  const [picked, setPicked] = useState(ALL);
  const cardId = cards.data?.some((c) => c.id === picked) ? picked : ALL;
  const list = usePurchases(cardId === ALL ? undefined : cardId);
  const byId = useMemo(() => new Map((cards.data ?? []).map((c) => [c.id, c])), [cards.data]);
  const filters = useMemo(() => [{ id: ALL, label: t("purchases.allCards") }, ...(cards.data ?? []).map((c) => ({ id: c.id, label: `${c.name} ${c.last4}` }))], [cards.data, t]);
  const last4 = (id: string) => {
    const card = byId.get(id);
    return card ? `•••• ${card.last4}` : t("purchases.removedCard");
  };

  return (
    <ReadonlyList<CardPurchase>
      inline
      title={t("purchases.title")}
      query={list}
      items={list.data ?? []}
      keyOf={(p) => p.id}
      extraData={[fullAccess, byId]}
      icon="creditCard"
      emptyTitle={t("purchases.none")}
      failedTitle={t("purchases.loadFailed")}
      inset={space.lg}
      header={filters.length > 2 ? <FilterChips filters={filters} value={cardId} onChange={setPicked} bleed={space.md} /> : undefined}
      renderRow={(p) => <PurchaseRow purchase={p} cardText={last4(p.cardId)} actions={!!fullAccess} />}
    />
  );
}
