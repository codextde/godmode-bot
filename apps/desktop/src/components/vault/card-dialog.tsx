import { useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronRight, Eye, Lock, Trash2, Undo2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  CARD_BRAND_LABELS,
  CARD_CURRENCIES,
  cardBrand,
  cardExpired,
  cardGroups,
  formatMoney,
  luhnValid,
  type CardBilling,
  type PaymentCard,
  type PaymentCardInput,
} from "@godmode/shared";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AgentAvatar } from "@/components/common";
import { MultiSelect, type MultiSelectOption } from "@/components/agents/multi-select";
import { t as tg } from "@/i18n";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useAllAgents } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { ChipInput } from "./chip-input";
import { PasswordInput } from "./password-input";
import { PaymentCardFace } from "./payment-card-face";
import { WorkspaceSelect } from "./workspace-select";
import { BILLING_COUNTRIES, countryName, defaultCardName, isBillingCountry, toMajorInput, toMinor } from "./card-utils";
import { domainFromUrl, toastApiError } from "./vault-utils";
import { isGrantCancelled, withGrant } from "./grant";

type Approval = "always" | "above" | "never";

const EMPTY_BILLING: CardBilling = { line1: "", line2: "", postalCode: "", city: "", state: "", country: "" };
const NO_COUNTRY = "__none__";
const TOGGLE_ON = "data-[state=on]:bg-secondary data-[state=on]:text-foreground data-[state=on]:ring-1 data-[state=on]:ring-foreground/15 data-[state=on]:ring-inset";

function isDomain(s: string) {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s);
}

/** "08 / 29" for an existing card. */
function expiryText(month: number, year: number): string {
  return `${String(month).padStart(2, "0")} / ${String(year % 100).padStart(2, "0")}`;
}

function parseExpiry(text: string): { month: number; year: number } | null {
  const m = /^(\d{2}) \/ (\d{2})$/.exec(text.trim());
  if (!m) return null;
  const month = Number(m[1]);
  if (month < 1 || month > 12) return null;
  return { month, year: 2000 + Number(m[2]) };
}

function trimBilling(b: CardBilling): CardBilling {
  return { line1: b.line1.trim(), line2: b.line2.trim(), postalCode: b.postalCode.trim(), city: b.city.trim(), state: b.state.trim(), country: b.country };
}

function sameBilling(a: CardBilling, b: CardBilling): boolean {
  return (Object.keys(EMPTY_BILLING) as (keyof CardBilling)[]).every((k) => a[k] === b[k]);
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

export function CardDialog({
  open,
  onOpenChange,
  card,
  defaultWorkspaceId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this card; null = add one */
  card?: PaymentCard | null;
  defaultWorkspaceId?: string | null;
  onSaved?: (card: PaymentCard) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-xl">
        {open && (
          <CardForm
            key={card?.id ?? "new"}
            card={card ?? null}
            defaultWorkspaceId={defaultWorkspaceId ?? null}
            onDone={(c) => {
              onSaved?.(c);
              onOpenChange(false);
            }}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CardForm({
  card,
  defaultWorkspaceId,
  onDone,
  onCancel,
}: {
  card: PaymentCard | null;
  defaultWorkspaceId: string | null;
  onDone: (card: PaymentCard) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["vault", "common"]);
  const qc = useQueryClient();
  const uid = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const isEdit = !!card;
  const initialExpiry = card ? expiryText(card.expMonth, card.expYear) : "";

  // The card itself
  const [replacing, setReplacing] = useState(!isEdit);
  const [number, setNumber] = useState("");
  const [expiry, setExpiry] = useState(initialExpiry);
  const [cvc, setCvc] = useState("");
  const [cvcMode, setCvcMode] = useState<"keep" | "edit" | "remove">(card?.hasCvc ? "keep" : "edit");
  const [holderName, setHolderName] = useState(card?.holderName ?? "");
  const [name, setName] = useState(card?.name ?? "");

  // Billing address: an existing one stays sealed until revealed
  const [billingOpen, setBillingOpen] = useState(false);
  const [billing, setBilling] = useState<CardBilling>(EMPTY_BILLING);
  const [billingOriginal, setBillingOriginal] = useState<CardBilling | null>(null);
  const [billingMode, setBillingMode] = useState<"hidden" | "edit" | "remove">(card?.hasBilling ? "hidden" : "edit");
  const [revealingBilling, setRevealingBilling] = useState(false);

  // Spending rules
  const [currency, setCurrency] = useState(card?.currency ?? "EUR");
  const [perPurchase, setPerPurchase] = useState(card ? toMajorInput(card.limitPerPurchase) : "50.00");
  const [monthly, setMonthly] = useState(card ? toMajorInput(card.limitMonthly) : "200.00");
  const [approval, setApproval] = useState<Approval>(!card || card.askAbove === 0 ? "always" : card.askAbove === null ? "never" : "above");
  const [askAbove, setAskAbove] = useState(card?.askAbove ? toMajorInput(card.askAbove) : "");

  // Access
  const [workspaceId, setWorkspaceId] = useState<string | null>(card ? card.workspaceId : defaultWorkspaceId);
  const [agentsMode, setAgentsMode] = useState<"all" | "some">(card?.agentIds ? "some" : "all");
  const [agentIds, setAgentIds] = useState<string[]>(card?.agentIds ?? []);
  const [sites, setSites] = useState<string[]>(card?.allowedSites ?? []);
  const [frozen, setFrozen] = useState(card?.frozen ?? false);

  const [submitted, setSubmitted] = useState(false);

  const digits = number.replace(/\D/g, "");
  const brand = replacing ? cardBrand(digits) : card!.brand;
  const last4 = replacing ? (digits.length >= 4 ? digits.slice(-4) : "") : card!.last4;
  const numberValid = digits.length >= 12 && luhnValid(digits);
  const expiryParsed = parseExpiry(expiry);
  const expiryChanged = replacing || expiry !== initialExpiry;
  const fallbackName = last4 ? defaultCardName(brand, last4) : "";

  const limitPer = toMinor(perPurchase);
  const limitMon = toMinor(monthly);
  const askAboveMinor = toMinor(askAbove);

  // Agents that can see a card in this scope, plus any picked earlier
  const { data: agents = [] } = useAllAgents();
  const agentOptions = useMemo((): MultiSelectOption[] => {
    const inScope = (a: (typeof agents)[number]) => !workspaceId || a.workspaceId === workspaceId;
    const shown = agents.filter((a) => inScope(a) || agentIds.includes(a.id));
    const options: MultiSelectOption[] = shown.map((a) => ({
      value: a.id,
      label: a.name,
      icon: <AgentAvatar agent={a} size="sm" />,
      hint: inScope(a) ? a.role || undefined : t("cardDialog.cantSee"),
    }));
    for (const id of agentIds) if (!agents.some((a) => a.id === id)) options.push({ value: id, label: t("deletedAgent") });
    return options;
  }, [agents, workspaceId, agentIds, t]);

  const amountError = t("cardDialog.errors.amount");
  const errors = {
    number: replacing && !numberValid ? t("cardDialog.errors.number") : null,
    expiry: !expiryChanged
      ? null
      : !expiryParsed
        ? t("cardDialog.errors.expiryFormat")
        : cardExpired({ expMonth: expiryParsed.month, expYear: expiryParsed.year })
          ? t("cardDialog.errors.expired")
          : null,
    cvc: (replacing || cvcMode === "edit") && cvc && !/^\d{3,4}$/.test(cvc) ? t("cardDialog.errors.cvc") : null,
    perPurchase: Number.isNaN(limitPer) ? amountError : null,
    monthly: Number.isNaN(limitMon) ? amountError : null,
    askAbove: approval === "above" && (askAboveMinor === null || Number.isNaN(askAboveMinor)) ? amountError : null,
    agents: agentsMode === "some" && agentIds.length === 0 ? t("cardDialog.errors.agents") : null,
  };
  const err = (k: keyof typeof errors) => (submitted ? errors[k] : null);

  const showBilling = async () => {
    if (!card) return;
    setRevealingBilling(true);
    try {
      const res = await withGrant((grant) => api.cards.reveal(card.id, grant), tg("vault:cardDialog.grantBilling"));
      setBilling(res.billing ?? EMPTY_BILLING);
      setBillingOriginal(res.billing);
      setBillingMode("edit");
    } catch (e) {
      if (!isGrantCancelled(e)) toastApiError(e, t("cardDialog.showBillingFailed"), qc);
    }
    setRevealingBilling(false);
  };

  /** What to send: the full input for a new card, only the changed fields for an existing one. */
  const buildInput = (): Partial<PaymentCardInput> => {
    const nextBilling = trimBilling(billing);
    const billingFilled = Object.values(nextBilling).some(Boolean);
    const askAboveValue = approval === "always" ? 0 : approval === "never" ? null : askAboveMinor;
    const nextAgents = agentsMode === "all" ? null : agentIds;
    const finalName = name.trim() || fallbackName || card?.name || "";

    if (!card) {
      const input: PaymentCardInput = {
        workspaceId,
        name: finalName,
        number: digits,
        expMonth: expiryParsed!.month,
        expYear: expiryParsed!.year,
        holderName: holderName.trim(),
        currency,
        limitPerPurchase: limitPer,
        limitMonthly: limitMon,
        askAbove: askAboveValue,
        agentIds: nextAgents,
        allowedSites: sites,
      };
      if (cvc) input.cvc = cvc;
      if (billingFilled) input.billing = nextBilling;
      return input;
    }

    const patch: Partial<PaymentCardInput> = {};
    if (finalName !== card.name) patch.name = finalName;
    if (workspaceId !== card.workspaceId) patch.workspaceId = workspaceId;
    if (replacing) patch.number = digits;
    if (expiryChanged && expiryParsed && (expiryParsed.month !== card.expMonth || expiryParsed.year !== card.expYear)) {
      patch.expMonth = expiryParsed.month;
      patch.expYear = expiryParsed.year;
    }
    if (holderName.trim() !== card.holderName) patch.holderName = holderName.trim();
    if (replacing) {
      // A new card: its own code, or none (the old one belongs to the old card)
      if (cvc) patch.cvc = cvc;
      else if (card.hasCvc) patch.cvc = "";
    } else if (cvcMode === "remove") patch.cvc = "";
    else if (cvcMode === "edit" && cvc) patch.cvc = cvc;
    if (billingMode === "remove") patch.billing = null;
    else if (billingMode === "edit") {
      if (!billingFilled) {
        if (card.hasBilling) patch.billing = null;
      } else if (!billingOriginal || !sameBilling(nextBilling, billingOriginal)) patch.billing = nextBilling;
    }
    if (currency !== card.currency) patch.currency = currency;
    if (limitPer !== card.limitPerPurchase) patch.limitPerPurchase = limitPer;
    if (limitMon !== card.limitMonthly) patch.limitMonthly = limitMon;
    if (askAboveValue !== card.askAbove) patch.askAbove = askAboveValue;
    if (nextAgents === null ? card.agentIds !== null : card.agentIds === null || !sameSet(nextAgents, card.agentIds)) patch.agentIds = nextAgents;
    if (!sameSet(sites, card.allowedSites)) patch.allowedSites = sites;
    if (frozen !== card.frozen) patch.frozen = frozen;
    return patch;
  };

  const save = useMutation({
    mutationFn: async (): Promise<PaymentCard | null> => {
      const input = buildInput();
      if (!card) return api.cards.create(input as PaymentCardInput);
      if (Object.keys(input).length === 0) return null;
      return withGrant((grant) => api.cards.update(card.id, input, grant), tg("vault:cardDialog.grantLoosen"));
    },
    onSuccess: (saved) => {
      if (!saved) return onDone(card!);
      void qc.invalidateQueries({ queryKey: qk.cards });
      toast.success(isEdit ? t("cardDialog.updated") : t("cardDialog.saved"), { description: t("credential.savedEncrypted") });
      onDone(saved);
    },
    onError: (e) => !isGrantCancelled(e) && toastApiError(e, isEdit ? t("cardDialog.updateFailed") : t("cardDialog.saveFailed"), qc),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (Object.values(errors).some(Boolean)) {
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>("[aria-invalid=true]")?.focus());
      return;
    }
    save.mutate();
  };

  const startReplace = () => {
    setReplacing(true);
    setNumber("");
    setExpiry("");
    setCvc("");
    setCvcMode("edit");
  };
  const cancelReplace = () => {
    setReplacing(false);
    setNumber("");
    setExpiry(initialExpiry);
    setCvc("");
    setCvcMode(card?.hasCvc ? "keep" : "edit");
  };

  const id = (s: string) => `${uid}-${s}`;
  const previewExpiry = expiryParsed ?? (!replacing && card ? { month: card.expMonth, year: card.expYear } : null);
  const approvalHint =
    approval === "always"
      ? t("cardDialog.approvalHint.always")
      : approval === "never"
        ? t("cardDialog.approvalHint.never")
        : askAboveMinor !== null && !Number.isNaN(askAboveMinor)
          ? t("cardDialog.approvalHint.aboveAmount", { amount: formatMoney(askAboveMinor, currency) })
          : t("cardDialog.approvalHint.above");
  const billingSummary =
    billingMode === "remove"
      ? t("cardDialog.removedOnSave")
      : billingMode === "hidden"
        ? card?.billingCountry
          ? t("cardDialog.savedIn", { country: countryName(card.billingCountry) })
          : t("common:status.saved")
        : Object.values(trimBilling(billing)).some(Boolean)
          ? [billing.city.trim(), billing.country && countryName(billing.country)].filter(Boolean).join(", ") || t("cardDialog.added")
          : t("common:status.none");

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate className="flex max-h-[min(90vh,820px)] flex-col">
      <div className="flex items-start gap-4 px-6 pt-6 pb-4">
        <motion.div key={brand} initial={{ scale: 0.96, opacity: 0.6 }} animate={{ scale: 1, opacity: 1 }} className="w-36 shrink-0 sm:w-40">
          <PaymentCardFace
            brand={brand}
            last4={last4}
            label={name.trim() || fallbackName || (isEdit ? card!.name : t("cardDialog.newCard"))}
            holderName={holderName.trim()}
            expMonth={previewExpiry?.month ?? null}
            expYear={previewExpiry?.year ?? null}
            frozen={frozen}
            className="rounded-xl"
          />
        </motion.div>
        <div className="min-w-0 pt-1 pr-8">
          <DialogTitle className="text-lg">{isEdit ? t("credential.editTitle", { name: card!.name }) : t("cardDialog.addTitle")}</DialogTitle>
          <DialogDescription className="mt-1">
            {isEdit ? t("cardDialog.editDescription") : t("cardDialog.addDescription")}
          </DialogDescription>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-6 pt-1 pb-6">
        {/* Card */}
        <FormSection title={t("cardDialog.sections.card")}>
          <FormField
            label={t("card.number")}
            htmlFor={id("number")}
            error={err("number")}
            hint={isEdit && replacing ? <ReplaceHint onKeep={cancelReplace} /> : undefined}
          >
            {replacing ? (
              <CardNumberInput id={id("number")} value={number} onChange={setNumber} valid={numberValid} invalid={!!err("number")} autoFocus />
            ) : (
              <div className="flex h-9 items-center gap-2.5 rounded-md border bg-paper-2 pr-1.5 pl-3">
                <span className="font-mono text-sm tracking-[0.08em] tabular-nums">
                  <span className="text-muted-foreground">••••</span> {card!.last4}
                </span>
                <span className="text-xs text-muted-foreground">{CARD_BRAND_LABELS[card!.brand]}</span>
                <Button type="button" size="xs" variant="outline" className="ml-auto" onClick={startReplace}>
                  {t("cardDialog.replaceCard")}
                </Button>
              </div>
            )}
          </FormField>

          <div className="grid gap-4 sm:grid-cols-[9rem_minmax(0,1fr)]">
            <FormField label={t("cardDialog.expiry")} htmlFor={id("expiry")} error={err("expiry")}>
              <Input
                id={id("expiry")}
                value={expiry}
                onChange={(e) => setExpiry(formatExpiryInput(e.target.value, expiry))}
                placeholder={t("cardDialog.expiryPlaceholder")}
                inputMode="numeric"
                autoComplete="off"
                className="font-mono tabular-nums placeholder:font-sans"
                aria-invalid={!!err("expiry")}
              />
            </FormField>
            <FormField label={t("card.cvc")} htmlFor={id("cvc")} error={err("cvc")} hint={cvcMode === "edit" ? t("cardDialog.cvcHint") : undefined}>
              {cvcMode === "keep" ? (
                <SealedBox icon={<Lock />} text={t("cardDialog.cvcSaved")}>
                  <Button type="button" size="xs" variant="outline" onClick={() => setCvcMode("edit")}>
                    {t("replace")}
                  </Button>
                  <Button type="button" size="xs" variant="ghost" onClick={() => setCvcMode("remove")}>
                    {t("common:actions.remove")}
                  </Button>
                </SealedBox>
              ) : cvcMode === "remove" ? (
                <SealedBox icon={<Trash2 />} text={t("cardDialog.removedOnSave")}>
                  <Button type="button" size="xs" variant="ghost" onClick={() => setCvcMode("keep")}>
                    <Undo2 /> {t("common:actions.undo")}
                  </Button>
                </SealedBox>
              ) : (
                <div className="flex items-center gap-1.5">
                  <PasswordInput
                    id={id("cvc")}
                    value={cvc}
                    onChange={(e) => setCvc(e.target.value.replace(/\D/g, "").slice(0, 4))}
                    placeholder="•••"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={4}
                    groupClassName="h-9"
                    aria-invalid={!!err("cvc")}
                  />
                  {isEdit && !replacing && card!.hasCvc && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="shrink-0 text-muted-foreground"
                      onClick={() => {
                        setCvc("");
                        setCvcMode("keep");
                      }}
                    >
                      {t("cardDialog.keepSaved")}
                    </Button>
                  )}
                </div>
              )}
            </FormField>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t("card.holder")} htmlFor={id("holder")}>
              <Input id={id("holder")} value={holderName} onChange={(e) => setHolderName(e.target.value)} placeholder={t("cardDialog.holderPlaceholder")} autoComplete="off" spellCheck={false} />
            </FormField>
            <FormField label={t("cardDialog.label")} htmlFor={id("name")} hint={t("cardDialog.labelHint")}>
              <Input id={id("name")} value={name} onChange={(e) => setName(e.target.value)} placeholder={fallbackName || t("cardDialog.labelPlaceholder")} autoComplete="off" maxLength={100} />
            </FormField>
          </div>
        </FormSection>

        {/* Billing address */}
        <Collapsible open={billingOpen} onOpenChange={setBillingOpen} className="space-y-3.5">
          <CollapsibleTrigger className="group flex w-full items-start justify-between gap-3 rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <span className="min-w-0">
              <span className="eyebrow flex items-center gap-1">
                <ChevronRight className="-ml-0.5 size-3.5 transition-transform group-data-[state=open]:rotate-90" /> {t("card.billing")}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{t("cardDialog.billingHint")}</span>
            </span>
            <span className="mt-0.5 shrink-0 text-xs text-muted-foreground">{billingSummary}</span>
          </CollapsibleTrigger>
          <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
            <div className="space-y-4 pt-0.5 pb-1">
              {billingMode === "hidden" ? (
                <div className="flex min-h-20 flex-wrap items-center justify-center gap-2 rounded-md border border-dashed bg-paper-2 p-3 text-sm text-muted-foreground">
                  <Lock className="size-4 text-brand-strong" />
                  <span>{t("cardDialog.billingHidden")}</span>
                  <Button type="button" size="xs" variant="outline" onClick={() => void showBilling()} disabled={revealingBilling}>
                    {revealingBilling ? <Spinner className="size-3" /> : <Eye />} {t("cardDialog.showAndEdit")}
                  </Button>
                  <Button type="button" size="xs" variant="ghost" onClick={() => setBillingMode("remove")}>
                    {t("common:actions.remove")}
                  </Button>
                </div>
              ) : billingMode === "remove" ? (
                <div className="flex min-h-20 flex-wrap items-center justify-center gap-2 rounded-md border border-dashed bg-paper-2 p-3 text-sm text-muted-foreground">
                  <Trash2 className="size-4" />
                  <span>{t("cardDialog.billingRemoved")}</span>
                  <Button type="button" size="xs" variant="ghost" onClick={() => setBillingMode(billingOriginal ? "edit" : "hidden")}>
                    <Undo2 /> {t("common:actions.undo")}
                  </Button>
                </div>
              ) : (
                <BillingFields
                  id={id}
                  value={billing}
                  onChange={setBilling}
                  onRemove={billingOriginal ? () => setBillingMode("remove") : undefined}
                />
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* Spending rules */}
        <FormSection
          title={t("cardDialog.sections.spending")}
          aside={
            <div className="flex items-center gap-2">
              <Label htmlFor={id("currency")} className="text-xs font-normal text-muted-foreground">
                {t("cardDialog.currency")}
              </Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger id={id("currency")} size="sm" className="w-24 tabular-nums">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CARD_CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                  {!(CARD_CURRENCIES as readonly string[]).includes(currency) && <SelectItem value={currency}>{currency}</SelectItem>}
                </SelectContent>
              </Select>
            </div>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t("cardDialog.limitPerPurchase")} htmlFor={id("per")} error={err("perPurchase")} hint={t("cardDialog.limitEmptyHint")}>
              <MoneyInput id={id("per")} currency={currency} value={perPurchase} onChange={setPerPurchase} invalid={!!err("perPurchase")} clearable />
            </FormField>
            <FormField label={t("cardDialog.monthlyLimit")} htmlFor={id("monthly")} error={err("monthly")} hint={t("cardDialog.monthlyHint")}>
              <MoneyInput id={id("monthly")} currency={currency} value={monthly} onChange={setMonthly} invalid={!!err("monthly")} clearable />
            </FormField>
          </div>

          <div className="space-y-2">
            <span id={id("approval-label")} className="block text-sm leading-none font-medium">
              {t("cardDialog.askBeforePaying")}
            </span>
            <ToggleGroup
              type="single"
              variant="outline"
              value={approval}
              onValueChange={(v) => {
                if (!v) return;
                setApproval(v as Approval);
                if (v === "above" && !askAbove) setAskAbove("20.00");
              }}
              aria-labelledby={id("approval-label")}
              className="w-full"
            >
              <ToggleGroupItem value="always" className={cn("flex-1", TOGGLE_ON)}>
                {t("cardDialog.askAlways")}
              </ToggleGroupItem>
              <ToggleGroupItem value="above" className={cn("flex-1", TOGGLE_ON)}>
                {t("cardDialog.askAbove")}
              </ToggleGroupItem>
              <ToggleGroupItem value="never" className={cn("flex-1", TOGGLE_ON)}>
                {t("cardDialog.askNever")}
              </ToggleGroupItem>
            </ToggleGroup>
            <AnimatePresence initial={false}>
              {approval === "above" && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                  <div className="space-y-2 pt-1.5">
                    <Label htmlFor={id("ask-above")} className="sr-only">
                      {t("cardDialog.askAboveLabel")}
                    </Label>
                    <MoneyInput id={id("ask-above")} currency={currency} value={askAbove} onChange={setAskAbove} invalid={!!err("askAbove")} placeholder="20.00" className="sm:max-w-[calc(50%-0.5rem)]" />
                    {err("askAbove") && <p className="text-xs text-destructive">{err("askAbove")}</p>}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            <p className="text-xs text-muted-foreground">{approvalHint}</p>
          </div>
        </FormSection>

        {/* Access */}
        <FormSection title={t("cardDialog.sections.access")}>
          <FormField label={t("availableTo")} htmlFor={id("workspace")} hint={t("cardDialog.scopeHint")}>
            <WorkspaceSelect id={id("workspace")} value={workspaceId} onChange={setWorkspaceId} />
          </FormField>

          <div className="space-y-2">
            <span id={id("agents-label")} className="block text-sm leading-none font-medium">
              {t("common:words.agents")}
            </span>
            <ToggleGroup
              type="single"
              variant="outline"
              value={agentsMode}
              onValueChange={(v) => v && setAgentsMode(v as "all" | "some")}
              aria-labelledby={id("agents-label")}
              className="w-full"
            >
              <ToggleGroupItem value="all" className={cn("flex-1", TOGGLE_ON)}>
                {t("cardDialog.agentsAll")}
              </ToggleGroupItem>
              <ToggleGroupItem value="some" className={cn("flex-1", TOGGLE_ON)}>
                {t("cardDialog.agentsSome")}
              </ToggleGroupItem>
            </ToggleGroup>
            {agentsMode === "some" && (
              <div className="space-y-2 pt-1.5">
                <MultiSelect
                  id={id("agents")}
                  options={agentOptions}
                  value={agentIds}
                  onChange={setAgentIds}
                  placeholder={t("cardDialog.pickAgents")}
                  emptyText={t("cardDialog.noAgentMatches")}
                  className={cn(err("agents") && "[&_[role=combobox]]:border-destructive")}
                />
                {err("agents") && <p className="text-xs text-destructive">{err("agents")}</p>}
              </div>
            )}
          </div>

          <FormField label={t("cardDialog.allowedSites")} htmlFor={id("sites")} hint={t("cardDialog.allowedSitesHint")}>
            <ChipInput id={id("sites")} value={sites} onChange={setSites} normalize={(s) => domainFromUrl(s.replace(/^\*\./, ""))} validate={isDomain} placeholder="openai.com" />
          </FormField>

          {isEdit && (
            <label className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border bg-paper-2 p-3.5">
              <span>
                <span className="block text-sm font-medium">{t("cardDialog.freeze")}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{t("cardDialog.freezeHint")}</span>
              </span>
              <Switch checked={frozen} onCheckedChange={setFrozen} aria-label={t("cardDialog.freeze")} />
            </label>
          )}
        </FormSection>
      </div>

      <div className="flex flex-col-reverse gap-3 border-t bg-paper-2 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="size-3.5 shrink-0 text-brand-strong" /> {t("cardDialog.footer")}
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={save.isPending}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" disabled={save.isPending} className="min-w-24">
            {save.isPending && <Spinner />}
            {isEdit ? t("saveChanges") : t("cardDialog.saveCard")}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** Keeps "MM / YY" as you type: adds the slash, pads "4" to "04", accepts a pasted "08/2029". */
function formatExpiryInput(raw: string, previous: string): string {
  const pasted = /^\s*(\d{1,2})\s*[/.-]\s*(\d{2}|\d{4})\s*$/.exec(raw);
  if (pasted) return `${pasted[1].padStart(2, "0")} / ${pasted[2].slice(-2)}`;
  const monthOnly = /^\s*(\d)\s*[/.-]\s*$/.exec(raw);
  if (monthOnly && monthOnly[1] !== "0") return `0${monthOnly[1]} / `;
  let d = raw.replace(/\D/g, "").slice(0, 4);
  if (d.length === 1 && Number(d) > 1) d = `0${d}`;
  if (d.length > 2) return `${d.slice(0, 2)} / ${d.slice(2)}`;
  if (d.length === 2 && raw.length >= previous.length) return `${d} / `;
  return d;
}

/** Card number in printed groups; keeps the caret on the same digit while the spacing changes. */
function CardNumberInput({
  id,
  value,
  onChange,
  valid,
  invalid,
  autoFocus,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  valid: boolean;
  invalid: boolean;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation("vault");
  const ref = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  const digits = value.replace(/\D/g, "");
  const brand = cardBrand(digits);

  useLayoutEffect(() => {
    const el = ref.current;
    const target = caret.current;
    caret.current = null;
    if (!el || target === null || document.activeElement !== el) return;
    let pos = 0;
    for (let seen = 0; pos < value.length && seen < target; pos++) if (/\d/.test(value[pos])) seen++;
    el.setSelectionRange(pos, pos);
  }, [value]);

  const onInput = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    let before = raw.slice(0, e.target.selectionStart ?? raw.length).replace(/\D/g, "").length;
    let next = raw.replace(/\D/g, "");
    // Backspace on a group space: drop the digit in front of it
    if (next === digits && raw.length < value.length && before > 0) {
      next = next.slice(0, before - 1) + next.slice(before);
      before -= 1;
    }
    const grouped = cardGroups(next.slice(0, 19)).join(" ");
    caret.current = Math.min(before, grouped.replace(/\D/g, "").length);
    onChange(grouped);
  };

  return (
    <InputGroup className="h-9">
      <InputGroupInput
        ref={ref}
        id={id}
        value={value}
        onChange={onInput}
        placeholder="1234 5678 9012 3456"
        inputMode="numeric"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        autoFocus={autoFocus}
        aria-invalid={invalid}
        className="font-mono tracking-wide tabular-nums placeholder:font-sans placeholder:tracking-normal"
      />
      <InputGroupAddon align="inline-end" aria-live="polite">
        {digits.length > 0 && (
          <span className="flex items-center gap-1 text-xs font-medium text-foreground/75">
            {brand !== "other" && CARD_BRAND_LABELS[brand]}
            {valid && <Check className="size-3.5 text-success" aria-label={t("cardDialog.validNumber")} />}
          </span>
        )}
      </InputGroupAddon>
    </InputGroup>
  );
}

function MoneyInput({
  id,
  currency,
  value,
  onChange,
  invalid,
  placeholder,
  clearable,
  className,
}: {
  id: string;
  currency: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  placeholder?: string;
  clearable?: boolean;
  className?: string;
}) {
  const { t } = useTranslation("vault");
  return (
    <InputGroup className={cn("h-9", className)}>
      <InputGroupAddon>
        <span className="text-xs tabular-nums">{currency}</span>
      </InputGroupAddon>
      <InputGroupInput
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^\d.,'\s]/g, ""))}
        onBlur={() => {
          const minor = toMinor(value);
          if (minor !== null && !Number.isNaN(minor)) onChange(toMajorInput(minor));
        }}
        placeholder={placeholder ?? t("cardDialog.noLimit")}
        inputMode="decimal"
        autoComplete="off"
        aria-invalid={invalid}
        className="tabular-nums"
      />
      {clearable && value && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label={t("cardDialog.noLimit")} title={t("cardDialog.noLimit")} onClick={() => onChange("")}>
            <X />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}

function BillingFields({
  id,
  value,
  onChange,
  onRemove,
}: {
  id: (s: string) => string;
  value: CardBilling;
  onChange: (value: CardBilling) => void;
  onRemove?: () => void;
}) {
  const set = (k: keyof CardBilling) => (e: ChangeEvent<HTMLInputElement>) => onChange({ ...value, [k]: e.target.value });
  const { t } = useTranslation("vault");
  const known = isBillingCountry(value.country);
  return (
    <div className="space-y-4">
      <FormField label={t("billing.line1")} htmlFor={id("line1")}>
        <Input id={id("line1")} value={value.line1} onChange={set("line1")} autoComplete="off" maxLength={200} />
      </FormField>
      <FormField label={t("billing.line2")} htmlFor={id("line2")}>
        <Input id={id("line2")} value={value.line2} onChange={set("line2")} placeholder={t("optional")} autoComplete="off" maxLength={200} />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-[9rem_minmax(0,1fr)]">
        <FormField label={t("billing.postalCode")} htmlFor={id("postal")}>
          <Input id={id("postal")} value={value.postalCode} onChange={set("postalCode")} autoComplete="off" maxLength={20} />
        </FormField>
        <FormField label={t("billing.city")} htmlFor={id("city")}>
          <Input id={id("city")} value={value.city} onChange={set("city")} autoComplete="off" maxLength={100} />
        </FormField>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={t("billing.state")} htmlFor={id("state")}>
          <Input id={id("state")} value={value.state} onChange={set("state")} placeholder={t("optional")} autoComplete="off" maxLength={100} />
        </FormField>
        <FormField label={t("billing.country")} htmlFor={id("country")}>
          <Select value={value.country || NO_COUNTRY} onValueChange={(v) => onChange({ ...value, country: v === NO_COUNTRY ? "" : v })}>
            <SelectTrigger id={id("country")} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_COUNTRY}>
                <span className="text-muted-foreground">{t("billing.noCountry")}</span>
              </SelectItem>
              <SelectSeparator />
              {!known && value.country && <SelectItem value={value.country}>{value.country}</SelectItem>}
              {BILLING_COUNTRIES.map((code) => (
                <SelectItem key={code} value={code}>
                  {countryName(code)}
                  <span className="text-muted-foreground">{code}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </div>
      {onRemove && (
        <Button type="button" size="xs" variant="ghost" className="text-muted-foreground" onClick={onRemove}>
          <Trash2 /> {t("billing.remove")}
        </Button>
      )}
    </div>
  );
}

function ReplaceHint({ onKeep }: { onKeep: () => void }) {
  const { t } = useTranslation("vault");
  return (
    <span>
      {t("cardDialog.replaceHint")}{" "}
      <button type="button" onClick={onKeep} className="text-foreground underline decoration-foreground/25 underline-offset-2 hover:decoration-foreground">
        {t("cardDialog.keepCurrent")}
      </button>
    </span>
  );
}

function SealedBox({ icon, text, children }: { icon: ReactNode; text: string; children: ReactNode }) {
  return (
    <div className="flex h-9 items-center gap-2 rounded-md border border-dashed bg-paper-2 pr-1.5 pl-3 text-sm text-muted-foreground [&>svg]:size-3.5 [&>svg]:shrink-0">
      {icon}
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {children}
    </div>
  );
}

function FormSection({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <h3 className="eyebrow">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function FormField({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 space-y-2", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
