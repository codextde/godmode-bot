import { useMutation, useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  CARD_BRAND_LABELS,
  CARD_CURRENCIES,
  cardBrand,
  cardDigits,
  cardExpired,
  luhnValid,
  type Agent,
  type CardBilling,
  type PaymentCard,
  type PaymentCardInput,
} from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { Group, PickerRow, Segmented, SegmentRow, SwitchRow } from "@/components/form";
import { Icon } from "@/components/icon";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { FieldCard, InputRow, SheetHeader } from "@/components/secret-parts";
import { LoadingState, Row, SectionTitle, T, tap } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { qk, queryClient } from "@/lib/query";
import { isCancelled, reveal, withConfirmedGrant } from "@/lib/secrets";
import { fullVaultApi, useCards, vk } from "@/lib/vault";
import { space, useColors } from "@/lib/theme";

type Approval = "always" | "above" | "never";
const EMPTY_BILLING: CardBilling = { line1: "", line2: "", postalCode: "", city: "", state: "", country: "" };

/** Minor units to a money field: 5000 → "50.00", null → "". */
const toMajor = (minor: number | null | undefined) => (minor === null || minor === undefined ? "" : (minor / 100).toFixed(2));

/** A money field to minor units: "" = null (no limit), NaN = not an amount. Takes "50", "49.99", "49,99", "1.250,00". */
function toMinor(text: string): number | null {
  let s = text.replace(/[\s'’]/g, "");
  if (!s) return null;
  if (/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) s = s.replace(/,/g, "");
  else if (/^\d{1,3}(\.\d{3})+(,\d*)?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(",", ".");
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return Number.NaN;
  return Math.round(Number(s) * 100);
}

/** "0829", "08/29", "8 / 29" → month and year. */
function parseExpiry(text: string): { month: number; year: number } | null {
  const m = /^\s*(\d{1,2})\s*\/?\s*(\d{2})\s*$/.exec(text);
  if (!m) return null;
  const month = Number(m[1]);
  return month >= 1 && month <= 12 ? { month, year: 2000 + Number(m[2]) } : null;
}

const sitesOf = (text: string) => [...new Set(text.split(/[\s,]+/).map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter(Boolean))];
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Add a payment card or change one, like the desktop's card dialog. Number, code and address go straight to the vault. */
export default function CardEdit() {
  const c = useColors();
  const { t } = useTranslation("vault");
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { fullAccess } = useFullAccess();
  const cards = useCards();
  const card = id ? cards.data?.find((x) => x.id === id) : undefined;

  if (fullAccess === false) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        <NeedsFullAccess />
      </View>
    );
  }
  if (id && !card) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        {cards.isLoading ? <LoadingState /> : <T variant="callout" muted style={{ textAlign: "center" }}>{t("cards.gone")}</T>}
      </View>
    );
  }
  return <CardForm key={card?.id ?? "new"} card={card ?? null} />;
}

function CardForm({ card }: { card: PaymentCard | null }) {
  const c = useColors();
  const { t } = useTranslation(["vault", "common"]);
  const workspaces = useQuery({ queryKey: qk.workspaces, queryFn: api.workspaces });
  const initialExpiry = card ? `${String(card.expMonth).padStart(2, "0")}/${String(card.expYear % 100).padStart(2, "0")}` : "";
  const [replacing, setReplacing] = useState(!card);
  const [number, setNumber] = useState("");
  const [expiry, setExpiry] = useState(initialExpiry);
  const [cvc, setCvc] = useState("");
  const [holderName, setHolderName] = useState(card?.holderName ?? "");
  const [name, setName] = useState(card?.name ?? "");
  const [billing, setBilling] = useState<CardBilling>(EMPTY_BILLING);
  const [billingOriginal, setBillingOriginal] = useState<CardBilling | null>(null);
  const [billingEditable, setBillingEditable] = useState(!card?.hasBilling);
  const [revealingBilling, setRevealingBilling] = useState(false);
  const [currency, setCurrency] = useState(card?.currency ?? "EUR");
  const [perPurchase, setPerPurchase] = useState(card ? toMajor(card.limitPerPurchase) : "50.00");
  const [monthly, setMonthly] = useState(card ? toMajor(card.limitMonthly) : "200.00");
  const [approval, setApproval] = useState<Approval>(!card || card.askAbove === 0 ? "always" : card.askAbove === null ? "never" : "above");
  const [askAbove, setAskAbove] = useState(card?.askAbove ? toMajor(card.askAbove) : "");
  const [workspaceId, setWorkspaceId] = useState(card?.workspaceId ?? "");
  const [sites, setSites] = useState(card?.allowedSites.join(", ") ?? "");
  const [frozen, setFrozen] = useState(card?.frozen ?? false);
  const [agentsMode, setAgentsMode] = useState<"all" | "some">(card?.agentIds ? "some" : "all");
  const [agentIds, setAgentIds] = useState<string[]>(card?.agentIds ?? []);
  const agents = useAgents();

  const digits = cardDigits(number);
  const brand = replacing ? cardBrand(digits) : card!.brand;
  const last4 = replacing ? digits.slice(-4) : card!.last4;
  const parsedExpiry = parseExpiry(expiry);
  const limitPer = toMinor(perPurchase);
  const limitMon = toMinor(monthly);
  const askMinor = toMinor(askAbove);

  const errors = {
    number: replacing && digits && !luhnValid(digits) ? t("cardEdit.numberInvalid") : null,
    expiry: expiry && (!parsedExpiry ? t("cardEdit.expiryInvalid") : cardExpired({ expMonth: parsedExpiry.month, expYear: parsedExpiry.year }) ? t("cardEdit.expired") : null),
    cvc: cvc && !/^\d{3,4}$/.test(cvc) ? t("cardEdit.cvcInvalid") : null,
    amount: Number.isNaN(limitPer) || Number.isNaN(limitMon) || (approval === "above" && (askMinor === null || Number.isNaN(askMinor))) ? t("cardEdit.amountInvalid") : null,
    agents: agentsMode === "some" && agentIds.length === 0 ? t("cardAgents.pickOne") : null,
  };
  const complete = (!replacing || luhnValid(digits)) && !!parsedExpiry;
  const ready = complete && !Object.values(errors).some(Boolean);

  const currencyOptions = useMemo(() => CARD_CURRENCIES.map((x) => ({ value: x as string, label: x })), []);
  // Agents that can see a card in this workspace, plus any picked earlier, like the desktop.
  const agentChoices = useMemo(() => {
    const inScope = (a: Agent) => !workspaceId || a.workspaceId === workspaceId;
    const shown: { id: string; agent?: Agent; seesCard: boolean }[] = (agents.data ?? [])
      .filter((a) => inScope(a) || agentIds.includes(a.id))
      .map((a) => ({ id: a.id, agent: a, seesCard: inScope(a) }));
    // Deleted ones only once the list is in: before that every picked agent would look deleted.
    if (agents.isSuccess) for (const id of agentIds) if (!agents.byId.has(id)) shown.push({ id, seesCard: false });
    return shown;
  }, [agents.data, agents.byId, agents.isSuccess, workspaceId, agentIds]);
  const toggleAgent = (id: string) => setAgentIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const workspaceOptions = useMemo(
    () => [{ value: "", label: t("loginEdit.allWorkspaces") }, ...(workspaces.data ?? []).map((w) => ({ value: w.id, label: w.name }))],
    [workspaces.data, t],
  );

  const showBilling = async () => {
    if (!card) return;
    setRevealingBilling(true);
    try {
      const res = await reveal(t("card.revealReason", { name: card.name }), (grant) => fullVaultApi.revealCard(card.id, grant));
      setBilling(res.billing ?? EMPTY_BILLING);
      setBillingOriginal(res.billing);
      setBillingEditable(true);
    } catch (err) {
      if (!isCancelled(err)) Alert.alert(t("card.revealFailed"), errorText(err));
    } finally {
      setRevealingBilling(false);
    }
  };

  /** All fields for a new card; only what changed for an existing one. */
  const buildInput = (): Partial<PaymentCardInput> => {
    const nextBilling: CardBilling = { line1: billing.line1.trim(), line2: billing.line2.trim(), postalCode: billing.postalCode.trim(), city: billing.city.trim(), state: billing.state.trim(), country: billing.country.trim().toUpperCase() };
    const billingFilled = Object.values(nextBilling).some(Boolean);
    const askValue = approval === "always" ? 0 : approval === "never" ? null : askMinor;
    const finalName = name.trim() || (last4 ? `${CARD_BRAND_LABELS[brand]} ${last4}` : card?.name ?? "");
    const allowed = sitesOf(sites);
    const nextAgents = agentsMode === "all" ? null : agentIds;
    if (!card) {
      return {
        workspaceId: workspaceId || null,
        name: finalName,
        number: digits,
        expMonth: parsedExpiry!.month,
        expYear: parsedExpiry!.year,
        holderName: holderName.trim(),
        currency,
        limitPerPurchase: limitPer,
        limitMonthly: limitMon,
        askAbove: askValue,
        agentIds: nextAgents,
        allowedSites: allowed,
        frozen,
        ...(cvc ? { cvc } : {}),
        ...(billingFilled ? { billing: nextBilling } : {}),
      };
    }
    const patch: Partial<PaymentCardInput> = {};
    if (finalName !== card.name) patch.name = finalName;
    if ((workspaceId || null) !== card.workspaceId) patch.workspaceId = workspaceId || null;
    if (replacing) {
      patch.number = digits;
      // A new card has its own code, or none.
      if (cvc) patch.cvc = cvc;
      else if (card.hasCvc) patch.cvc = "";
    } else if (cvc) patch.cvc = cvc;
    if (parsedExpiry && (parsedExpiry.month !== card.expMonth || parsedExpiry.year !== card.expYear)) {
      patch.expMonth = parsedExpiry.month;
      patch.expYear = parsedExpiry.year;
    }
    if (holderName.trim() !== card.holderName) patch.holderName = holderName.trim();
    if (billingEditable) {
      const before = billingOriginal ?? EMPTY_BILLING;
      const changed = (Object.keys(EMPTY_BILLING) as (keyof CardBilling)[]).some((k) => nextBilling[k] !== before[k]);
      if (changed) patch.billing = billingFilled ? nextBilling : null;
    }
    if (currency !== card.currency) patch.currency = currency;
    if (limitPer !== card.limitPerPurchase) patch.limitPerPurchase = limitPer;
    if (limitMon !== card.limitMonthly) patch.limitMonthly = limitMon;
    if (askValue !== card.askAbove) patch.askAbove = askValue;
    if (nextAgents === null ? card.agentIds !== null : card.agentIds === null || !sameSet(nextAgents, card.agentIds)) patch.agentIds = nextAgents;
    if (!sameSet(allowed, card.allowedSites)) patch.allowedSites = allowed;
    if (frozen !== card.frozen) patch.frozen = frozen;
    return patch;
  };

  const save = useMutation({
    mutationFn: async () => {
      const input = buildInput();
      if (!card) return fullVaultApi.createCard(input as PaymentCardInput);
      if (!Object.keys(input).length) return card;
      // Higher limits, fewer approvals or unfreezing loosen the card: Face ID and a grant first.
      return withConfirmedGrant(t("card.loosenReason", { name: card.name }), (grant) => fullVaultApi.updateCard(card.id, input, grant));
    },
    onSuccess: () => {
      setNumber("");
      setCvc("");
      setBilling(EMPTY_BILLING);
      void queryClient.invalidateQueries({ queryKey: vk.all });
      router.back();
    },
    onError: (err) => {
      if (!isCancelled(err)) Alert.alert(card ? t("cardEdit.updateFailed") : t("cardEdit.saveFailed"), errorText(err));
    },
  });

  const firstError = [errors.number, errors.expiry, errors.cvc, errors.amount].find(Boolean);
  const setBill = (k: keyof CardBilling) => (v: string) => setBilling((b) => ({ ...b, [k]: v }));

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
    >
      <SheetHeader title={card ? t("cardEdit.editTitle") : t("cardEdit.addTitle")} action={card ? t("common:actions.save") : t("common:actions.add")} ready={ready} busy={save.isPending} onAction={() => save.mutate()} />

      <View style={{ gap: space.sm }}>
        <FieldCard>
          {replacing ? (
            <InputRow label={t("card.number")} value={number} onChangeText={setNumber} placeholder="4242 4242 4242 4242" keyboardType="number-pad" mono autoFocus={!card} maxLength={23} />
          ) : (
            <Row style={styles.inlineRow}>
              <T variant="callout" style={styles.label}>
                {t("card.number")}
              </T>
              <T variant="callout" muted style={{ flex: 1, fontVariant: ["tabular-nums"] }}>
                {`•••• ${card!.last4}`}
              </T>
              <LinkText label={t("cardEdit.replace")} onPress={() => setReplacing(true)} />
            </Row>
          )}
          <InputRow label={t("card.expires")} value={expiry} onChangeText={setExpiry} placeholder={t("cardEdit.expiryPlaceholder")} keyboardType="numbers-and-punctuation" mono maxLength={7} />
          <InputRow label={t("card.cvc")} value={cvc} onChangeText={setCvc} placeholder={card?.hasCvc && !replacing ? t("loginEdit.unchanged") : t("loginEdit.optional")} keyboardType="number-pad" secure maxLength={4} />
          <InputRow label={t("card.holder")} value={holderName} onChangeText={setHolderName} placeholder={t("cardEdit.holderPlaceholder")} autoCapitalize="words" />
          <InputRow label={t("cardEdit.label")} value={name} onChangeText={setName} placeholder={last4 ? `${CARD_BRAND_LABELS[brand]} ${last4}` : t("cardEdit.labelPlaceholder")} autoCapitalize="words" maxLength={100} />
        </FieldCard>
        {firstError ? (
          <T variant="footnote" color={c.danger} style={styles.note}>
            {firstError}
          </T>
        ) : null}
      </View>

      <View>
        <SectionTitle title={t("card.billing")} />
        {billingEditable ? (
          <FieldCard>
            <InputRow label={t("cardEdit.line1")} value={billing.line1} onChangeText={setBill("line1")} autoCapitalize="words" />
            <InputRow label={t("cardEdit.line2")} value={billing.line2} onChangeText={setBill("line2")} placeholder={t("loginEdit.optional")} autoCapitalize="words" />
            <InputRow label={t("cardEdit.postalCode")} value={billing.postalCode} onChangeText={setBill("postalCode")} autoCapitalize="characters" />
            <InputRow label={t("cardEdit.city")} value={billing.city} onChangeText={setBill("city")} autoCapitalize="words" />
            <InputRow label={t("cardEdit.state")} value={billing.state} onChangeText={setBill("state")} placeholder={t("loginEdit.optional")} autoCapitalize="words" />
            <InputRow label={t("cardEdit.country")} value={billing.country} onChangeText={setBill("country")} placeholder="DE" autoCapitalize="characters" maxLength={2} />
          </FieldCard>
        ) : (
          <FieldCard>
            <Row style={styles.inlineRow}>
              <T variant="callout" muted style={{ flex: 1 }}>
                {t("cardEdit.billingHidden")}
              </T>
              {revealingBilling ? <ActivityIndicator size="small" color={c.textMuted} /> : <LinkText label={t("loginEdit.showNotes")} onPress={() => void showBilling()} />}
            </Row>
          </FieldCard>
        )}
      </View>

      <Group title={t("cardEdit.spending")}>
        <PickerRow title={t("cardEdit.currency")} value={currency} options={currencyOptions} onChange={setCurrency} />
        <MoneyRow label={t("cards.perPurchase")} value={perPurchase} onChange={setPerPurchase} currency={currency} />
        <MoneyRow label={t("cards.monthly")} value={monthly} onChange={setMonthly} currency={currency} />
        <SegmentRow
          title={t("cardEdit.askBeforePaying")}
          options={[
            { value: "always", label: t("cardEdit.askAlways") },
            { value: "above", label: t("cardEdit.askAbove") },
            { value: "never", label: t("cardEdit.askNever") },
          ]}
          value={approval}
          onChange={setApproval}
        />
        {approval === "above" ? <MoneyRow label={t("cards.askAbove")} value={askAbove} onChange={setAskAbove} currency={currency} /> : null}
      </Group>

      <Group>
        <PickerRow title={t("loginEdit.availableTo")} value={workspaceId} options={workspaceOptions} onChange={setWorkspaceId} />
        <InputRow label={t("cards.sites")} value={sites} onChangeText={setSites} placeholder={t("cards.anySite")} keyboardType="url" />
        <SwitchRow title={t("card.freeze")} value={frozen} onChange={setFrozen} />
      </Group>

      <View style={{ gap: space.sm }}>
        <Group title={t("cards.agents")}>
          <View style={styles.segment}>
            <Segmented
              options={[
                { value: "all", label: t("cardAgents.all") },
                { value: "some", label: t("cardAgents.some") },
              ]}
              value={agentsMode}
              onChange={setAgentsMode}
            />
          </View>
          {agentsMode === "some"
            ? agentChoices.map((choice) => (
                <AgentToggle
                  key={choice.id}
                  agent={choice.agent}
                  detail={choice.seesCard ? choice.agent?.role || undefined : choice.agent ? t("cardAgents.cantSee") : undefined}
                  selected={agentIds.includes(choice.id)}
                  onPress={() => toggleAgent(choice.id)}
                />
              ))
            : null}
        </Group>
        {errors.agents ? (
          <T variant="footnote" muted style={styles.note}>
            {errors.agents}
          </T>
        ) : null}
      </View>
    </ScrollView>
  );
}

/** One agent in the card's list: picked ones carry a check. */
function AgentToggle({ agent, detail, selected, onPress }: { agent: Agent | undefined; detail?: string; selected: boolean; onPress: () => void }) {
  const c = useColors();
  const { t } = useTranslation("vault");
  const name = agent?.name ?? t("cardAgents.deleted");
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={name}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.agentRow, pressed && { backgroundColor: c.sunken }]}
    >
      <CharacterAvatar agent={agent} size={30} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <T variant="callout" numberOfLines={1} style={{ fontWeight: "500" }} color={agent ? c.text : c.textMuted}>
          {name}
        </T>
        {detail ? (
          <T variant="footnote" muted numberOfLines={1}>
            {detail}
          </T>
        ) : null}
      </View>
      <Icon name={selected ? "checkFill" : "circle"} size={22} color={selected ? c.brand : c.textFaint} />
    </Pressable>
  );
}

function MoneyRow({ label, value, onChange, currency }: { label: string; value: string; onChange: (next: string) => void; currency: string }) {
  const { t } = useTranslation("vault");
  return <InputRow label={label} value={value} onChangeText={onChange} placeholder={t("cards.noLimit")} keyboardType="decimal-pad" trailing={<T variant="footnote" muted>{currency}</T>} />;
}

function LinkText({ label, onPress }: { label: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      hitSlop={8}
      onPress={() => {
        tap();
        onPress();
      }}
    >
      <T variant="callout" color={c.brandStrong} style={{ fontWeight: "600" }}>
        {label}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    justifyContent: "center",
    padding: space.lg,
  },
  content: {
    paddingTop: 20,
    paddingHorizontal: space.xl,
    paddingBottom: 40,
    gap: space.xl,
  },
  note: {
    paddingHorizontal: 4,
  },
  inlineRow: {
    gap: space.md,
    paddingHorizontal: space.lg,
    minHeight: 48,
  },
  label: {
    width: 112,
    fontWeight: "500",
  },
  segment: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  agentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
});
