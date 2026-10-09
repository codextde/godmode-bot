import type { Context, Hono } from "hono";
import { audit } from "../../services/audit";
import { createCard, deleteCard, getCard, getPurchase, listCards, listPurchases, revealCard, updateCard, updatePurchase, widensSpending } from "../../vault/cards";
import { requireGrant } from "../grants";
import { body, z } from "../validate";

/** `workspaceId` query param: "all" (default) | "global" | <workspace id>. */
function scopeParam(c: Context): string | null | "all" {
  const raw = c.req.query("workspaceId");
  if (!raw || raw === "all") return "all";
  if (raw === "global") return null;
  return raw;
}

const cents = z.number().int().min(0).max(100_000_000);
const billingSchema = z.object({
  line1: z.string().max(200),
  line2: z.string().max(200),
  postalCode: z.string().max(20),
  city: z.string().max(100),
  state: z.string().max(100),
  country: z.string().max(2),
});

const cardSchema = z.object({
  workspaceId: z.string().min(1).max(100).nullable().optional(),
  name: z.string().trim().max(100),
  number: z.string().max(40).optional(),
  expMonth: z.number().int().min(1).max(12).optional(),
  expYear: z.number().int().min(0).max(2100).optional(),
  holderName: z.string().max(100).optional(),
  cvc: z.string().max(4).optional(),
  billing: billingSchema.nullable().optional(),
  currency: z.string().length(3).optional(),
  limitPerPurchase: cents.nullable().optional(),
  limitMonthly: cents.nullable().optional(),
  askAbove: cents.nullable().optional(),
  agentIds: z.array(z.string().min(1).max(100)).max(500).nullable().optional(),
  allowedSites: z.array(z.string().max(253)).max(100).optional(),
  frozen: z.boolean().optional(),
});

export function registerCardRoutes(app: Hono): void {
  app.get("/api/cards", (c) => c.json(listCards({ workspaceId: scopeParam(c), search: c.req.query("search") || undefined })));

  app.get("/api/cards/:id", (c) => c.json(getCard(c.req.param("id"))));

  app.post("/api/cards/:id/reveal", (c) => {
    requireGrant(c);
    const card = getCard(c.req.param("id"));
    const secrets = revealCard(card.id);
    audit("user", "card.reveal", card.id, { name: card.name });
    return c.json(secrets);
  });

  app.post("/api/cards", async (c) => {
    const input = await body(c, cardSchema);
    const card = createCard(input);
    audit("user", "card.create", card.id, { name: card.name, last4: card.last4, limitPerPurchase: card.limitPerPurchase, limitMonthly: card.limitMonthly, askAbove: card.askAbove });
    return c.json(card);
  });

  app.patch("/api/cards/:id", async (c) => {
    const input = await body(c, cardSchema.partial());
    const before = getCard(c.req.param("id"));
    // Spending more or elsewhere takes the vault passphrase, so the API token alone can't loosen a card.
    if (widensSpending(before, input)) requireGrant(c);
    const card = updateCard(before.id, input);
    const fields = Object.keys(input).filter((k) => k !== "number" && k !== "cvc" && k !== "billing");
    audit("user", "card.update", card.id, {
      name: card.name,
      fields: Object.keys(input),
      ...Object.fromEntries(fields.map((k) => [k, input[k as keyof typeof input]])),
    });
    return c.json(card);
  });

  app.delete("/api/cards/:id", (c) => {
    const card = getCard(c.req.param("id"));
    deleteCard(card.id);
    audit("user", "card.delete", card.id, { name: card.name, last4: card.last4 });
    return c.json({ ok: true as const });
  });

  app.get("/api/card-purchases", (c) => {
    const limit = Number(c.req.query("limit") ?? 100);
    return c.json(listPurchases({ cardId: c.req.query("cardId") || undefined, limit: Number.isFinite(limit) ? limit : 100 }));
  });

  app.patch("/api/card-purchases/:id", async (c) => {
    const input = await body(c, z.object({ status: z.enum(["paid", "failed"]).optional(), ended: z.boolean().optional() }));
    const before = getPurchase(c.req.param("id"));
    // Both free room under the card's limits.
    if (input.status === "failed" || input.ended === true) requireGrant(c);
    const purchase = updatePurchase(before.id, input);
    audit("user", "card.purchase_update", purchase.id, { cardId: purchase.cardId, ...input });
    return c.json(purchase);
  });
}
