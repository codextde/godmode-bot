import { memo, type ReactNode } from "react";
import { motion } from "motion/react";
import { Bot, Eye, Globe, Hand, MoreHorizontal, Pencil, Receipt, Snowflake, Sun, Trash2 } from "lucide-react";
import { CARD_BRAND_LABELS, cardExpired, formatMoney, type Agent, type PaymentCard } from "@godmode/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScopeBadge } from "@/components/common";
import { cn } from "@/lib/utils";
import { PaymentCardFace } from "./payment-card-face";
import { approvalText } from "./card-utils";

export const CardTile = memo(function CardTile({
  card,
  index,
  agentsById,
  busy,
  onEdit,
  onShowDetails,
  onToggleFreeze,
  onDelete,
}: {
  card: PaymentCard;
  index: number;
  agentsById: Map<string, Agent>;
  /** A reveal or freeze for this card is in flight */
  busy?: boolean;
  onEdit: (card: PaymentCard) => void;
  onShowDetails: (card: PaymentCard) => void;
  onToggleFreeze: (card: PaymentCard) => void;
  onDelete: (card: PaymentCard) => void;
}) {
  const expired = cardExpired(card);
  const agentNames = (card.agentIds ?? []).map((id) => agentsById.get(id)?.name ?? "Deleted agent");

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.18 } }}
      transition={{ delay: Math.min(index, 12) * 0.03 }}
      onClick={(e) => {
        // The whole tile opens Edit; its own controls (and menus portaled out of it) handle their clicks.
        const target = e.target as HTMLElement;
        if (e.currentTarget.contains(target) && !target.closest("button, a, [role=menuitem]")) onEdit(card);
      }}
      className="group flex cursor-pointer flex-col rounded-[22px] border bg-card p-2 shadow-card transition hover:border-foreground/15 hover:shadow-float"
    >
      <button
        type="button"
        onClick={() => onEdit(card)}
        aria-label={`Edit ${card.name}: ${CARD_BRAND_LABELS[card.brand]} ending in ${card.last4}${card.frozen ? ", frozen" : ""}${expired ? ", expired" : ""}`}
        className="rounded-2xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <PaymentCardFace
          brand={card.brand}
          last4={card.last4}
          label={card.name}
          holderName={card.holderName}
          expMonth={card.expMonth}
          expYear={card.expYear}
          frozen={card.frozen}
          expired={expired}
          className="transition-transform duration-300 ease-out group-hover:-translate-y-0.5"
        />
      </button>

      <div className="space-y-3 px-1.5 pt-3 pb-1">
        <div className="flex items-start gap-2">
          <SpendMeter card={card} className="min-w-0 flex-1" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="-mt-1.5 -mr-1 text-muted-foreground" aria-label={`Actions for ${card.name}`} disabled={busy}>
                {busy ? <Spinner /> : <MoreHorizontal />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => onEdit(card)}>
                <Pencil /> Edit
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onShowDetails(card)}>
                <Eye /> Show card details
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onToggleFreeze(card)}>
                {card.frozen ? (
                  <>
                    <Sun /> Unfreeze
                  </>
                ) : (
                  <>
                    <Snowflake /> Freeze
                  </>
                )}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => onDelete(card)}>
                <Trash2 /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <RuleChip icon={<Receipt />}>
            {card.limitPerPurchase === null ? "No per-purchase limit" : `${formatMoney(card.limitPerPurchase, card.currency)} per purchase`}
          </RuleChip>
          <RuleChip icon={<Hand />}>{approvalText(card)}</RuleChip>
          <RuleChip icon={<Bot />} tooltip={agentNames.length ? agentNames.join(", ") : undefined}>
            {card.agentIds === null ? "All agents" : card.agentIds.length === 1 ? "1 agent" : `${card.agentIds.length} agents`}
          </RuleChip>
          {card.allowedSites.length > 0 && (
            <RuleChip icon={<Globe />} tooltip={card.allowedSites.length > 1 ? card.allowedSites.join(", ") : undefined}>
              {card.allowedSites.length === 1 ? card.allowedSites[0] : `${card.allowedSites.length} sites`}
            </RuleChip>
          )}
          <ScopeBadge workspaceId={card.workspaceId} className="max-w-full truncate" />
        </div>
      </div>
    </motion.div>
  );
});

/** "EUR 41.00 of EUR 200.00 this month" with a bar; warning tone above 80 %. */
function SpendMeter({ card, className }: { card: PaymentCard; className?: string }) {
  const spent = formatMoney(card.spentThisMonth, card.currency);
  if (card.limitMonthly === null) {
    return (
      <p className={cn("pt-0.5 text-[13px] tabular-nums", className)}>
        <span className="font-medium">{spent}</span> <span className="text-muted-foreground">this month · no monthly limit</span>
      </p>
    );
  }
  const limit = card.limitMonthly;
  const share = limit > 0 ? Math.min(1, card.spentThisMonth / limit) : 1;
  const state = card.spentThisMonth >= limit ? "full" : share > 0.8 ? "warning" : "ok";
  const sentence = `${spent} of ${formatMoney(limit, card.currency)} this month`;
  return (
    <div className={cn("space-y-1.5 pt-0.5", className)}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px]">
        <span className="tabular-nums">
          <span className="font-medium">{spent}</span> <span className="text-muted-foreground">of {formatMoney(limit, card.currency)} this month</span>
        </span>
        {state !== "ok" && (
          <span className={cn("ml-auto shrink-0 rounded-[4px] px-1.5 text-[11px] font-medium tabular-nums", state === "full" ? "bg-destructive/10 text-destructive" : "bg-warning/10 text-warning")}>
            {state === "full" ? "Limit reached" : `${Math.floor(share * 100)}% used`}
          </span>
        )}
      </div>
      <div role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(card.spentThisMonth, limit)} aria-valuetext={sentence} aria-label="Spent this month" className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-[width] duration-500", state === "full" ? "bg-destructive" : state === "warning" ? "bg-warning" : "bg-foreground/60")}
          style={{ width: `${card.spentThisMonth > 0 ? Math.max(2, share * 100) : 0}%` }}
        />
      </div>
    </div>
  );
}

function RuleChip({ icon, tooltip, children }: { icon: ReactNode; tooltip?: string; children: ReactNode }) {
  const chip = (
    <Badge variant="outline" tabIndex={tooltip ? 0 : undefined} className="max-w-full gap-1 font-normal text-muted-foreground [&>svg]:text-muted-foreground/80">
      {icon}
      <span className="truncate">{children}</span>
    </Badge>
  );
  if (!tooltip) return chip;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent className="max-w-64">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export function CardTileSkeleton() {
  return (
    <div className="flex flex-col rounded-[22px] border bg-card p-2 shadow-card">
      <Skeleton className="aspect-[1.586] w-full rounded-2xl" />
      <div className="space-y-3 px-1.5 pt-3 pb-1">
        <Skeleton className="h-3.5 w-48" />
        <Skeleton className="h-1.5 w-full rounded-full" />
        <div className="flex gap-1.5">
          <Skeleton className="h-5 w-28 rounded-[5px]" />
          <Skeleton className="h-5 w-24 rounded-[5px]" />
          <Skeleton className="h-5 w-16 rounded-[5px]" />
        </div>
      </div>
    </div>
  );
}
