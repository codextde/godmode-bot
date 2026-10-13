/** Premium-rate and service numbers that cost per minute: an agent talked into calling one would run up the bill. */
const PREMIUM = [/^\+49(900|137|138|118|19)/, /^\+44(9|87|84|70)/, /^\+1(900|976)/, /^\+43(9|8[12])/, /^\+41(90|84)/];

export function isPremiumNumber(e164: string): boolean {
  return PREMIUM.some((re) => re.test(e164));
}

const ONE_DIGIT = new Set(["1", "7"]);
const TWO_DIGITS = new Set("20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98".split(" "));

/** The country calling code of an E.164 number ("+4930..." → "49"). */
export function callingCode(e164: string): string {
  const d = e164.replace(/^\+/, "");
  if (ONE_DIGIT.has(d.slice(0, 1))) return d.slice(0, 1);
  if (TWO_DIGITS.has(d.slice(0, 2))) return d.slice(0, 2);
  return d.slice(0, 3);
}
