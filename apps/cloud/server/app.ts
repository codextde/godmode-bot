/**
 * The HTTP server of Godmode Cloud: answers the relay paths itself and hands everything else to Next. Kept apart from
 * main.ts (process start-up) so tests can run it on a free port with a stand-in for Next.
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { CLOUD_CONNECT_PATH, CLOUD_DEVICE_ID } from "@godmode/shared";
import { config } from "@/server/config";
import { clientIp, PEER_HEADER } from "@/server/ratelimit";
import { registerRelayHub, relayHub } from "@/server/relay-bridge";
import { relayHttp } from "./relay/http";
import { RelayHub, type HubTimings } from "./relay/hub";
import { denial, rejectUpgrade, sendDenial, sendJson } from "./relay/respond";
import { serveUiFile } from "./relay/static";
import { serveDashboard } from "./relay/ui";
import { relayWebSocket } from "./relay/ws";

export interface CloudServerOptions {
  dev: boolean;
  nextHandler: (req: IncomingMessage, res: ServerResponse) => unknown;
  /** Leave upgrades under /_next/ to Next (its development HMR socket). Defaults to `dev`. */
  nextUpgradeDevPassthrough?: boolean;
  /** Shown by /api/health; read from the app's package.json when not given. */
  version?: string;
  timings?: HubTimings;
}

export interface CloudServer {
  server: Server;
  hub: RelayHub;
  close(): Promise<void>;
}

function packageVersion(): string {
  try {
    const version = (JSON.parse(readFileSync(path.join(config().appDir, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The path a computer sees for `<prefix>/<id><rest>`: dot segments resolved, and refused (null) unless it stays under
 * /api/. Encoded slashes and backslashes are refused outright, so no later decoding can change where it points.
 */
function apiPath(rest: string, search: string): string | null {
  if (/%2f|%5c|\\/i.test(rest)) return null;
  let pathname: string;
  try {
    pathname = new URL(rest, "http://relay.invalid").pathname;
  } catch {
    return null;
  }
  return pathname.startsWith("/api/") ? pathname + search : null;
}

const notFound = denial(404, "not_found", "Not found.");
const noDevice = denial(404, "device_not_found", "This computer does not exist.");

export function createCloudServer(options: CloudServerOptions): CloudServer {
  const hub = new RelayHub(options.timings);
  registerRelayHub(hub);
  const version = options.version ?? packageVersion();
  const passthrough = options.nextUpgradeDevPassthrough ?? options.dev;
  const server = createServer();
  // Relayed uploads may stream for a long time; the relay enforces its own body limit and idle timeout. Keep-alive
  // outlives the reverse proxy's idle reuse, or reused connections race their close and POSTs fail with 502.
  server.requestTimeout = 0;
  server.headersTimeout = 100_000;
  server.keepAliveTimeout = 95_000;

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const q = url.indexOf("?");
    const pathname = q < 0 ? url : url.slice(0, q);
    const search = q < 0 ? "" : url.slice(q);

    if (pathname === "/api/health") {
      if (req.method !== "GET" && req.method !== "HEAD") return sendDenial(res, denial(405, "method_not_allowed", "Use GET."), { allow: "GET, HEAD" });
      return sendJson(res, 200, { ok: true, name: "godmode-cloud", version });
    }
    if (pathname === "/ui" || pathname.startsWith("/ui/")) return serveUiFile(req, res, pathname);

    const browser = /^\/d\/([^/]+)(\/.*)?$/.exec(pathname);
    if (browser || pathname === "/d" || pathname === "/d/") {
      const [, id, rest] = browser ?? [];
      if (!id || !CLOUD_DEVICE_ID.test(id)) return sendDenial(res, noDevice);
      if (rest === undefined) {
        res.writeHead(308, { location: `/d/${id}/${search}`, "cache-control": "no-store" });
        res.end();
        return;
      }
      if (rest === "/api" || rest.startsWith("/api/")) {
        const target = apiPath(rest, search);
        if (!target) return sendDenial(res, notFound);
        return relayHttp(hub, req, res, "cloud", id, target, clientIp(req.headers, req.socket.remoteAddress ?? null));
      }
      return serveDashboard(req, res, id);
    }

    if (pathname === "/gw" || pathname.startsWith("/gw/")) {
      const [, id, rest] = /^\/gw\/([^/]+)(\/.*)?$/.exec(pathname) ?? [];
      if (!id || !CLOUD_DEVICE_ID.test(id)) return sendDenial(res, noDevice);
      const target = rest ? apiPath(rest, search) : null;
      if (!target) return sendDenial(res, notFound);
      return relayHttp(hub, req, res, "mobile", id, target, clientIp(req.headers, req.socket.remoteAddress ?? null));
    }

    // Nothing of Next lives under /relay; plain HTTP to the link endpoint is a mistake.
    if (pathname === "/relay" || pathname.startsWith("/relay/")) return sendDenial(res, notFound);

    // Next code can't see the socket; clientIp() there reads the peer from this header, never from the client.
    const peer = req.socket.remoteAddress;
    if (peer) req.headers[PEER_HEADER] = peer;
    else delete req.headers[PEER_HEADER];
    await options.nextHandler(req, res);
  }

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = req.url ?? "/";
    const q = url.indexOf("?");
    const pathname = q < 0 ? url : url.slice(0, q);
    // Next serves its development HMR socket on the same server; its upgrade listener handles these.
    if (passthrough && pathname.startsWith("/_next/")) return;
    // Node removes its own error handler from upgraded sockets; a reset must not become an uncaught exception.
    socket.on("error", () => socket.destroy());

    if (pathname === CLOUD_CONNECT_PATH) return hub.handleConnect(req, socket, head);
    const ip = () => clientIp(req.headers, req.socket.remoteAddress ?? null);
    const browser = /^\/d\/([^/]+)\/api\/ws$/.exec(pathname);
    if (browser) {
      if (!CLOUD_DEVICE_ID.test(browser[1]!)) return rejectUpgrade(socket, noDevice);
      return relayWebSocket(hub, hub.clientServer, req, socket, head, "cloud", browser[1]!, ip());
    }
    const phone = /^\/gw\/([^/]+)\/api\/ws$/.exec(pathname);
    if (phone) {
      if (!CLOUD_DEVICE_ID.test(phone[1]!)) return rejectUpgrade(socket, noDevice);
      return relayWebSocket(hub, hub.clientServer, req, socket, head, "mobile", phone[1]!, ip());
    }
    // Nobody else would ever close an unknown upgrade: Node applies no timeout to it.
    socket.once("finish", () => socket.destroy());
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  }

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    handleRequest(req, res).catch((err: unknown) => {
      console.error("[cloud] request failed:", req.method, (req.url ?? "").split("?")[0], err);
      if (!res.headersSent) sendDenial(res, denial(500, "internal", "Something went wrong on our side."));
      else res.destroy();
    });
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    handleUpgrade(req, socket, head).catch((err: unknown) => {
      console.error("[cloud] upgrade failed:", (req.url ?? "").split("?")[0], err);
      rejectUpgrade(socket, denial(500, "internal", "Something went wrong on our side."));
    });
  });

  return {
    server,
    hub,
    async close() {
      server.close();
      server.closeIdleConnections();
      await hub.close();
      if (relayHub() === hub) registerRelayHub(null);
      server.closeAllConnections();
    },
  };
}
