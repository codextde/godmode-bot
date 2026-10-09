import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { format, formatDistanceToNow } from "date-fns";
import { Ban, Bot, Check, CircleCheck, MessageSquare, MoreHorizontal, RotateCcw, Square, X } from "lucide-react";
import { cardLabel, formatMoney, type CardPurchase, type CardPurchasePatch, type PaymentCard } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AgentAvatar } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useAllAgents } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { isGrantCancelled, withGrant } from "./grant";
import { toastApiError } from "./vault-utils";

const FREES_ROOM = "Confirm with your vault passphrase: this frees room under the card's limits.";
const ALL = "all";

const TONES = {
  warning: "bg-warning/10 text-warning ring-warning/25",
  success: "bg-success/10 text-success ring-success/25",
  brand: "bg-brand-soft text-brand-strong ring-brand/25",
  muted: "bg-muted text-muted-foreground ring-border",
} as const;

function statusOf(p: CardPurchase): { label: string; tone: keyof typeof TONES; hint?: string } {
  switch (p.status) {
    case "pending":
      return { label: "Waiting for your OK", tone: "warning", hint: "The agent asked before paying. Approve or decline here or in the chat." };
    case "approved":
      return p.filledAt
        ? { label: "Card entered", tone: "brand", hint: "Godmode typed the card into the checkout. The agent hasn't reported the result yet." }
        : { label: "Approved", tone: "brand", hint: p.approvedBy === "human" ? "You approved it." : "Within the card's limits." };
    case "paid":
      return { label: "Paid", tone: "success" };
    case "failed":
      return p.settledBy === "agent" && p.filledAt
        ? { label: "Reported failed · still counted", tone: "warning", hint: "The card was typed in, so it counts toward the limits until you confirm nothing was charged." }
        : { label: "Not charged", tone: "muted" };
    case "declined":
      return { label: "Declined", tone: "muted" };
    case "expired":
      return { label: "Approval expired", tone: "muted", hint: "Approved, but the card was never used." };
    case "cancelled":
      return { label: "Withdrawn", tone: "muted" };
  }
}

/** The ledger: every purchase an agent made or asked to make with a card, newest first. */
export function CardPurchases({ cards, cardById, scoped }: { cards: PaymentCard[]; cardById: Map<string, PaymentCard>; scoped: boolean }) {
  const qc = useQueryClient();
  const [cardFilter, setCardFilter] = useState(ALL);
  useEffect(() => {
    if (cardFilter !== ALL && !cards.some((c) => c.id === cardFilter)) setCardFilter(ALL);
  }, [cards, cardFilter]);

  const list = useQuery({
    queryKey: [...qk.cardPurchases, cardFilter],
    queryFn: () => api.cards.purchases({ cardId: cardFilter === ALL ? undefined : cardFilter, limit: 200 }),
    placeholderData: keepPreviousData,
  });
  const { data: agents = [] } = useAllAgents();
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const purchases = useMemo(() => {
    const ids = new Set(cards.map((c) => c.id));
    return [...(list.data ?? [])].filter((p) => !scoped || ids.has(p.cardId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [list.data, cards, scoped]);

  const update = useMutation({
    mutationFn: ({ purchase, patch }: { purchase: CardPurchase; patch: CardPurchasePatch }) =>
      withGrant((grant) => api.cards.updatePurchase(purchase.id, patch, grant), FREES_ROOM),
    onSuccess: (_r, { patch }) => {
      void qc.invalidateQueries({ queryKey: qk.cards });
      if (patch.status === "paid") toast.success("Marked as paid");
      else if (patch.status === "failed") toast.success("Marked as not charged", { description: "It no longer counts toward the card's limits." });
      else if (patch.ended) toast.success("Subscription ended", { description: "It no longer counts toward later months." });
      else toast.success("Subscription active again", { description: "It counts toward the monthly limit again." });
    },
    onError: (e) => !isGrantCancelled(e) && toastApiError(e, "Could not update the purchase", qc),
  });
  const pendingId = update.isPending ? update.variables?.purchase.id : undefined;

  const decide = useMutation({
    mutationFn: ({ purchase, decision }: { purchase: CardPurchase; decision: "approve" | "decline" }) => api.questions.answer(purchase.questionId!, { decision }),
    onSuccess: (_r, { decision }) => {
      void qc.invalidateQueries({ queryKey: qk.cards });
      void qc.invalidateQueries({ queryKey: qk.questions });
      toast.success(decision === "approve" ? "Purchase approved" : "Purchase declined", {
        description: decision === "approve" ? "The agent continues and types the card in." : "The agent won't buy it.",
      });
    },
    onError: (e) => toastApiError(e, "Could not answer", qc),
  });
  const decidingId = decide.isPending ? decide.variables?.purchase.id : undefined;

  return (
    <section className="space-y-3" aria-labelledby="card-purchases-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="card-purchases-heading" className="eyebrow">
          Purchases
        </h2>
        {cards.length > 1 && (
          <Select value={cardFilter} onValueChange={setCardFilter}>
            <SelectTrigger size="sm" className="w-52" aria-label="Filter purchases by card">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All cards</SelectItem>
              <SelectSeparator />
              {cards.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  <span className="truncate">{c.name}</span>
                  <span className="text-muted-foreground tabular-nums">•••• {c.last4}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {list.isLoading ? (
        <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-card">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="size-8 rounded-lg" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-48" />
                <Skeleton className="h-3 w-64" />
              </div>
              <div className="flex flex-col items-end gap-1.5">
                <Skeleton className="h-3.5 w-20" />
                <Skeleton className="h-4 w-16 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      ) : list.isError && !list.data ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed bg-card/50 px-4 py-6 text-sm text-muted-foreground">
          <span>Couldn't load purchases. {errorMessage(list.error)}</span>
          <Button variant="outline" size="sm" onClick={() => list.refetch()}>
            Try again
          </Button>
        </div>
      ) : purchases.length === 0 ? (
        <p className="rounded-xl border border-dashed bg-card/50 px-4 py-8 text-center text-sm text-muted-foreground">
          No purchases yet. When an agent pays with a card, it shows up here.
        </p>
      ) : (
        <ul className={cn("divide-y overflow-hidden rounded-xl border bg-card shadow-card transition-opacity", list.isFetching && list.isPlaceholderData && "opacity-70")}>
          {purchases.map((p, i) => {
            const agent = p.agentId ? agentById.get(p.agentId) : undefined;
            const card = cardById.get(p.cardId);
            return (
              <motion.li key={p.id} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: Math.min(i, 10) * 0.02 } }}>
                <PurchaseRow
                  purchase={p}
                  agentName={agent?.name ?? "Deleted agent"}
                  agentAvatar={agent ? <AgentAvatar agent={agent} size="md" /> : null}
                  cardText={card ? cardLabel(card) : "Removed card"}
                  pending={pendingId === p.id}
                  onUpdate={(patch) => update.mutate({ purchase: p, patch })}
                  deciding={decidingId === p.id}
                  onDecide={(decision) => decide.mutate({ purchase: p, decision })}
                />
              </motion.li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function PurchaseRow({
  purchase: p,
  agentName,
  agentAvatar,
  cardText,
  pending,
  onUpdate,
  deciding,
  onDecide,
}: {
  purchase: CardPurchase;
  agentName: string;
  agentAvatar: ReactNode;
  cardText: string;
  pending: boolean;
  onUpdate: (patch: CardPurchasePatch) => void;
  deciding: boolean;
  onDecide: (decision: "approve" | "decline") => void;
}) {
  const created = new Date(p.createdAt);
  const status = statusOf(p);
  const subscription = p.recurrence !== "once";
  const canSettle = p.status === "approved" || (p.status === "failed" && p.settledBy === "agent");
  const canEnd = p.status === "paid" && subscription;
  const title = p.merchant || p.site || "Purchase";

  const meta = [
    <span key="agent" className="truncate">{agentName}</span>,
    <time key="date" dateTime={p.createdAt} title={format(created, "PPpp")} className="whitespace-nowrap">
      {formatDistanceToNow(created, { addSuffix: true })}
    </time>,
    p.site && p.site !== title ? <span key="site" className="truncate">{p.site}</span> : null,
    <span key="card" className="whitespace-nowrap">{cardText}</span>,
  ].filter(Boolean);

  const badge = (
    <span
      tabIndex={status.hint ? 0 : undefined}
      className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset outline-none focus-visible:ring-2 focus-visible:ring-ring/50", TONES[status.tone])}
    >
      {status.label}
    </span>
  );

  return (
    <div className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/30">
      {agentAvatar ?? (
        <div className="grid size-8 shrink-0 place-items-center rounded-lg border bg-paper-2 text-muted-foreground">
          <Bot className="size-4" />
        </div>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          {p.description && (
            <span className="min-w-0 truncate text-xs text-muted-foreground" title={p.description}>
              {p.description}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
          {meta.map((m, i) => (
            <span key={i} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && <span aria-hidden className="opacity-50">·</span>}
              {m}
            </span>
          ))}
        </div>
        {p.status === "pending" && p.questionId && (
          <div className="mt-2 flex items-center gap-1.5">
            <Button size="xs" onClick={() => onDecide("approve")} disabled={deciding}>
              {deciding ? <Spinner className="size-3" /> : <Check />} Approve {formatMoney(p.amount, p.currency)}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => onDecide("decline")} disabled={deciding}>
              <X /> Decline
            </Button>
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        <div className="flex items-center gap-1.5">
          {subscription && (
            <span
              className={cn(
                "inline-flex h-[18px] items-center rounded-[4px] border px-1 text-[10px] font-medium",
                p.endedAt ? "border-dashed text-muted-foreground" : "text-foreground/70",
              )}
              title={p.endedAt ? `Ended ${format(new Date(p.endedAt), "PP")}` : undefined}
            >
              {p.recurrence}
              {p.endedAt && " · ended"}
            </span>
          )}
          <span className={cn("text-sm font-medium tabular-nums", (p.endedAt || status.tone === "muted") && "text-muted-foreground")}>{formatMoney(p.amount, p.currency)}</span>
        </div>
        {status.hint ? (
          <Tooltip>
            <TooltipTrigger asChild>{badge}</TooltipTrigger>
            <TooltipContent className="max-w-64">{status.hint}</TooltipContent>
          </Tooltip>
        ) : (
          badge
        )}
      </div>

      <div className="flex w-[4.25rem] shrink-0 items-center justify-end gap-0.5">
        {p.conversationId && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button asChild variant="ghost" size="icon-sm" className="text-muted-foreground">
                <Link to={`/chat/${p.conversationId}`} aria-label="Open the chat">
                  <MessageSquare />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open the chat</TooltipContent>
          </Tooltip>
        )}
        {(canSettle || canEnd) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`Actions for ${title}`} disabled={pending}>
                {pending ? <Spinner /> : <MoreHorizontal />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {canSettle && (
                <>
                  <DropdownMenuItem onClick={() => onUpdate({ status: "paid" })}>
                    <CircleCheck /> Mark as paid
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onUpdate({ status: "failed" })}>
                    <Ban /> Not charged
                  </DropdownMenuItem>
                </>
              )}
              {canSettle && canEnd && <DropdownMenuSeparator />}
              {canEnd &&
                (p.endedAt ? (
                  <DropdownMenuItem onClick={() => onUpdate({ ended: false })}>
                    <RotateCcw /> Mark active again
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onClick={() => onUpdate({ ended: true })}>
                    <Square /> End subscription
                  </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}
