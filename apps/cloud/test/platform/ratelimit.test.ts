import { afterEach, describe, expect, test, vi } from "vitest";
import { clientIp, PEER_HEADER, rateLimit, resetRateLimits, setProxyTrust } from "@/server/ratelimit";

afterEach(() => {
  vi.useRealTimers();
  resetRateLimits();
  setProxyTrust({ trustProxy: true, trustedProxyHops: 1 });
});

describe("rateLimit", () => {
  test("allows `limit` hits per window, then refuses until the window ends", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    for (let i = 0; i < 3; i++) expect(rateLimit("k", 3, 60_000).ok).toBe(true);
    const refused = rateLimit("k", 3, 60_000);
    expect(refused.ok).toBe(false);
    expect(refused.retryAfterMs).toBe(60_000);
    expect(rateLimit("other", 3, 60_000).ok).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(rateLimit("k", 3, 60_000).ok).toBe(true);
  });
});

const headers = (xff: string | null) => ({ get: (name: string) => (name === "x-forwarded-for" ? xff : null) });

describe("clientIp", () => {
  test("uses the socket address unless the peer is our proxy on a private network", () => {
    expect(clientIp(headers("6.6.6.6"), "203.0.113.5")).toBe("203.0.113.5");
    expect(clientIp(headers("6.6.6.6, 198.51.100.7"), "172.18.0.2")).toBe("198.51.100.7");
    expect(clientIp(headers("198.51.100.7"), "10.1.2.3")).toBe("198.51.100.7");
    expect(clientIp(headers("198.51.100.7"), "192.168.1.1")).toBe("198.51.100.7");
    expect(clientIp(headers("198.51.100.7"), "127.0.0.1")).toBe("198.51.100.7");
    expect(clientIp(headers("2001:db8::7"), "::1")).toBe("2001:db8::7");
    expect(clientIp(headers("198.51.100.7"), "::ffff:172.18.0.2")).toBe("198.51.100.7");
    expect(clientIp(headers("198.51.100.7"), "fd00::2")).toBe("198.51.100.7");
  });

  test("takes the entry trustedProxyHops from the right, never what the client wrote", () => {
    // The client sent "1.1.1.1"; Traefik appended the real address.
    expect(clientIp(headers("1.1.1.1, 198.51.100.7"), "172.18.0.2")).toBe("198.51.100.7");
    setProxyTrust({ trustProxy: true, trustedProxyHops: 2 });
    // CDN appended the client, Traefik appended the CDN.
    expect(clientIp(headers("1.1.1.1, 198.51.100.7, 203.0.113.80"), "172.18.0.2")).toBe("198.51.100.7");
    // Fewer entries than proxies: all were written by proxies, the leftmost is the furthest known.
    expect(clientIp(headers("198.51.100.7"), "172.18.0.2")).toBe("198.51.100.7");
  });

  test("falls back to the socket address for anything that is not an address", () => {
    expect(clientIp(headers("1.1.1.1, evil"), "172.18.0.2")).toBe("172.18.0.2");
    expect(clientIp(headers("1.1.1.1, 198.51.100.7:443"), "172.18.0.2")).toBe("172.18.0.2");
    expect(clientIp(headers(""), "172.18.0.2")).toBe("172.18.0.2");
    expect(clientIp(headers(null), "172.18.0.2")).toBe("172.18.0.2");
    expect(clientIp(headers("198.51.100.7"), null)).toBe("unknown");
    expect(clientIp(headers("198.51.100.7"), "not-an-ip")).toBe("unknown");
  });

  test("ignores X-Forwarded-For when trusting the proxy is off", () => {
    setProxyTrust({ trustProxy: false, trustedProxyHops: 1 });
    expect(clientIp(headers("198.51.100.7"), "172.18.0.2")).toBe("172.18.0.2");
  });

  test("reads Node header objects, including repeated headers", () => {
    expect(clientIp({ "x-forwarded-for": ["1.1.1.1", "198.51.100.7"] }, "10.0.0.2")).toBe("198.51.100.7");
    expect(clientIp({ "x-forwarded-for": "198.51.100.8" }, "10.0.0.2")).toBe("198.51.100.8");
    expect(clientIp({}, "10.0.0.2")).toBe("10.0.0.2");
  });

  test("the peer header name is fixed for the custom server", () => {
    expect(PEER_HEADER).toBe("x-godmode-peer");
  });
});
