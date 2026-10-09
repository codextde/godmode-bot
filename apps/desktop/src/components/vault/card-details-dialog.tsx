import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { cardDigits, cardGroups, type PaymentCard, type PaymentCardSecrets } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { CopyButton } from "./copy-button";
import { PaymentCardFace } from "./payment-card-face";
import { countryName, formatExpiry } from "./card-utils";
import { isGrantCancelled, withGrant } from "./grant";
import { toastApiError } from "./vault-utils";

const SHOW_SECONDS = 60;

interface Revealed {
  card: PaymentCard;
  secrets: PaymentCardSecrets;
}

/**
 * "Show card details": asks for the passphrase if needed, then shows the full card for 60 seconds. The secrets live
 * only in this hook's state (never in the query cache) and are dropped when the dialog closes.
 */
export function useCardDetails() {
  const qc = useQueryClient();
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [open, setOpen] = useState(false);
  const [revealingId, setRevealingId] = useState<string | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (clearTimer.current && clearTimeout(clearTimer.current)), []);

  const show = useCallback(
    async (card: PaymentCard) => {
      setRevealingId(card.id);
      try {
        const secrets = await withGrant((grant) => api.cards.reveal(card.id, grant), "Confirm with your vault passphrase to show this card's details.");
        if (clearTimer.current) clearTimeout(clearTimer.current);
        setRevealed({ card, secrets });
        setOpen(true);
      } catch (e) {
        if (!isGrantCancelled(e)) toastApiError(e, "Could not show card details", qc);
      } finally {
        setRevealingId(null);
      }
    },
    [qc],
  );

  const close = useCallback(() => {
    setOpen(false);
    // Keep the content through the close animation, then drop the secrets.
    if (clearTimer.current) clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => setRevealed(null), 250);
  }, []);

  const dialog = (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-md">
        {revealed && <CardDetails key={revealed.card.id} revealed={revealed} open={open} onClose={close} />}
      </DialogContent>
    </Dialog>
  );

  return { show, revealingId, dialog };
}

function CardDetails({ revealed: { card, secrets }, open, onClose }: { revealed: Revealed; open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(onClose, SHOW_SECONDS * 1000);
    return () => clearTimeout(t);
  }, [open, onClose]);

  const digits = cardDigits(secrets.number);
  const expiry = formatExpiry(card.expMonth, card.expYear);
  const billing = secrets.billing;
  const addressLines = billing
    ? [billing.line1, billing.line2, [billing.postalCode, billing.city].filter(Boolean).join(" "), billing.state, billing.country ? countryName(billing.country) : ""].filter(Boolean)
    : [];

  return (
    <div className="flex flex-col">
      <div className="relative flex items-start gap-4 px-6 pt-6 pb-5">
        <PaymentCardFace
          brand={card.brand}
          last4={card.last4}
          label={card.name}
          holderName={card.holderName}
          expMonth={card.expMonth}
          expYear={card.expYear}
          frozen={card.frozen}
          className="w-36 shrink-0 rounded-xl"
        />
        <div className="min-w-0 pr-6">
          <DialogTitle className="truncate text-lg">{card.name}</DialogTitle>
          <DialogDescription className="mt-1">Hides automatically after {SHOW_SECONDS} seconds. Revealing a card is audited.</DialogDescription>
        </div>
        <motion.div
          key={card.id}
          aria-hidden
          className="absolute bottom-0 left-0 h-px bg-brand"
          initial={{ width: "100%" }}
          animate={{ width: "0%" }}
          transition={{ duration: SHOW_SECONDS, ease: "linear" }}
        />
      </div>

      <dl className="divide-y border-y bg-paper-2/60">
        <DetailRow label="Card number" copy={<CopyButton value={digits} secret label="Copy card number" toastLabel="Card number copied" />}>
          <span className="font-mono text-[15px] tracking-[0.06em] tabular-nums select-all">{cardGroups(digits).join(" ")}</span>
        </DetailRow>
        <DetailRow label="Expires" copy={<CopyButton value={expiry} label="Copy expiry" toastLabel="Expiry copied" />}>
          <span className="font-mono tabular-nums">{expiry}</span>
        </DetailRow>
        <DetailRow label="Security code" copy={secrets.cvc ? <CopyButton value={secrets.cvc} secret label="Copy security code" toastLabel="Security code copied" /> : null}>
          {secrets.cvc ? <span className="font-mono tabular-nums select-all">{secrets.cvc}</span> : <span className="text-muted-foreground italic">Not saved</span>}
        </DetailRow>
        <DetailRow label="Name on card" copy={card.holderName ? <CopyButton value={card.holderName} label="Copy name" toastLabel="Name copied" /> : null}>
          {card.holderName ? <span>{card.holderName}</span> : <span className="text-muted-foreground italic">Not saved</span>}
        </DetailRow>
        <DetailRow label="Billing address" copy={addressLines.length ? <CopyButton value={addressLines.join("\n")} label="Copy address" toastLabel="Address copied" /> : null}>
          {addressLines.length ? (
            <address className="not-italic">
              {addressLines.map((line, i) => (
                <span key={i} className="block">
                  {line}
                </span>
              ))}
            </address>
          ) : (
            <span className="text-muted-foreground italic">Not saved</span>
          )}
        </DetailRow>
      </dl>

      <div className="flex justify-end px-6 py-4">
        <Button variant="outline" onClick={onClose}>
          Hide details
        </Button>
      </div>
    </div>
  );
}

function DetailRow({ label, copy, children }: { label: string; copy: ReactNode; children: ReactNode }) {
  return (
    <div className="px-6 py-2.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-h-8 items-center justify-between gap-3 text-sm">
        <div className="min-w-0 break-words">{children}</div>
        {copy}
      </dd>
    </div>
  );
}
