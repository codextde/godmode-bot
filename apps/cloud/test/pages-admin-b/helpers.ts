/**
 * The server actions read the session through `@/lib/session` (next/headers), which has no request in vitest. Each
 * test file mocks that module with `sessionModule`, which answers with whoever the test signed in and enforces
 * permissions the same way the real `checkPermission` does.
 */
import { createServer, type AddressInfo, type Server } from "node:net";
import type { SessionContext } from "@/server/auth/sessions";
import { forbidden, unauthorized } from "@/server/errors";
import { can, type PagePermission } from "@/server/rbac/permissions";

export interface SessionState {
  ctx: SessionContext | null;
}

/** What `vi.mock("@/lib/session", …)` in a test file answers with. */
export function sessionModule(state: SessionState) {
  const current = () => {
    if (!state.ctx) throw unauthorized("Your session has ended. Sign in again.");
    return state.ctx;
  };
  return {
    checkUser: async () => current(),
    checkPermission: async (permission: PagePermission) => {
      const ctx = current();
      if (!can(ctx, permission)) throw forbidden(permission === "owner" ? "Only an owner can do this." : "You don't have permission to do that.");
      return ctx;
    },
    requestMeta: async () => ({ ip: "203.0.113.9", userAgent: null }),
  };
}

/** A TCP port nothing listens on. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

/** A tiny SMTP server that accepts every message, so the "test and save" path runs without the internet. */
export function fakeSmtp(): Promise<{ port: number; messages: string[]; server: Server }> {
  const messages: string[] = [];
  const server = createServer((socket) => {
    let data = false;
    let body = "";
    socket.write("220 fake ESMTP\r\n");
    socket.on("data", (chunk) => {
      for (const line of chunk.toString("utf8").split("\r\n")) {
        if (data) {
          if (line === ".") {
            data = false;
            messages.push(body);
            body = "";
            socket.write("250 queued\r\n");
          } else body += `${line}\n`;
          continue;
        }
        if (!line) continue;
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") socket.write("250-fake\r\n250 8BITMIME\r\n");
        else if (cmd === "DATA") {
          data = true;
          socket.write("354 go ahead\r\n");
        } else if (cmd === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as AddressInfo).port, messages, server })));
}
