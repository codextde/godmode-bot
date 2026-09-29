/**
 * macOS images: downloaded once, kept as local template VMs that new VMs and resets clone (APFS copy-on-write).
 *
 * Tart pulls an image one layer per connection and starts a layer over when the connection drops, which turns a
 * 27 GB image into hours on slower or flaky links. So Godmode downloads the layers itself — many layers in parallel,
 * each resumed with range requests across failures and restarts in `<data>/vm/downloads` and verified against its
 * digest — then lets Tart pull them from a loopback registry (local disk speed) and keeps the result as the template
 * `gm-image-<hash>`. Images share layers (and repeat some), so a layer is downloaded once however many images need it.
 * Registries that refuse an anonymous pull fall back to Tart's own pull (which knows `tart login` credentials).
 */
import { createHash } from "node:crypto";
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, statfsSync, writeSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../log";
import { sleep } from "../util";
import * as tart from "./tart";

const log = logger("vm");

const PARALLEL = 16;
/** A download that received nothing for this long is restarted (resuming where it stopped). */
const STALL_MS = 60_000;
/** Attempts in a row without any progress before a layer (and the image) fails. */
const MAX_STUCK_ATTEMPTS = 8;
const MANIFEST_TYPES = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
];

export interface ImageProgress {
  phase: "download" | "unpack";
  /** 0–100, null = unknown. */
  percent: number | null;
  /** Bytes downloaded / total (download phase). */
  bytes?: { done: number; total: number };
}

/** The local VM that holds a downloaded image. */
export function templateName(image: string): string {
  return `gm-image-${createHash("sha256").update(image).digest("hex").slice(0, 16)}`;
}

export function isTemplateName(name: string): boolean {
  return /^gm-image-[0-9a-f]{16}$/.test(name);
}

function downloadsDir(): string {
  return join(tart.vmRoot(), "downloads");
}

interface ImageRef {
  registry: string;
  repository: string;
  reference: string;
}

export function parseImageRef(image: string): ImageRef {
  const at = image.indexOf("@");
  const slash = image.indexOf("/");
  const registry = image.slice(0, slash);
  const rest = image.slice(slash + 1);
  if (at >= 0) return { registry, repository: image.slice(slash + 1, at), reference: image.slice(at + 1) };
  const colon = rest.lastIndexOf(":");
  return colon >= 0 ? { registry, repository: rest.slice(0, colon), reference: rest.slice(colon + 1) } : { registry, repository: rest, reference: "latest" };
}

/** The registry refuses an anonymous pull (401/403): only Tart's own pull, with `tart login` credentials, can get it. */
class AuthRequired extends Error {}

let registryOverride: ((registry: string) => string | null) | null = null;

/** Tests: the base URL ("http://127.0.0.1:1234") to use for a registry host. null = https://<host>. */
export function __setRegistryForTests(fn: ((registry: string) => string | null) | null) {
  registryOverride = fn;
}

/* ------------------------------------------------------------------ */
/* Registry client (anonymous pulls)                                    */
/* ------------------------------------------------------------------ */

class RegistryClient {
  private token: string | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(private ref: ImageRef) {}

  private base(): string {
    return `${registryOverride?.(this.ref.registry) ?? `https://${this.ref.registry}`}/v2/${this.ref.repository}`;
  }

  /** Anonymous bearer token from the registry's auth challenge (ghcr.io, Docker Hub, …); one refresh at a time. */
  private authenticate(challenge: string | null): Promise<void> {
    this.refreshing ??= (async () => {
      const params = Object.fromEntries([...(challenge ?? "").matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
      if (!/^Bearer/i.test(challenge ?? "") || !params.realm) throw new AuthRequired(`${this.ref.registry} needs credentials`);
      const url = new URL(params.realm);
      if (params.service) url.searchParams.set("service", params.service);
      url.searchParams.set("scope", params.scope ?? `repository:${this.ref.repository}:pull`);
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.status === 401 || res.status === 403) throw new AuthRequired(`${this.ref.registry} refused an anonymous pull (HTTP ${res.status})`);
      // Anything else (429, 5xx) is worth another try.
      if (!res.ok) throw new Error(`token request failed (HTTP ${res.status})`);
      const body = (await res.json()) as { token?: string; access_token?: string };
      const token = body.token ?? body.access_token;
      if (!token) throw new AuthRequired(`${this.ref.registry} gave no token`);
      this.token = token;
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async get(path: string, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${this.base()}${path}`, {
        headers: { ...headers, ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        redirect: "follow",
        signal,
      });
      if (res.status !== 401) return res;
      await res.body?.cancel();
      if (i === 0) await this.authenticate(res.headers.get("www-authenticate"));
    }
    throw new AuthRequired(`${this.ref.registry} needs credentials`);
  }
}

interface Blob {
  digest: string;
  size: number;
}

interface Manifest {
  raw: ArrayBuffer;
  mediaType: string;
  digest: string;
  blobs: Blob[];
}

async function fetchManifest(client: RegistryClient, reference: string): Promise<Manifest> {
  const res = await client.get(`/manifests/${reference}`, { Accept: MANIFEST_TYPES.join(", ") }, AbortSignal.timeout(60_000));
  if (!res.ok) throw new Error(`The image's manifest could not be loaded (HTTP ${res.status})`);
  const raw = await res.arrayBuffer();
  const mediaType = res.headers.get("content-type")?.split(";")[0]?.trim() ?? MANIFEST_TYPES[0]!;
  const digest = `sha256:${createHash("sha256").update(Buffer.from(raw)).digest("hex")}`;
  if (reference.startsWith("sha256:") && digest !== reference) throw new Error(`The image's manifest doesn't match its digest ${reference}`);
  const json = JSON.parse(new TextDecoder().decode(raw)) as {
    mediaType?: string;
    manifests?: { digest: string; platform?: { architecture?: string } }[];
    config?: Blob;
    layers?: Blob[];
  };
  if (json.manifests) {
    const pick = json.manifests.find((m) => m.platform?.architecture === "arm64") ?? json.manifests[0];
    if (!pick) throw new Error("The image has no manifests");
    return fetchManifest(client, pick.digest);
  }
  if (!json.config || !Array.isArray(json.layers)) throw new Error("Unexpected image manifest");
  return { raw, mediaType: json.mediaType ?? mediaType, digest, blobs: [json.config, ...json.layers].map((b) => ({ digest: b.digest, size: b.size })) };
}

function blobPath(digest: string): string {
  const hex = digest.replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error(`Unexpected digest ${digest}`);
  return join(downloadsDir(), hex);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Download one blob to `<downloads>/<hex>` (resuming its `.part`), verified against its digest. `onBytes` gets the
 * bytes on disk as they change (negative when a bad partial file is dropped).
 */
async function downloadBlob(client: RegistryClient, blob: Blob, onBytes: (n: number) => void): Promise<void> {
  const target = blobPath(blob.digest);
  if (existsSync(target) && statSync(target).size === blob.size) {
    onBytes(blob.size);
    return;
  }
  const part = `${target}.part`;
  let reported = 0;
  const sync = (bytes: number) => {
    onBytes(bytes - reported);
    reported = bytes;
  };
  let stuck = 0;
  for (;;) {
    let have = existsSync(part) ? statSync(part).size : 0;
    if (have > blob.size) {
      rmSync(part, { force: true });
      have = 0;
    }
    sync(have);
    const before = have;
    try {
      if (have < blob.size) {
        // A request that stops delivering is dropped (and resumed) instead of hanging.
        const stall = new AbortController();
        let timer = setTimeout(() => stall.abort(), STALL_MS);
        try {
          const res = await client.get(`/blobs/${blob.digest}`, have ? { Range: `bytes=${have}-` } : {}, stall.signal);
          if (res.status !== 200 && res.status !== 206) throw new Error(`HTTP ${res.status}`);
          // Resume only where the server really continues; otherwise start over.
          const resumes = res.status === 206 && Number(/bytes (\d+)-/.exec(res.headers.get("content-range") ?? "")?.[1]) === have;
          const fd = openSync(part, resumes ? "a" : "w");
          if (!resumes) sync(0);
          try {
            const reader = res.body!.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              writeSync(fd, value);
              sync(reported + value.length);
              clearTimeout(timer);
              timer = setTimeout(() => stall.abort(), STALL_MS);
            }
          } finally {
            closeSync(fd);
          }
        } finally {
          clearTimeout(timer);
        }
      }
      if (statSync(part).size !== blob.size) throw new Error("incomplete");
      const digest = await sha256File(part);
      if (digest !== blob.digest) {
        rmSync(part, { force: true });
        sync(0);
        throw new Error(`digest mismatch (${digest})`);
      }
      renameSync(part, target);
      return;
    } catch (err) {
      // Only attempts that got nowhere count against the budget.
      stuck = (existsSync(part) ? statSync(part).size : 0) > before ? 0 : stuck + 1;
      if (stuck >= MAX_STUCK_ATTEMPTS) throw new Error(`Downloading part ${blob.digest.slice(7, 19)} failed: ${err instanceof Error ? err.message : err}`);
      log.debug(`blob ${blob.digest.slice(0, 19)}: ${err instanceof Error ? err.message : err}; retrying`);
      await sleep(Math.min(30_000, 1000 * 2 ** stuck));
    }
  }
}

/** Blob downloads in flight, shared by every image that needs the blob. */
const blobJobs = new Map<string, { promise: Promise<void>; listeners: Set<(n: number) => void> }>();
/** How many in-flight image downloads still need each blob (the others' files can go). */
const blobHolds = new Map<string, number>();

function fetchBlob(client: RegistryClient, blob: Blob, onBytes: (n: number) => void): Promise<void> {
  let job = blobJobs.get(blob.digest);
  if (!job) {
    const listeners = new Set<(n: number) => void>();
    const promise = downloadBlob(client, blob, (n) => {
      for (const l of listeners) l(n);
    }).finally(() => blobJobs.delete(blob.digest));
    job = { promise, listeners };
    blobJobs.set(blob.digest, job);
    listeners.add(onBytes);
    return promise;
  }
  // Another image is downloading it: count it once it's there.
  return job.promise.then(() => onBytes(blob.size));
}

/* ------------------------------------------------------------------ */
/* Loopback registry for Tart                                            */
/* ------------------------------------------------------------------ */

/** Serves one downloaded image to `tart pull --insecure` (the OCI distribution GET/HEAD endpoints Tart uses). */
function serveMirror(repository: string, manifest: Manifest): { port: number; stop: () => void } {
  const blobs = new Map(manifest.blobs.map((b) => [b.digest, b]));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/v2/" || path === "/v2") return new Response("{}", { headers: { "Content-Type": "application/json" } });
      const prefix = `/v2/${repository}/`;
      if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
      const rest = path.slice(prefix.length);
      if (rest.startsWith("manifests/")) {
        return new Response(req.method === "HEAD" ? null : manifest.raw, {
          headers: { "Content-Type": manifest.mediaType, "Docker-Content-Digest": manifest.digest, "Content-Length": String(manifest.raw.byteLength) },
        });
      }
      if (rest.startsWith("blobs/")) {
        const blob = blobs.get(rest.slice("blobs/".length));
        if (!blob) return new Response("not found", { status: 404 });
        const file = Bun.file(blobPath(blob.digest));
        const headers = { "Content-Type": "application/octet-stream", "Docker-Content-Digest": blob.digest, "Accept-Ranges": "bytes" };
        if (req.method === "HEAD") return new Response(null, { headers: { ...headers, "Content-Length": String(blob.size) } });
        const range = /^bytes=(\d+)-$/.exec(req.headers.get("range") ?? "");
        if (range) {
          const start = Number(range[1]);
          if (start >= blob.size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${blob.size}` } });
          return new Response(file.slice(start), {
            status: 206,
            headers: { ...headers, "Content-Range": `bytes ${start}-${blob.size - 1}/${blob.size}`, "Content-Length": String(blob.size - start) },
          });
        }
        return new Response(file, { headers: { ...headers, "Content-Length": String(blob.size) } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { port: server.port!, stop: () => server.stop(true) };
}

/* ------------------------------------------------------------------ */
/* Download                                                             */
/* ------------------------------------------------------------------ */

/** Free space an image needs: the layers still to download, plus room to unpack all of them. */
export function spaceNeededBytes(missingBytes: number, totalBytes: number): number {
  return missingBytes + totalBytes + 5e9;
}

/**
 * Make `image` available as the template VM `templateName(image)`: download the layers (parallel, resumable, shared
 * with other images), let Tart pull them from a loopback registry, clone the result into the template. Registries
 * that refuse an anonymous pull go through Tart's own pull instead.
 */
export async function downloadImage(image: string, onProgress: (p: ImageProgress) => void): Promise<void> {
  const template = templateName(image);
  const ref = parseImageRef(image);
  const client = new RegistryClient(ref);
  let manifest: Manifest;
  try {
    manifest = await fetchManifest(client, ref.reference);
  } catch (err) {
    if (!(err instanceof AuthRequired)) throw err;
    log.info(`${image}: ${err.message}; pulling with tart`);
    await pullWithTart(image, template, onProgress);
    return;
  }
  // Some layers repeat within an image: each is downloaded (and counted) once.
  const unique = [...new Map(manifest.blobs.map((b) => [b.digest, b])).values()];
  const total = unique.reduce((n, b) => n + b.size, 0);
  const missing = unique.reduce((n, b) => n + (existsSync(blobPath(b.digest)) ? 0 : b.size), 0);
  const free = freeBytes();
  if (free !== null && free < spaceNeededBytes(missing, total)) {
    throw new Error(
      `Not enough free disk space to download this image: it needs about ${Math.ceil(spaceNeededBytes(missing, total) / 1e9)} GB, ${Math.floor(free / 1e9)} GB are free.`,
    );
  }
  mkdirSync(downloadsDir(), { recursive: true, mode: 0o700 });
  for (const b of unique) blobHolds.set(b.digest, (blobHolds.get(b.digest) ?? 0) + 1);
  let succeeded = false;
  try {
    let done = 0;
    let lastReport = 0;
    const report = (force = false) => {
      if (!force && Date.now() - lastReport < 500) return;
      lastReport = Date.now();
      onProgress({ phase: "download", percent: total ? Math.min(100, (done / total) * 100) : null, bytes: { done: Math.min(done, total), total } });
    };
    log.info(`downloading ${image} (${(total / 1e9).toFixed(1)} GB, ${unique.length} parts)`);
    const queue = [...unique].sort((a, b) => b.size - a.size);
    let failure: unknown = null;
    const workers = Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
      for (let blob = queue.shift(); blob && !failure; blob = queue.shift()) {
        try {
          await fetchBlob(client, blob, (n) => {
            done += n;
            report();
          });
        } catch (err) {
          failure ??= err;
        }
      }
    });
    // Every worker ends before this returns: no download keeps writing after a failure (shared ones finish for others).
    await Promise.all(workers);
    if (failure) throw failure;
    report(true);
    await unpack(ref, manifest, template, onProgress);
    succeeded = true;
    log.info(`downloaded ${image} into template ${template}`);
  } finally {
    for (const b of unique) {
      const left = (blobHolds.get(b.digest) ?? 1) - 1;
      if (left > 0) blobHolds.set(b.digest, left);
      else {
        blobHolds.delete(b.digest);
        // Kept after a failure: the next try resumes from them.
        if (succeeded) rmSync(blobPath(b.digest), { force: true });
      }
    }
  }
}

/** Tart pulls the verified layers from a loopback registry; the result becomes the template. */
async function unpack(ref: ImageRef, manifest: Manifest, template: string, onProgress: (p: ImageProgress) => void): Promise<void> {
  const mirror = serveMirror(ref.repository, manifest);
  const local = `127.0.0.1:${mirror.port}/${ref.repository}@${manifest.digest}`;
  try {
    onProgress({ phase: "unpack", percent: null });
    const res = await tart.tart(["pull", "--insecure", "--concurrency", "4", local], {
      timeoutMs: 0,
      maxOutput: 20_000,
      onOutput: (chunk) => {
        const pct = tart.parseProgress(chunk);
        if (pct !== null) onProgress({ phase: "unpack", percent: pct });
      },
    });
    if (res.code !== 0) throw new Error(`Unpacking the image failed: ${tart.tartErrorText(res) || `exit ${res.code}`}`);
    await makeTemplate(local, template);
  } finally {
    mirror.stop();
    // The loopback name is never used again (its port changes): drop Tart's cached copy.
    await tart.tart(["delete", local], { timeoutMs: 120_000 }).catch(() => undefined);
  }
}

async function pullWithTart(image: string, template: string, onProgress: (p: ImageProgress) => void): Promise<void> {
  const res = await tart.tart(["pull", image, "--concurrency", "8"], {
    timeoutMs: 0,
    maxOutput: 20_000,
    onOutput: (chunk) => {
      const pct = tart.parseProgress(chunk);
      if (pct !== null) onProgress({ phase: "download", percent: pct });
    },
  });
  if (res.code !== 0) throw new Error(`Downloading ${image} failed: ${tart.tartErrorText(res) || `exit ${res.code}`}`);
  await makeTemplate(image, template);
  // The template holds the image now (removing it frees the space).
  await tart.tart(["delete", image], { timeoutMs: 120_000 }).catch(() => undefined);
}

async function makeTemplate(source: string, template: string): Promise<void> {
  await tart.tart(["delete", template], { timeoutMs: 120_000 }).catch(() => undefined);
  await tart.tartOk(["clone", source, template], { timeoutMs: 30 * 60_000 });
}

/** Leftovers of downloads Godmode was quit in the middle of: loopback copies in Tart's image cache. */
export async function pruneImageLeftovers(): Promise<void> {
  for (const name of await tart.listOciNames().catch(() => [] as string[])) {
    if (/^127\.0\.0\.1:\d+\//.test(name)) await tart.tart(["delete", name], { timeoutMs: 120_000 }).catch(() => undefined);
  }
}

function freeBytes(): number | null {
  try {
    const dir = existsSync(tart.vmRoot()) ? tart.vmRoot() : join(tart.vmRoot(), "..");
    const fs = statfsSync(dir);
    return fs.bavail * fs.bsize;
  } catch {
    return null;
  }
}
