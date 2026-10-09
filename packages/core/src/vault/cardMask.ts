/**
 * Card numbers of the vault's payment cards, as pages print them, while the vault is unlocked. Whatever an agent reads
 * from the browser (browser/proxy.ts) passes `maskCardNumbers`, so a number Godmode typed into a checkout field never
 * reaches the model — not in a DOM snapshot, an accessibility tree or a script's result.
 */
import { cardDigits, cardGroups } from "@godmode/shared";

/** variant → its mask ("•••• 4242") */
const masks = new Map<string, string>();

/** The number as digits and as printed: groups separated by a space, a dash or a no-break space. */
export function cardNumberVariants(number: string): string[] {
  const digits = cardDigits(number);
  if (!/^\d{12,19}$/.test(digits)) return [];
  const groups = cardGroups(digits);
  return [...new Set([digits, groups.join(" "), groups.join("-"), groups.join(" ")])];
}

export function addCardMask(number: string): string[] {
  const variants = cardNumberVariants(number);
  const mask = `•••• ${cardDigits(number).slice(-4)}`;
  for (const v of variants) masks.set(v, mask);
  return variants;
}

export function clearCardMasks(): void {
  masks.clear();
}

export function maskCardNumbers(text: string): string {
  if (masks.size === 0 || !text) return text;
  let out = text;
  for (const [variant, mask] of masks) {
    if (out.includes(variant)) out = out.split(variant).join(mask);
  }
  return out;
}
