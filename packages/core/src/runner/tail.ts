import { closeSync, openSync, readSync } from "node:fs";
import { sleep } from "../util";

const CHUNK_BYTES = 256 * 1024;
/** Read at most this much per turn of the event loop: a burst of screenshots doesn't stall the core. */
const MAX_BYTES_PER_TURN = 4 * 1024 * 1024;

export interface Tail {
  /** Resolves once `ended` settled and everything written was read. */
  done: Promise<void>;
  /** Read what was written so far right away (before acting on something the writer did meanwhile). */
  catchUp: () => void;
}

/**
 * The lines of a file another process writes, as they arrive, until `ended` settles and everything it wrote is read.
 * Writing to a file never fails or blocks the writer, and nothing is lost when it exits: unlike a pipe nobody drains.
 */
export function tailLines(path: string, ended: Promise<unknown>, onLine: (line: string) => void, everyMs = 100): Tail {
  let fd: number | null = null;
  const decoder = new TextDecoder();
  const chunk = Buffer.alloc(CHUNK_BYTES);
  let buf = "";
  let finished = false;
  ended.then(
    () => (finished = true),
    () => (finished = true),
  );

  const readSome = (max: number): number => {
    let read = 0;
    let n: number;
    while (fd !== null && read < max && (n = readSync(fd, chunk, 0, CHUNK_BYTES, null)) > 0) {
      read += n;
      buf += decoder.decode(chunk.subarray(0, n), { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        onLine(line);
      }
    }
    return read;
  };

  const done = (async () => {
    try {
      fd = openSync(path, "r");
      for (;;) {
        const last = finished;
        if (readSome(MAX_BYTES_PER_TURN) >= MAX_BYTES_PER_TURN) await sleep(0);
        else if (last) break;
        else await sleep(everyMs);
      }
    } finally {
      if (fd !== null) closeSync(fd);
      fd = null;
    }
    buf += decoder.decode();
    if (buf) onLine(buf);
  })();

  return { done, catchUp: () => void readSome(Number.POSITIVE_INFINITY) };
}
