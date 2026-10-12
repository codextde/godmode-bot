/** Premium-rate and service numbers that cost per minute: an agent talked into calling one would run up the bill. */
const PREMIUM = [/^\+49(900|137|138|118|19)/, /^\+44(9|87|84|70)/, /^\+1(900|976)/, /^\+43(9|8[12])/, /^\+41(90|84)/];

export function isPremiumNumber(e164: string): boolean {
  return PREMIUM.some((re) => re.test(e164));
}
