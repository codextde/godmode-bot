/**
 * A fake OCI registry for image download tests: anonymous bearer tokens (like ghcr.io), one small image for every
 * repository (a config and three layers), byte ranges, and a first blob request that breaks off halfway (so downloads
 * must resume). `…/shares-a` and `…/shares-b` are two images that share a layer, which `…/shares-b` also repeats (like
 * the real macOS images). `private/…` repositories refuse anonymous tokens; `…/does-not-exist` has no manifest.
 */
import { createHash, randomBytes } from "node:crypto";

export interface FakeRegistry {
  host: string;
  /** Digest of the layer `…/shares-a` and `…/shares-b` have in common. */
  sharedDigest: string;
  /** Blob requests per digest (and whether they asked for a range). */
  requests: { digest: string; range: string | null }[];
  layers: Buffer[];
  stop: () => void;
}

export function startFakeRegistry(): FakeRegistry {
  const config = Buffer.from(JSON.stringify({ arch: "arm64", os: "darwin" }));
  const layers = [randomBytes(150_000), randomBytes(90_000), randomBytes(40_000)];
  const digest = (b: Buffer) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
  const shared = randomBytes(120_000);
  const onlyA = randomBytes(60_000);
  const onlyB = randomBytes(70_000);
  const blobs = new Map([config, ...layers, shared, onlyA, onlyB].map((b) => [digest(b), b]));
  const manifestOf = (imageLayers: Buffer[]) =>
    Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: { mediaType: "application/vnd.cirruslabs.tart.config.v1", digest: digest(config), size: config.length },
        layers: imageLayers.map((l) => ({ mediaType: "application/vnd.cirruslabs.tart.disk.v2", digest: digest(l), size: l.length })),
      }),
    );
  const manifest = manifestOf(layers);
  const manifestA = manifestOf([shared, onlyA]);
  const manifestB = manifestOf([shared, onlyB, shared, shared]);
  const requests: FakeRegistry["requests"] = [];
  let brokeOff = false;
  let host = "";
  const server: import("bun").Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req): Response {
      const url = new URL(req.url);
      if (url.pathname === "/token") {
        const scope = url.searchParams.get("scope") ?? "";
        if (scope.includes("private/")) return new Response("denied", { status: 401 });
        return Response.json({ token: "anon" });
      }
      const m = /^\/v2\/(.+)\/(manifests|blobs)\/(.+)$/.exec(url.pathname);
      if (!m) return new Response("not found", { status: 404 });
      const [, repo, kind, ref] = m;
      if (req.headers.get("authorization") !== "Bearer anon") {
        return new Response("unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": `Bearer realm="http://${host}/token",service="fake",scope="repository:${repo}:pull"` },
        });
      }
      if (kind === "manifests") {
        if (repo!.endsWith("does-not-exist")) return new Response("not found", { status: 404 });
        const body = repo!.endsWith("shares-a") ? manifestA : repo!.endsWith("shares-b") ? manifestB : manifest;
        return new Response(body, { headers: { "Content-Type": "application/vnd.oci.image.manifest.v1+json" } });
      }
      const blob = blobs.get(ref!);
      if (!blob) return new Response("not found", { status: 404 });
      const range = req.headers.get("range");
      requests.push({ digest: ref!, range });
      const start = Number(/^bytes=(\d+)-$/.exec(range ?? "")?.[1] ?? 0);
      // The first download of the biggest layer breaks off halfway: the client must resume with a range.
      if (!brokeOff && blob === layers[0] && start === 0) {
        brokeOff = true;
        const half = blob.subarray(0, blob.length / 2);
        // Promise half the bytes more than are sent, then end: the client sees a short body.
        return new Response(new Uint8Array(half), { headers: { "X-Declared-Length": String(blob.length) } });
      }
      const body = blob.subarray(start);
      return new Response(new Uint8Array(body), {
        status: start ? 206 : 200,
        headers: start ? { "Content-Range": `bytes ${start}-${blob.length - 1}/${blob.length}` } : {},
      });
    },
  });
  host = `127.0.0.1:${server.port}`;
  return { host, sharedDigest: digest(shared), requests, layers, stop: () => server.stop(true) };
}
