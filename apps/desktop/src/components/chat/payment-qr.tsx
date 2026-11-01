import { useMemo } from "react";
import { QrCode as QrIcon, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { encode } from "uqr";
import { formatIban, parsePayment } from "@/lib/payment-qr";
import { CopyButton } from "./copy-button";

const MARGIN = 4;

function PlainQr({ value, label }: { value: string; label: string }) {
  const qr = useMemo(() => encode(value, { ecc: "M", border: 0 }), [value]);
  const size = qr.size + MARGIN * 2;
  const path = useMemo(() => {
    let d = "";
    qr.data.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x + MARGIN} ${y + MARGIN}h1v1h-1z`)));
    return d;
  }, [qr]);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges" className="block size-44 shrink-0 rounded-md">
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}

function Row({ label, value, copy }: { label: string; value: string; copy?: string }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <div className="min-w-0 flex-1">
        <div className="text-muted-foreground text-xs">{label}</div>
        <div className="break-words text-sm">{value}</div>
      </div>
      <CopyButton text={copy ?? value} className="-mr-1 shrink-0" />
    </div>
  );
}

export function PaymentQr({ source }: { source: string }) {
  const { t, i18n } = useTranslation("chat");
  const parsed = useMemo(() => parsePayment(source), [source]);
  if (!parsed.ok) {
    return (
      <div className="not-prose my-3 flex max-w-xl items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
        <TriangleAlert className="size-4 shrink-0 text-destructive" />
        <span>{t(`payment.invalid.${parsed.error}`)}</span>
      </div>
    );
  }
  const p = parsed.payment;
  const amount = p.amount == null ? null : new Intl.NumberFormat(i18n.language, { style: "currency", currency: "EUR" }).format(p.amount);
  return (
    <div className="not-prose my-3 flex max-w-xl flex-wrap gap-4 rounded-xl border bg-card p-3">
      <div className="flex flex-col items-center gap-1.5">
        <PlainQr value={parsed.epc} label={t("payment.qrLabel")} />
        <div className="text-muted-foreground flex items-center gap-1 text-xs">
          <QrIcon className="size-3" />
          {t("payment.scan")}
        </div>
      </div>
      <div className="flex min-w-48 flex-1 flex-col gap-2">
        {amount && (
          <div className="flex items-center gap-1">
            <div className="text-2xl font-semibold tabular-nums">{amount}</div>
            <CopyButton text={p.amount!.toFixed(2).replace(".", i18n.language.startsWith("de") ? "," : ".")} />
          </div>
        )}
        <Row label={t("payment.recipient")} value={p.name} />
        <Row label="IBAN" value={formatIban(p.iban)} copy={p.iban} />
        {p.bic && <Row label="BIC" value={p.bic} />}
        {(p.reference || p.purpose) && <Row label={t("payment.purpose")} value={p.reference || p.purpose} />}
      </div>
    </div>
  );
}
