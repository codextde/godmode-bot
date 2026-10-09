import type { CSSProperties, ReactNode } from "react";
import { Snowflake } from "lucide-react";
import { CARD_BRAND_LABELS, type CardBrand } from "@godmode/shared";
import { cn } from "@/lib/utils";
import { formatExpiry } from "./card-utils";

/** One quiet accent per network, mixed into an ink surface. */
const BRAND_TINT: Record<CardBrand, string> = {
  visa: "#4c6ef5",
  mastercard: "#f76707",
  amex: "#15aabf",
  discover: "#fd7e14",
  diners: "#adb5bd",
  jcb: "#40c057",
  unionpay: "#e03131",
  maestro: "#4dabf7",
  other: "#20c997",
};

/**
 * The card as it looks in a wallet: label and network on top, chip, "•••• 4242", holder and expiry. Sizes scale with
 * the face's width (container units), so the same face works as a tile and as a small preview.
 */
export function PaymentCardFace({
  brand,
  last4,
  label,
  holderName,
  expMonth,
  expYear,
  frozen = false,
  expired = false,
  className,
}: {
  brand: CardBrand;
  last4: string;
  label: string;
  holderName: string;
  expMonth: number | null;
  expYear: number | null;
  frozen?: boolean;
  expired?: boolean;
  className?: string;
}) {
  const expiry = expMonth && expYear ? formatExpiry(expMonth, expYear) : null;
  const brandLabel = CARD_BRAND_LABELS[brand];
  const description = [
    label,
    last4 ? `${brandLabel} ending in ${last4}` : brandLabel,
    expiry && `expires ${expiry}`,
    frozen && "frozen",
    expired && "expired",
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div
      role="img"
      aria-label={description}
      style={{ "--card-tint": BRAND_TINT[brand] } as CSSProperties}
      className={cn(
        "@container relative isolate aspect-[1.586] w-full overflow-hidden rounded-2xl bg-[#141518] text-white select-none",
        "shadow-[0_1px_2px_rgb(0_0_0/0.18),0_12px_28px_-16px_rgb(0_0_0/0.55)] ring-1 ring-white/10 ring-inset",
        className,
      )}
    >
      <div
        aria-hidden
        className={cn(
          "absolute inset-0 -z-10 transition-[filter,opacity] duration-300",
          "bg-[radial-gradient(85%_75%_at_100%_0%,color-mix(in_srgb,var(--card-tint)_30%,transparent)_0%,transparent_70%),linear-gradient(155deg,#25272c_0%,#17181b_55%,#101113_100%)]",
          frozen && "opacity-70 grayscale",
        )}
      />
      <div aria-hidden className="absolute inset-x-0 top-0 -z-10 h-px bg-white/12" />
      {frozen && <div aria-hidden className="absolute inset-0 -z-10 bg-[linear-gradient(160deg,rgb(186_206_224/0.10),transparent_60%)]" />}

      <div aria-hidden className={cn("flex h-full flex-col justify-between p-[6.5cqw]", frozen && "opacity-75")}>
        <div className="flex min-w-0 items-start justify-between gap-[3cqw]">
          <span className="min-w-0 truncate text-[clamp(10px,4.4cqw,15px)] leading-tight font-medium text-white/80">{label}</span>
          <span
            className={cn(
              "shrink-0 text-[clamp(10px,4.8cqw,17px)] leading-tight font-semibold tracking-[-0.01em]",
              brand === "other" ? "text-white/50" : "text-white/90",
              brand === "visa" && "italic",
            )}
          >
            {brandLabel}
          </span>
        </div>

        <div className="flex items-center justify-between gap-[2cqw]">
          <ChipGlyph />
          <div className="flex items-center gap-[1.5cqw]">
            {expired && <FaceChip>Expired</FaceChip>}
            {frozen && (
              <FaceChip className="text-sky-100">
                <Snowflake className="size-[1.1em]" /> Frozen
              </FaceChip>
            )}
          </div>
        </div>

        <div className="font-mono text-[clamp(13px,7.4cqw,26px)] leading-none font-medium tracking-[0.08em] text-white/95 tabular-nums">
          <span className="text-white/55">••••</span> {last4 || "••••"}
        </div>

        <div className="flex min-w-0 items-end justify-between gap-[3cqw]">
          <span className={cn("min-w-0 truncate text-[clamp(9px,3.6cqw,13px)] font-medium tracking-[0.08em] uppercase", holderName ? "text-white/75" : "text-white/35")}>
            {holderName || "Name on card"}
          </span>
          <span className="shrink-0 text-right leading-none">
            <span className="block text-[clamp(7px,2.5cqw,9px)] tracking-[0.14em] text-white/45 uppercase">Expires</span>
            <span className={cn("mt-[1cqw] block font-mono text-[clamp(10px,3.9cqw,14px)] tabular-nums", expiry ? "text-white/85" : "text-white/35")}>{expiry ?? "MM/YY"}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function FaceChip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[0.35em] rounded-full bg-white/10 px-[0.7em] py-[0.25em] text-[clamp(9px,3cqw,11px)] leading-none font-medium text-white/85 ring-1 ring-white/15 backdrop-blur-sm",
        className,
      )}
    >
      {children}
    </span>
  );
}

function ChipGlyph() {
  return (
    <svg viewBox="0 0 40 30" className="h-[clamp(14px,8cqw,30px)] w-auto shrink-0">
      <rect x="0.5" y="0.5" width="39" height="29" rx="5.5" fill="rgb(255 255 255 / 0.14)" stroke="rgb(255 255 255 / 0.22)" />
      <path d="M0.5 10.5h12M0.5 19.5h12M27.5 10.5h12M27.5 19.5h12M12.5 0.5v29M27.5 0.5v29M12.5 15h15" stroke="rgb(255 255 255 / 0.2)" fill="none" />
    </svg>
  );
}
