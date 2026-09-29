// License keys look like GM-7KQ2M-X9RTA-4HWPZ-C3NVE: Crockford base32 (no I, L, O, U), 100 random bits.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newLicenseKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const chars = [...bytes].map((b) => ALPHABET[b & 31]).join('');
  return `GM-${chars.slice(0, 5)}-${chars.slice(5, 10)}-${chars.slice(10, 15)}-${chars.slice(15, 20)}`;
}

export function isLicenseKey(v: unknown): v is string {
  return typeof v === 'string' && /^GM(-[0-9A-HJKMNP-TV-Z]{5}){4}$/.test(v);
}
