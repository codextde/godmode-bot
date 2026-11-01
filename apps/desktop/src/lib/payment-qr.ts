export type Payment = {
  name: string;
  iban: string;
  bic: string;
  amount: number | null;
  purpose: string;
  reference: string;
};

export type PaymentParse = { ok: true; payment: Payment; epc: string } | { ok: false; error: "name" | "iban" | "amount" | "purpose" | "bic" };

const KEYS: Record<string, keyof Payment> = {
  name: "name",
  recipient: "name",
  empfänger: "name",
  empfaenger: "name",
  iban: "iban",
  bic: "bic",
  amount: "amount",
  betrag: "amount",
  purpose: "purpose",
  verwendungszweck: "purpose",
  reference: "reference",
  referenz: "reference",
};

export function normalizeIban(iban: string): string {
  return iban.replace(/\s+/g, "").toUpperCase();
}

export function formatIban(iban: string): string {
  return normalizeIban(iban).replace(/(.{4})(?=.)/g, "$1 ");
}

export function validIban(iban: string): boolean {
  const s = normalizeIban(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const digits = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1;
}

export function parseAmount(raw: string): number | null {
  let s = raw.replace(/\s|€|eur/gi, "");
  if (!s) return null;
  const comma = s.lastIndexOf(",");
  const dot = s.lastIndexOf(".");
  if (comma > -1 && dot > -1) s = comma > dot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (comma > -1) s = s.replace(/\./g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100) / 100;
}

export function parsePayment(source: string): PaymentParse {
  const p: Payment = { name: "", iban: "", bic: "", amount: null, purpose: "", reference: "" };
  let amountRaw = "";
  for (const line of source.split("\n")) {
    const m = /^\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(line);
    const key = m && KEYS[m[1]!.toLowerCase()];
    if (!m || !key) continue;
    if (key === "amount") amountRaw = m[2]!;
    else p[key] = m[2]!;
  }
  p.iban = normalizeIban(p.iban);
  p.bic = p.bic.replace(/\s+/g, "").toUpperCase();
  if (!p.name || p.name.length > 70) return { ok: false, error: "name" };
  if (!validIban(p.iban)) return { ok: false, error: "iban" };
  if (p.bic && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(p.bic)) return { ok: false, error: "bic" };
  if (amountRaw) {
    const amount = parseAmount(amountRaw);
    if (amount == null || Number.isNaN(amount) || amount < 0.01 || amount > 999999999.99) return { ok: false, error: "amount" };
    p.amount = amount;
  }
  if (p.purpose.length > 140 || p.reference.length > 35) return { ok: false, error: "purpose" };
  return { ok: true, payment: p, epc: epcPayload(p) };
}

export function epcPayload(p: Payment): string {
  const reference = p.reference.trim();
  return [
    "BCD",
    "002",
    "1",
    "SCT",
    p.bic,
    p.name,
    p.iban,
    p.amount == null ? "" : `EUR${p.amount.toFixed(2)}`,
    "",
    reference,
    reference ? "" : p.purpose,
  ]
    .join("\n")
    .replace(/\n+$/, "");
}
