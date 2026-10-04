/**
 * Limits a linked computer can't get around by sending too much: a Link on a stand-in socket, so what the cloud
 * queues and when the computer reads are under the test's control.
 */
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CLOUD_PROTOCOL, CloudClose, CloudFrame, decodeCloudFrame, encodeCloudFrame, type CloudHello } from "@godmode/shared";
import { addressKey } from "../../server/relay/limits";
import { HELLO_UPDATE_MS, LINK_BUFFER_MAX, Link, type LinkHooks } from "../../server/relay/link";

/** A socket that never writes anything out: sent frames stay queued until `flush()`. */
class StuckSocket extends EventEmitter {
  readonly sent: number[] = [];
  closed: { code: number; reason: string } | null = null;
  private callbacks: (() => void)[] = [];

  send(data: Uint8Array, _opts: unknown, cb: () => void): void {
    this.sent.push(decodeCloudFrame(data)?.type ?? -1);
    this.callbacks.push(cb);
  }

  close(code: number, reason: string): void {
    this.closed ??= { code, reason };
  }

  terminate(): void {}

  flush(): void {
    for (const cb of this.callbacks.splice(0)) cb();
  }

  frame(type: (typeof CloudFrame)[keyof typeof CloudFrame], payload?: object): void {
    this.emit("message", Buffer.from(encodeCloudFrame(type, 0, payload)), true);
  }
}

const HELLO: CloudHello = { protocol: CLOUD_PROTOCOL, version: "1.0.0", instanceId: "gm_x", name: "Mac", platform: "darwin", browserAccess: true, phoneAccess: true };

let socket: StuckSocket;
let link: Link;
let updates: string[];

function open(hooks: Partial<LinkHooks> = {}): void {
  link?.close(1000, "Opened again.");
  socket = new StuckSocket();
  updates = [];
  link = new Link(socket as unknown as WebSocket, { deviceId: "dvc_test", userId: "usr_test", account: { email: "a@example.com", name: null }, ip: null }, {
    welcome: async (l) => l.markWelcomed(),
    update: (_l, hello) => void updates.push(hello.name),
    closed: () => {},
    ...hooks,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  open();
});

afterEach(() => {
  link.close(1000, "Test over.");
  vi.useRealTimers();
});

describe("a computer that does not read", () => {
  test("Ping is answered while little is queued, and is a protocol error past LINK_BUFFER_MAX", () => {
    socket.frame(CloudFrame.Ping);
    expect(socket.sent).toEqual([CloudFrame.Pong]);
    expect(link.send(new Uint8Array(LINK_BUFFER_MAX))).toBe(true);
    socket.frame(CloudFrame.Ping);
    expect(socket.sent.filter((t) => t === CloudFrame.Pong)).toHaveLength(1);
    expect(socket.closed).toEqual({ code: CloudClose.Protocol, reason: "The computer is not reading." });
    expect(link.closed).toBe(true);
  });

  test("more than twice LINK_BUFFER_MAX queued closes the link", () => {
    expect(link.send(new Uint8Array(LINK_BUFFER_MAX))).toBe(true);
    expect(link.send(new Uint8Array(LINK_BUFFER_MAX))).toBe(true);
    expect(socket.closed).toBeNull();
    expect(link.send(new Uint8Array(1))).toBe(false);
    expect(socket.closed).toEqual({ code: CloudClose.Protocol, reason: "The computer is not reading." });
  });

  test("what was written out no longer counts", () => {
    expect(link.send(new Uint8Array(LINK_BUFFER_MAX + 1))).toBe(true);
    socket.flush();
    expect(link.backlog).toBe(0);
    socket.frame(CloudFrame.Ping);
    expect(socket.closed).toBeNull();
    expect(link.send(new Uint8Array(LINK_BUFFER_MAX))).toBe(true);
  });
});

describe("Hello sent again", () => {
  test("updates the record at most every 10 s, with the newest Hello", async () => {
    socket.frame(CloudFrame.Hello, { ...HELLO, name: "First" });
    await vi.advanceTimersByTimeAsync(0);
    expect(link.welcomed).toBe(true);
    socket.frame(CloudFrame.Hello, { ...HELLO, name: "Second" });
    expect(updates).toEqual(["Second"]);
    socket.frame(CloudFrame.Hello, { ...HELLO, name: "Third" });
    socket.frame(CloudFrame.Hello, { ...HELLO, name: "Fourth" });
    expect(updates).toEqual(["Second"]);
    await vi.advanceTimersByTimeAsync(HELLO_UPDATE_MS - 1);
    expect(updates).toEqual(["Second"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(updates).toEqual(["Second", "Fourth"]);
    expect(socket.closed).toBeNull();
  });

  test("more than 10 Hellos in a minute is a protocol error", async () => {
    for (let i = 0; i < 10; i++) socket.frame(CloudFrame.Hello, { ...HELLO, name: `Name ${i}` });
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.closed).toBeNull();
    socket.frame(CloudFrame.Hello, HELLO);
    expect(socket.closed).toEqual({ code: CloudClose.Protocol, reason: "Too many Hello frames." });
  });

  test("a minute later the count starts over", async () => {
    for (let i = 0; i < 10; i++) socket.frame(CloudFrame.Hello, { ...HELLO, name: `Name ${i}` });
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 10; i++) socket.frame(CloudFrame.Hello, { ...HELLO, name: `Again ${i}` });
    expect(socket.closed).toBeNull();
  });
});

describe("errors while handling a frame", () => {
  test("a bug of the cloud closes with 1011, not Protocol", async () => {
    open({
      update: () => {
        throw new TypeError("a bug in the cloud");
      },
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      socket.frame(CloudFrame.Hello, HELLO);
      await vi.advanceTimersByTimeAsync(0);
      socket.frame(CloudFrame.Hello, { ...HELLO, name: "Renamed" });
      expect(socket.closed).toEqual({ code: 1011, reason: "Internal error." });
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  test("a frame the computer may not send closes with Protocol", () => {
    socket.frame(CloudFrame.ReqHead, { method: "GET" });
    expect(socket.closed?.code).toBe(CloudClose.Protocol);
  });
});

describe("addressKey", () => {
  test("IPv4 as is, IPv6 by its /64 however it is written", () => {
    expect(addressKey("198.51.100.7")).toBe("198.51.100.7");
    expect(addressKey("unknown")).toBe("unknown");
    expect(addressKey("2001:db8:1:2::a")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:0DB8:0001:0002:ffff:0000:0000:000a")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressKey("2001:db8::1.2.3.4")).toBe("2001:db8:0:0::/64");
    expect(addressKey("::1")).toBe("0:0:0:0::/64");
    expect(addressKey("fe80::1%en0")).toBe("fe80:0:0:0::/64");
  });
});
