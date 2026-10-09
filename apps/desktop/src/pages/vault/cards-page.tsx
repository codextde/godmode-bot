import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence } from "motion/react";
import { Bot, CreditCard, Lock, Plus, ShieldCheck, SearchX } from "lucide-react";
import type { PaymentCard } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { EmptyState, PageBody, PageHeader } from "@/components/common";
import { CardDialog } from "@/components/vault/card-dialog";
import { useCardDetails } from "@/components/vault/card-details-dialog";
import { CardPurchases } from "@/components/vault/card-purchases";
import { CardTile, CardTileSkeleton } from "@/components/vault/card-tile";
import { ConfirmDeleteDialog } from "@/components/vault/confirm-dialog";
import { ScopeFilterSelect } from "@/components/vault/workspace-select";
import { isGrantCancelled, withGrant } from "@/components/vault/grant";
import { isVaultLocked, toastApiError } from "@/components/vault/vault-utils";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useAllAgents } from "@/lib/hooks";
import { useUi } from "@/stores/ui";
import { toast } from "sonner";

const byName = new Intl.Collator(undefined, { sensitivity: "base" });

export default function CardsPage() {
  const qc = useQueryClient();
  const sidebarScope = useUi((s) => s.workspace);
  const [scope, setScope] = useState(sidebarScope);
  useEffect(() => setScope(sidebarScope), [sidebarScope]);

  const list = useQuery({ queryKey: qk.cardList(scope), queryFn: () => api.cards.list({ workspaceId: scope }) });
  const all = useQuery({ queryKey: qk.cardList("all"), queryFn: () => api.cards.list({ workspaceId: "all" }) });
  const { data: agents = [] } = useAllAgents();
  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  useEffect(() => {
    if (list.error && isVaultLocked(list.error)) toastApiError(list.error, "Vault locked", qc);
  }, [list.error, qc]);

  const cards = useMemo(() => [...(list.data ?? [])].sort((a, b) => byName.compare(a.name, b.name)), [list.data]);
  const cardById = useMemo(() => new Map([...(all.data ?? []), ...(list.data ?? [])].map((c) => [c.id, c])), [all.data, list.data]);

  // Dialog state (+ deep link ?new=1)
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState<{ open: boolean; card: PaymentCard | null }>({ open: false, card: null });
  useEffect(() => {
    if (params.get("new") === "1") setDialog({ open: true, card: null });
  }, [params]);
  const closeDialog = (open: boolean) => {
    if (open) return;
    setDialog((d) => ({ ...d, open: false }));
    if (params.has("new")) {
      const next = new URLSearchParams(params);
      next.delete("new");
      setParams(next, { replace: true });
    }
  };
  const openCreate = () => setDialog({ open: true, card: null });
  const openEdit = useCallback((card: PaymentCard) => setDialog({ open: true, card }), []);

  const details = useCardDetails();
  const showDetails = details.show;

  const freeze = useMutation({
    mutationFn: (card: PaymentCard) =>
      withGrant((grant) => api.cards.update(card.id, { frozen: !card.frozen }, grant), "Confirm with your vault passphrase to unfreeze this card."),
    onSuccess: (saved) => {
      qc.setQueriesData<PaymentCard[]>({ queryKey: qk.cards }, (old) => (Array.isArray(old) ? old.map((c) => (c.id === saved.id ? saved : c)) : old));
      void qc.invalidateQueries({ queryKey: qk.cards });
      if (saved.frozen) toast.success("Card frozen", { description: "Agents can't pay with it until you unfreeze it." });
      else toast.success("Card unfrozen", { description: "Agents can pay with it again, within its limits." });
    },
    onError: (e) => !isGrantCancelled(e) && toastApiError(e, "Could not change the card", qc),
  });
  const toggleFreeze = useCallback((card: PaymentCard) => freeze.mutate(card), [freeze.mutate]);

  const [toDelete, setToDelete] = useState<PaymentCard | null>(null);
  const del = useMutation({
    mutationFn: (id: string) => api.cards.delete(id),
    onSuccess: (_r, id) => {
      qc.setQueriesData<PaymentCard[]>({ queryKey: qk.cards }, (old) => (Array.isArray(old) ? old.filter((c) => c.id !== id) : old));
      void qc.invalidateQueries({ queryKey: qk.cards });
      toast.success("Card deleted");
      setToDelete(null);
    },
    onError: (e) => toastApiError(e, "Could not delete card", qc),
  });

  const busyId = details.revealingId ?? (freeze.isPending ? freeze.variables?.id : undefined);
  const defaultWorkspaceId = scope !== "all" && scope !== "global" ? scope : null;
  const hasAnyCard = (all.data?.length ?? 0) > 0;

  return (
    <div className="relative">
      <PageHeader
        icon={<CreditCard />}
        title="Cards"
        description="Payment cards your agents can pay with, within the limits you set. Encrypted in your local vault."
        actions={
          <Button onClick={openCreate}>
            <Plus /> Add card
          </Button>
        }
      />
      <PageBody className="space-y-4">
        <TrustStrip />

        {(hasAnyCard || scope !== "all" || list.isLoading) && (
          <div className="flex flex-wrap items-center gap-2">
            <ScopeFilterSelect value={scope} onChange={setScope} />
            {list.data && (
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                {cards.length} {cards.length === 1 ? "card" : "cards"}
              </span>
            )}
          </div>
        )}

        {list.isLoading ? (
          <div className="@container">
            <div className="grid gap-4 @xl:grid-cols-2 @4xl:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <CardTileSkeleton key={i} />
              ))}
            </div>
          </div>
        ) : list.isError && !list.data ? (
          <EmptyState
            icon={<Lock />}
            title={isVaultLocked(list.error) ? "The vault is locked" : "Couldn't load cards"}
            description={isVaultLocked(list.error) ? "Unlock the vault to see your cards." : errorMessage(list.error)}
            action={
              <Button variant="outline" onClick={() => list.refetch()}>
                Try again
              </Button>
            }
          />
        ) : cards.length === 0 ? (
          scope !== "all" ? (
            <EmptyState
              icon={<SearchX />}
              title="No cards in this scope"
              description="Cards saved as Global are available everywhere. Switch the scope filter to see them."
              action={
                <Button onClick={openCreate}>
                  <Plus /> Add card
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<CreditCard />}
              title="Let your agents pay for what they need"
              description="Add a card with a spending limit. Agents ask before they buy, Godmode types the card into the checkout, and every purchase is listed here."
              action={
                <Button onClick={openCreate}>
                  <Plus /> Add a card
                </Button>
              }
            />
          )
        ) : (
          <>
            <div className="@container">
              <div className="grid gap-4 @xl:grid-cols-2 @4xl:grid-cols-3">
                <AnimatePresence initial={false}>
                  {cards.map((c, i) => (
                    <CardTile
                      key={c.id}
                      card={c}
                      index={i}
                      agentsById={agentsById}
                      busy={busyId === c.id}
                      onEdit={openEdit}
                      onShowDetails={showDetails}
                      onToggleFreeze={toggleFreeze}
                      onDelete={setToDelete}
                    />
                  ))}
                </AnimatePresence>
              </div>
            </div>

            <div className="pt-4">
              <CardPurchases cards={cards} cardById={cardById} scoped={scope !== "all"} />
            </div>
          </>
        )}
      </PageBody>

      <CardDialog open={dialog.open} onOpenChange={closeDialog} card={dialog.card} defaultWorkspaceId={defaultWorkspaceId} />
      {details.dialog}

      <ConfirmDeleteDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={`Delete “${toDelete?.name}”?`}
        description="The card is removed from the vault. Its purchase history is deleted too."
        pending={del.isPending}
        onConfirm={() => toDelete && del.mutate(toDelete.id)}
      />
    </div>
  );
}

function TrustStrip() {
  const items = [
    { icon: <Lock />, title: "Encrypted on this device", text: "AES-256-GCM, unlocked by your vault passphrase." },
    { icon: <Bot />, title: "Agents never see the card", text: "Godmode types it into the checkout and masks it wherever an agent could read it back." },
    { icon: <ShieldCheck />, title: "Your limits, enforced", text: "Loosening a card's limits needs your passphrase." },
  ];
  return (
    <div className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border bg-border shadow-card @3xl:grid-cols-3">
      {items.map((it) => (
        <div key={it.title} className="flex items-start gap-3 bg-card px-4 py-3">
          <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-brand-soft text-brand-strong [&_svg]:size-4">{it.icon}</div>
          <div className="min-w-0">
            <p className="text-xs font-medium">{it.title}</p>
            <p className="text-[11px] leading-snug text-muted-foreground">{it.text}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
