import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceStrict } from "date-fns";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, ChevronDown } from "lucide-react";
import type { Agent, Offer } from "@godmode/shared";
import { toast } from "sonner";
import { AgentAvatar } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

/**
 * What the main agent offers to take off the human's plate, spotted while it dreamt. "Do it" starts the chat that does
 * it; "No thanks" declines, and the next dream learns from both.
 */
export function OffersCard({ agents }: { agents: Agent[] }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: offers = [] } = useQuery({ queryKey: qk.offers, queryFn: api.offers.list, staleTime: 60_000 });
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const [busy, setBusy] = useState<string | null>(null);

  const accept = useMutation({
    mutationFn: (id: string) => api.offers.accept(id),
    onMutate: (id) => setBusy(id),
    onSuccess: ({ offer, conversation }) => {
      qc.setQueryData<Offer[]>(qk.offers, (cur) => cur?.filter((o) => o.id !== offer.id));
      qc.invalidateQueries({ queryKey: qk.offers });
      qc.invalidateQueries({ queryKey: qk.conversationsAll });
      navigate(`/chat/${conversation.id}`);
    },
    onError: (err) => {
      qc.invalidateQueries({ queryKey: qk.offers });
      toast.error("Couldn't start it", { description: errorMessage(err) });
    },
    onSettled: () => setBusy(null),
  });

  const dismiss = useMutation({
    mutationFn: (id: string) => api.offers.dismiss(id),
    onMutate: (id) => qc.setQueryData<Offer[]>(qk.offers, (cur) => cur?.filter((o) => o.id !== id)),
    onError: (err) => toast.error("Couldn't decline it", { description: errorMessage(err) }),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.offers }),
  });

  if (!offers.length) return null;
  const owner = agentById.get(offers[0]!.agentId);

  return (
    <section aria-labelledby="offers-title">
      <div className="mb-3 flex items-center gap-2">
        {owner && <AgentAvatar agent={owner} size="sm" still className="size-5 rounded-md text-[10px]" />}
        <h2 id="offers-title" className="eyebrow">
          {owner ? `${owner.name} can take these off your plate` : "Work your agent can take off your plate"}
        </h2>
      </div>
      <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-card">
        <AnimatePresence initial={false}>
          {offers.map((o) => (
            <OfferRow
              key={o.id}
              offer={o}
              pending={busy === o.id}
              disabled={busy !== null}
              onAccept={() => accept.mutate(o.id)}
              onDismiss={() => dismiss.mutate(o.id)}
            />
          ))}
        </AnimatePresence>
      </ul>
    </section>
  );
}

function OfferRow({
  offer,
  pending,
  disabled,
  onAccept,
  onDismiss,
}: {
  offer: Offer;
  pending: boolean;
  disabled: boolean;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  const long = offer.prompt.length > 160 || offer.prompt.includes("\n");
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
      className="px-3.5 py-3"
    >
      <div className="flex flex-col gap-2.5 @xl:flex-row @xl:items-start @xl:gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] leading-snug font-medium">{offer.title}</p>
          {offer.why && <p className="mt-0.5 text-xs text-muted-foreground">{offer.why}</p>}
          <p className="mt-2 rounded-lg border-l-2 border-foreground/15 bg-muted/50 px-2.5 py-1.5 text-[12.5px] text-foreground/85">
            <span className="text-muted-foreground">Starts with: </span>
            <span className={cn("whitespace-pre-wrap", long && !open && "line-clamp-2")}>{offer.prompt}</span>
          </p>
          <p className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
            <time dateTime={offer.createdAt}>Offered {formatDistanceStrict(new Date(offer.createdAt), new Date(), { addSuffix: true })}</time>
            {long && (
              <>
                <span className="opacity-50">·</span>
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpen((v) => !v)}
                  className="inline-flex items-center gap-0.5 transition hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
                >
                  {open ? "Show less" : "Show all"}
                  <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} aria-hidden />
                </button>
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={disabled} onClick={onDismiss}>
            No thanks
          </Button>
          <Button size="sm" disabled={disabled} onClick={onAccept}>
            Do it
            {pending ? <Spinner /> : <ArrowRight />}
          </Button>
        </div>
      </div>
    </motion.li>
  );
}
