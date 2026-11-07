import { useMutation } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { cardDigits, cardGroups, formatMoney, type PaymentCard, type PaymentCardSecrets } from "@godmode/shared";
import { CardSummary, PurchaseRow } from "@/components/card-parts";
import { Group, SwitchRow } from "@/components/form";
import { useFullAccess } from "@/components/full-access";
import { HeaderActions } from "@/components/header-actions";
import { confirmDelete, CopyButton, SecretRow } from "@/components/secret-parts";
import { Button, EmptyState, Row, Skeleton, T } from "@/components/ui";
import { errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { queryClient } from "@/lib/query";
import { copyPlain, copySecret, isCancelled, reveal, useRevealed, withConfirmedGrant } from "@/lib/secrets";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { fullVaultApi, useCards, usePurchases, vk } from "@/lib/vault";
import { space } from "@/lib/theme";

const SHOW_MS = 60_000;

/**
 * One card's limits and what agents bought with it. With full access the number, security code and billing address
 * show after Face ID (for a minute), and the card can be frozen, changed or deleted, like on the desktop.
 */
export default function CardDetail() {
  const { t } = useTranslation(["vault", "common"]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const { fullAccess } = useFullAccess();
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
      {fullAccess ? <HeaderActions actions={[{ icon: "pencil", label: t("common:actions.edit"), onPress: () => router.push({ pathname: "/vault/card-edit", params: { id: card.id } }) }]} /> : null}
      <CardSummary card={card} />
      {fullAccess ? <CardSecrets card={card} /> : null}
      <Group title={t("cards.limits")}>
        <Fact label={t("cards.perPurchase")} value={money(card.limitPerPurchase, t("cards.noLimit"))} />
        <Fact label={t("cards.monthly")} value={money(card.limitMonthly, t("cards.noLimit"))} />
        <Fact label={t("cards.askAbove")} value={card.askAbove === null ? t("cards.never") : card.askAbove === 0 ? t("cards.always") : formatMoney(card.askAbove, card.currency)} />
        <Fact label={t("cards.agents")} value={agents} />
        <Fact label={t("cards.sites")} value={card.allowedSites.length ? card.allowedSites.join(", ") : t("cards.anySite")} />
      </Group>
      {fullAccess ? <FreezeGroup card={card} /> : null}
      {purchases.data?.length ? (
        <Group title={t("purchases.title")}>
          {purchases.data.map((p) => (
            <PurchaseRow key={p.id} purchase={p} actions={!!fullAccess} />
          ))}
        </Group>
      ) : purchases.isSuccess ? (
        <T variant="footnote" muted style={{ textAlign: "center" }}>
          {t("purchases.none")}
        </T>
      ) : null}
      {fullAccess ? <DeleteCard card={card} /> : null}
    </ScrollView>
  );
}

/** "Show card details": Face ID, the vault password if asked, then the full card for a minute. */
function CardSecrets({ card }: { card: PaymentCard }) {
  const { t } = useTranslation(["vault", "common"]);
  const shown = useRevealed<PaymentCardSecrets>(SHOW_MS);
  const [busy, setBusy] = useState(false);
  const fetch = () => reveal(t("card.revealReason", { name: card.name }), (grant) => fullVaultApi.revealCard(card.id, grant));
  const show = async () => {
    setBusy(true);
    try {
      shown.show(await fetch());
    } catch (err) {
      if (!isCancelled(err)) Alert.alert(t("card.revealFailed"), errorText(err));
    } finally {
      setBusy(false);
    }
  };
  /** Copies one part, asking first when the details aren't on screen. */
  const copyPart = (pick: (s: PaymentCardSecrets) => string | null) => async () => {
    try {
      const value = pick(shown.value ?? (await fetch()));
      if (!value) return false;
      await copySecret(value);
      return true;
    } catch (err) {
      if (!isCancelled(err)) Alert.alert(t("card.revealFailed"), errorText(err));
      return false;
    }
  };

  const secrets = shown.value;
  const expiry = `${String(card.expMonth).padStart(2, "0")}/${String(card.expYear % 100).padStart(2, "0")}`;
  const billing = secrets?.billing;
  const address = billing ? [billing.line1, billing.line2, [billing.postalCode, billing.city].filter(Boolean).join(" "), billing.state, billing.country].filter(Boolean).join("\n") : "";

  if (!secrets) {
    return <Button title={t("card.show")} icon="eye" variant="outline" loading={busy} onPress={() => void show()} />;
  }
  return (
    <Group title={t("card.details")}>
      <SecretRow
        label={t("card.number")}
        value={cardGroups(cardDigits(secrets.number)).join(" ")}
        shownAt={shown.shownAt}
        ttlMs={SHOW_MS}
        onReveal={() => void show()}
        onHide={shown.hide}
        onCopy={copyPart((s) => cardDigits(s.number))}
      />
      <Row style={styles.fact}>
        <View style={{ flex: 1, gap: 2 }}>
          <T variant="footnote" muted>
            {t("card.expires")}
          </T>
          <T variant="callout" style={{ fontVariant: ["tabular-nums"] }}>
            {expiry}
          </T>
        </View>
        <CopyButton label={t("secret.copy", { name: t("card.expires") })} copy={() => copyPlain(expiry)} />
      </Row>
      <SecretRow
        label={t("card.cvc")}
        value={secrets.cvc ?? ""}
        shownAt={null}
        ttlMs={SHOW_MS}
        empty={secrets.cvc ? undefined : t("card.notSaved")}
        toggle={false}
        onReveal={() => void show()}
        onHide={shown.hide}
        onCopy={copyPart((s) => s.cvc)}
      />
      {card.holderName ? (
        <Row style={styles.fact}>
          <View style={{ flex: 1, gap: 2 }}>
            <T variant="footnote" muted>
              {t("card.holder")}
            </T>
            <T variant="callout">{card.holderName}</T>
          </View>
          <CopyButton label={t("secret.copy", { name: t("card.holder") })} copy={() => copyPlain(card.holderName)} />
        </Row>
      ) : null}
      <SecretRow
        label={t("card.billing")}
        value={address}
        shownAt={null}
        ttlMs={SHOW_MS}
        multiline
        empty={address ? undefined : t("card.notSaved")}
        toggle={false}
        onReveal={() => void show()}
        onHide={shown.hide}
        onCopy={copyPart(() => address || null)}
      />
    </Group>
  );
}

/** Frozen: no agent can pay with it. Unfreezing loosens the card, so the computer may ask for the vault password. */
function FreezeGroup({ card }: { card: PaymentCard }) {
  const { t } = useTranslation("vault");
  const freeze = useMutation({
    mutationFn: (frozen: boolean) => withConfirmedGrant(t("card.loosenReason", { name: card.name }), (grant) => fullVaultApi.updateCard(card.id, { frozen }, grant)),
    onSuccess: (saved) => {
      queryClient.setQueryData<PaymentCard[]>(vk.cards, (old) => old?.map((c) => (c.id === saved.id ? saved : c)));
      void queryClient.invalidateQueries({ queryKey: vk.all });
    },
    onError: (err) => {
      if (!isCancelled(err)) Alert.alert(t("card.changeFailed"), errorText(err));
    },
  });
  return (
    <Group>
      <SwitchRow icon="pause" title={t("card.freeze")} value={freeze.isPending ? !!freeze.variables : card.frozen} disabled={freeze.isPending} onChange={(next) => freeze.mutate(next)} />
    </Group>
  );
}

function DeleteCard({ card }: { card: PaymentCard }) {
  const { t } = useTranslation(["vault", "common"]);
  const remove = useMutation({
    mutationFn: () => fullVaultApi.deleteCard(card.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: vk.all });
      router.back();
    },
    onError: (err) => Alert.alert(t("card.deleteFailed"), errorText(err)),
  });
  return (
    <Button
      title={t("card.delete")}
      icon="trash"
      variant="danger"
      loading={remove.isPending}
      onPress={() => confirmDelete(t("card.deleteTitle", { name: card.name }), t("card.deleteBody"), t("common:actions.delete"), t("common:actions.cancel"), () => remove.mutate())}
    />
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <Row style={styles.factRow}>
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
  factRow: {
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },
  fact: {
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 12,
  },
});
