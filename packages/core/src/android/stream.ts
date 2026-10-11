/**
 * A phone's live view: while a UI watches a phone, `screenrecord` on the phone streams H.264 over adb. The Annex B
 * stream is cut into frames here and sent as `android.video` events (an avcC config, then length-prefixed frames) that
 * the app decodes with WebCodecs. screenrecord only sends a frame when the screen changes, stops after three minutes
 * and can't be asked for a keyframe — so a stream is restarted on those, when the phone turns, and when a new viewer
 * joins. Viewers that can't decode video (and phones whose screenrecord fails) get still pictures instead.
 */
import type { ServerEvent } from "@godmode/shared";
import { bus } from "../events/bus";
import { logger } from "../log";
import { sleep } from "../util";
import { AdbError, resolveAdb } from "./adb";
import { encodePng, scaleDown } from "../vm/raster";
import { captureRaw, modelSize, screenSize, type Size } from "./screen";
import { getDevice, isConnected, serialOf } from "./service";
import { childEnv } from "../util";

const log = logger("android");

const VIDEO_MAX_EDGE = 1280;
const FRAME_MAX_EDGE = 720;
/** screenrecord writes a whole frame at once: a pause this long means the frame in hand is complete. */
const FLUSH_MS = 40;
const BIT_RATE = 6_000_000;

export type ViewMode = "video" | "frames";

type VideoEvent = Extract<ServerEvent, { type: "android.video" }>;

function emit(event: VideoEvent) {
  bus.emit(event);
}

/* ------------------------------------------------------------------ */
/* H.264 Annex B → frames                                               */
/* ------------------------------------------------------------------ */

/** NAL units of an Annex B buffer (without start codes); `rest` is the unfinished tail. */
export function splitNals(buf: Uint8Array): { nals: Uint8Array[]; rest: Uint8Array } {
  const starts: { at: number; len: number }[] = [];
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      if (buf[i + 2] === 1) {
        starts.push({ at: i, len: 3 });
        i += 2;
      } else if (buf[i + 2] === 0 && i + 3 < buf.length && buf[i + 3] === 1) {
        starts.push({ at: i, len: 4 });
        i += 3;
      }
    }
  }
  if (!starts.length) return { nals: [], rest: buf };
  const nals: Uint8Array[] = [];
  for (let k = 0; k + 1 < starts.length; k++) nals.push(buf.subarray(starts[k]!.at + starts[k]!.len, starts[k + 1]!.at));
  return { nals, rest: buf.subarray(starts.at(-1)!.at) };
}

export function startCodeAt(buf: Uint8Array, from = 0): number {
  for (let i = from; i + 2 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && (buf[i + 2] === 1 || (buf[i + 2] === 0 && buf[i + 3] === 1))) return i;
  }
  return -1;
}

export function stripStartCode(buf: Uint8Array): Uint8Array {
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1) return buf.subarray(3);
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 0 && buf[3] === 1) return buf.subarray(4);
  return buf;
}

export const nalType = (nal: Uint8Array) => nal[0]! & 0x1f;

/** avcC record (ISO/IEC 14496-15) from one SPS and one PPS. */
export function avcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const out = new Uint8Array(11 + sps.length + pps.length);
  out.set([1, sps[1]!, sps[2]!, sps[3]!, 0xff, 0xe1, sps.length >> 8, sps.length & 0xff], 0);
  out.set(sps, 8);
  const p = 8 + sps.length;
  out.set([1, pps.length >> 8, pps.length & 0xff], p);
  out.set(pps, p + 3);
  return out;
}

export function codecString(sps: Uint8Array): string {
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `avc1.${hex(sps[1]!)}${hex(sps[2]!)}${hex(sps[3]!)}`;
}

/** One frame's NAL units, length-prefixed (AVCC). */
export function toAvcc(nals: Uint8Array[]): Uint8Array {
  const size = nals.reduce((n, x) => n + 4 + x.length, 0);
  const out = new Uint8Array(size);
  let o = 0;
  for (const nal of nals) {
    out[o] = (nal.length >>> 24) & 0xff;
    out[o + 1] = (nal.length >>> 16) & 0xff;
    out[o + 2] = (nal.length >>> 8) & 0xff;
    out[o + 3] = nal.length & 0xff;
    out.set(nal, o + 4);
    o += 4 + nal.length;
  }
  return out;
}

/**
 * Turns a stream of NAL units into config + frames: SPS/PPS become the config, a picture (slice) NAL closes a frame
 * together with the SEI before it. screenrecord's encoders write one slice per picture.
 */
export class FrameAssembler {
  private sps: Uint8Array | null = null;
  private pps: Uint8Array | null = null;
  private configured = "";
  private pending: Uint8Array[] = [];
  private gotKey = false;

  constructor(
    private onConfig: (c: { codec: string; description: Uint8Array }) => void,
    private onFrame: (f: { data: Uint8Array; key: boolean }) => void,
  ) {}

  push(nal: Uint8Array) {
    if (!nal.length) return;
    const type = nalType(nal);
    if (type === 7) this.sps = nal.slice();
    else if (type === 8) this.pps = nal.slice();
    else if (type === 9) return;
    else if (type === 1 || type === 5) {
      if (this.sps && this.pps) {
        const key = `${Buffer.from(this.sps).toString("hex")}:${Buffer.from(this.pps).toString("hex")}`;
        if (key !== this.configured) {
          this.configured = key;
          this.gotKey = false;
          this.onConfig({ codec: codecString(this.sps), description: avcC(this.sps, this.pps) });
        }
      }
      if (!this.configured) return;
      const isKey = type === 5;
      // Frames before the first keyframe can't be decoded.
      if (!isKey && !this.gotKey) {
        this.pending = [];
        return;
      }
      if (isKey) this.gotKey = true;
      this.onFrame({ data: toAvcc([...this.pending, nal]), key: isKey });
      this.pending = [];
    } else this.pending.push(nal.slice());
  }
}

/* ------------------------------------------------------------------ */
/* Streams                                                              */
/* ------------------------------------------------------------------ */

/** Video size for screenrecord: the screen scaled to the cap, both edges multiples of 16 (encoders want that). */
export function videoSize(screen: Size, maxEdge = VIDEO_MAX_EDGE): Size {
  const scale = Math.min(1, maxEdge / Math.max(screen.width, screen.height));
  const align = (n: number) => Math.max(16, Math.floor((n * scale) / 16) * 16);
  return { width: align(screen.width), height: align(screen.height) };
}

class PhoneStream {
  private stopped = false;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private loop: Promise<void> | null = null;
  private restartWanted = false;
  private failures = 0;
  videoViewers = 0;
  frameViewers = 0;
  /** screenrecord doesn't work on this phone: video viewers get pictures too. */
  private noVideo = false;

  constructor(readonly deviceId: string) {}

  start() {
    // Video and pictures side by side: a viewer that can't decode H.264 watches along with one that can.
    this.loop ??= Promise.all([this.videoLoop(), this.frameLoop()])
      .then(() => undefined)
      .catch((err) => log.warn(`live view of ${this.deviceId} stopped`, err));
  }

  restart() {
    this.restartWanted = true;
    this.kill();
  }

  /** Nobody watches the video anymore: don't keep screenrecord waiting for the next change on screen. */
  videoGone() {
    if (!this.wantsVideo()) this.kill();
  }

  kill() {
    try {
      this.proc?.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }

  private wantsVideo() {
    return this.videoViewers > 0 && !this.noVideo;
  }

  private wantsFrames() {
    return this.frameViewers > 0 || (this.videoViewers > 0 && this.noVideo);
  }

  private error(message: string) {
    emit({ type: "android.video", deviceId: this.deviceId, kind: "error", message });
  }

  private async videoLoop() {
    await this.loopWhile(() => this.wantsVideo(), () => this.streamVideo());
  }

  private async frameLoop() {
    await this.loopWhile(() => this.wantsFrames(), () => this.sendFrame());
  }

  private async loopWhile(wanted: () => boolean, step: () => Promise<void>) {
    while (!this.stopped) {
      if (!wanted()) {
        await sleep(300);
        continue;
      }
      if (!isConnected(this.deviceId)) {
        this.error(`${safeName(this.deviceId)} isn't connected.`);
        await sleep(2000);
        continue;
      }
      try {
        await step();
      } catch (err) {
        if (this.stopped) break;
        this.error(err instanceof Error ? err.message : String(err));
        await sleep(1500);
      }
    }
  }

  private async sendFrame() {
    const serial = serialOf(this.deviceId);
    const started = Date.now();
    const raw = await captureRaw(serial);
    const size = modelSize({ width: raw.width, height: raw.height }, FRAME_MAX_EDGE);
    const png = encodePng(scaleDown(raw, size.width, size.height), 1);
    if (this.stopped) return;
    emit({
      type: "android.video",
      deviceId: this.deviceId,
      kind: "frame",
      data: png.toString("base64"),
      mime: "image/png",
      width: size.width,
      height: size.height,
      screen: { width: raw.width, height: raw.height },
      ...(this.noVideo ? { all: true } : {}),
    });
    await sleep(Math.max(100, 400 - (Date.now() - started)));
  }

  private async streamVideo() {
    const serial = serialOf(this.deviceId);
    const bin = resolveAdb();
    if (!bin) throw new AdbError("adb is not installed", "not_installed");
    const screen = await screenSize(serial, 0);
    if (this.stopped || !this.wantsVideo()) return;
    const size = videoSize(screen);
    const proc = Bun.spawn(
      [bin.path, "-s", serial, "exec-out", `screenrecord --output-format=h264 --size ${size.width}x${size.height} --bit-rate ${BIT_RATE} -`],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: childEnv() as Record<string, string> },
    );
    this.proc = proc;
    // Stopped while it was starting: stop() found no process to kill.
    if (this.stopped || !this.wantsVideo()) this.kill();
    this.restartWanted = false;
    let frames = 0;
    const startedAt = Date.now();
    const assembler = new FrameAssembler(
      ({ codec, description }) => {
        emit({
          type: "android.video",
          deviceId: this.deviceId,
          kind: "config",
          codec,
          description: Buffer.from(description).toString("base64"),
          width: size.width,
          height: size.height,
          screen,
        });
      },
      ({ data, key }) => {
        frames++;
        emit({ type: "android.video", deviceId: this.deviceId, kind: "chunk", data: Buffer.from(data).toString("base64"), key, timestamp: (Date.now() - startedAt) * 1000 });
      },
    );
    let tail: Uint8Array = new Uint8Array(0);
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let flushed = false;
    const flushTail = () => {
      flushTimer = null;
      if (tail.length > 4) assembler.push(stripStartCode(tail));
      tail = new Uint8Array(0);
      flushed = true;
    };
    // The phone turned: the video's size no longer fits.
    const watch = setInterval(async () => {
      try {
        const now = await screenSize(serial, 0);
        if (now.width !== screen.width || now.height !== screen.height) this.restart();
      } catch {
        /* the stream ends on its own */
      }
    }, 2000);
    try {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        if (this.stopped || !this.wantsVideo()) break;
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = null;
        let data: Uint8Array = chunk;
        if (flushed && tail.length === 0) {
          flushed = false;
          // The pause was inside a frame, which went out cut: skip to the next start code and get a keyframe.
          if (startCodeAt(data) !== 0) {
            const at = startCodeAt(data);
            requestKeyframe(this.deviceId);
            if (at < 0) {
              flushed = true;
              continue;
            }
            data = data.subarray(at);
          }
        }
        const joined = new Uint8Array(tail.length + data.length);
        joined.set(tail, 0);
        joined.set(data, tail.length);
        const { nals, rest } = splitNals(joined);
        for (const nal of nals) assembler.push(nal);
        tail = rest.slice();
        flushTimer = setTimeout(flushTail, FLUSH_MS);
      }
    } finally {
      clearInterval(watch);
      if (flushTimer) clearTimeout(flushTimer);
      this.kill();
      this.proc = null;
    }
    const code = await proc.exited.catch(() => null);
    if (this.stopped || this.restartWanted || !this.wantsVideo()) return;
    const ranMs = Date.now() - startedAt;
    // screenrecord ends itself after three minutes: just go on. Ending early without a picture means it can't run here.
    if (frames === 0 && ranMs < 5000) {
      const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text().catch(() => "");
      this.failures++;
      log.info(`screenrecord failed on ${this.deviceId} (exit ${code}): ${stderr.trim().slice(0, 300)}`);
      if (this.failures >= 2) {
        this.noVideo = true;
        log.info(`live view of ${this.deviceId} falls back to pictures`);
      } else await sleep(800);
    } else this.failures = 0;
  }

  async stop() {
    this.stopped = true;
    this.kill();
    await this.loop?.catch(() => undefined);
  }
}

function safeName(id: string): string {
  try {
    return getDevice(id).name;
  } catch {
    return "The phone";
  }
}

const streams = new Map<string, PhoneStream>();
const restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastRestart = new Map<string, number>();
/** A new viewer gets its keyframe soon; a congested one waits longer, so one slow viewer can't keep restarting everyone's. */
const RESTART_GAP_MS = { join: 1500, congested: 6000 };

/** Viewers of a phone changed (from the WebSocket hub): start, restart for a keyframe, or stop its stream. */
export function setViewers(deviceId: string, video: number, frames: number, joined: boolean): void {
  let stream = streams.get(deviceId);
  if (video + frames === 0) {
    if (stream) {
      streams.delete(deviceId);
      void stream.stop();
    }
    return;
  }
  if (!stream) {
    stream = new PhoneStream(deviceId);
    streams.set(deviceId, stream);
    stream.videoViewers = video;
    stream.frameViewers = frames;
    stream.start();
    return;
  }
  stream.videoViewers = video;
  stream.frameViewers = frames;
  if (video === 0) stream.videoGone();
  if (joined && video > 0) requestKeyframe(deviceId, "join");
}

/** A viewer needs a keyframe (it joined, or dropped frames): restart the stream, spaced out per device. */
export function requestKeyframe(deviceId: string, reason: keyof typeof RESTART_GAP_MS = "congested"): void {
  if (restartTimers.has(deviceId)) return;
  const wait = Math.max(300, (lastRestart.get(deviceId) ?? 0) + RESTART_GAP_MS[reason] - Date.now());
  restartTimers.set(
    deviceId,
    setTimeout(() => {
      restartTimers.delete(deviceId);
      lastRestart.set(deviceId, Date.now());
      streams.get(deviceId)?.restart();
    }, wait),
  );
}

export async function stopAllStreams(): Promise<void> {
  const all = [...streams.values()];
  streams.clear();
  await Promise.all(all.map((s) => s.stop()));
}
