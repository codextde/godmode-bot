import { describe, expect, test } from "bun:test";
import { isValidBase32, parseOtpUri, reviewOtpUris } from "@godmode/shared";

const varint = (n: number) => {
  const out: number[] = [];
  while (n > 127) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  return [...out, n];
};
const text = (s: string) => [...new TextEncoder().encode(s)];
const field = (id: number, bytes: number[]) => [...varint(id * 8 + 2), ...varint(bytes.length), ...bytes];
const number = (id: number, n: number) => [...varint(id * 8), ...varint(n)];

/** Google Authenticator's export as it comes out of a QR code. */
function migration(accounts: { name: string; issuer?: string; digits?: number; type?: number; algorithm?: number }[], part: { size: number; index: number; id: number }) {
  const bytes = accounts.flatMap((a) =>
    field(1, [...field(1, [1, 2, 3]), ...field(2, text(a.name)), ...(a.issuer ? field(3, text(a.issuer)) : []), ...number(4, a.algorithm ?? 1), ...number(5, a.digits ?? 1), ...number(6, a.type ?? 2)]),
  );
  const payload = [...bytes, ...number(2, 1), ...number(3, part.size), ...number(4, part.index), ...number(5, part.id)];
  return `otpauth-migration://offline?data=${encodeURIComponent(Buffer.from(payload).toString("base64"))}`;
}

describe("otp links", () => {
  test("reads a link with its settings and flags what can't work", () => {
    const parsed = parseOtpUri("otpauth://hotp/GitHub:dan%40x.de?secret=ab&issuer=GitHub&algorithm=sha256&digits=8&period=60");
    expect(parsed).toMatchObject({ kind: "otpauth", preview: { type: "hotp", issuer: "GitHub", account: "dan@x.de", algorithm: "SHA256", digits: 8, period: 60, validSecret: false } });
    expect(parseOtpUri("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP")).toMatchObject({ preview: { validSecret: true, issuer: "Unknown" } });
    expect(parseOtpUri("https://example.com")).toMatchObject({ kind: "invalid", problem: "not_two_factor" });
    expect(parseOtpUri("otpauth-migration://offline?x=1")).toMatchObject({ kind: "invalid", problem: "migration_no_data" });
    expect(parseOtpUri("otpauth-migration://offline?data=%21%21")).toMatchObject({ kind: "invalid", problem: "migration_unreadable" });
    expect(isValidBase32("jbsw y3dp ehpk 3pxp")).toBe(true);
  });

  test("reads an authenticator's export, names with umlauts too", () => {
    const uri = migration([{ name: "GitHub:dan@x.de", issuer: "GitHub" }, { name: "Büro:anna", digits: 2, type: 1, algorithm: 2 }], { size: 1, index: 0, id: 7 });
    expect(parseOtpUri(uri)).toMatchObject({
      kind: "migration",
      preview: {
        batchSize: 1,
        accounts: [
          { issuer: "GitHub", account: "dan@x.de", type: "totp", algorithm: "SHA1", digits: 6 },
          { issuer: "Büro", account: "anna", type: "hotp", algorithm: "SHA256", digits: 8 },
        ],
      },
    });
  });

  test("counts accounts and says how many parts of an export are missing", () => {
    const first = migration([{ name: "a" }, { name: "b" }], { size: 3, index: 0, id: 9 });
    const second = migration([{ name: "c" }], { size: 3, index: 1, id: 9 });
    const single = "otpauth://totp/GitHub?secret=JBSWY3DPEHPK3PXP";
    const review = reviewOtpUris([first, second, single, "nonsense"]);
    expect(review.parsed).toHaveLength(3);
    expect(review.accountCount).toBe(4);
    expect(review.incomplete).toEqual([{ size: 3, missing: 1 }]);
    expect(reviewOtpUris([first, second, migration([{ name: "d" }], { size: 3, index: 2, id: 9 })]).incomplete).toEqual([]);
  });
});
