import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailLines } from "../src/runner/tail";
import { awakeTimeout, sleep } from "../src/util";

const dir = mkdtempSync(join(tmpdir(), "godmode-run-output-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("awakeTimeout", () => {
  test("time the computer slept doesn't count", async () => {
    let mono = 0;
    let fired = 0;
    awakeTimeout(() => fired++, 40, () => mono);
    // The timer fires on waking up, but the monotonic clock only moved 10 ms: it waits for the rest.
    mono = 10;
    await sleep(60);
    expect(fired).toBe(0);
    mono = 40;
    await sleep(60);
    expect(fired).toBe(1);
  });

  test("fires once the awake time is up, and can be cancelled", async () => {
    let fired = 0;
    awakeTimeout(() => fired++, 20);
    const cancel = awakeTimeout(() => fired++, 20);
    cancel();
    await sleep(60);
    expect(fired).toBe(1);
  });
});

describe("tailLines", () => {
  test("reads lines as they are written, and the rest once the writer is done", async () => {
    const path = join(dir, "out.jsonl");
    writeFileSync(path, "");
    let finish!: () => void;
    const ended = new Promise<void>((r) => (finish = r));
    const lines: string[] = [];
    const tail = tailLines(path, ended, (l) => lines.push(l), 5).done;
    appendFileSync(path, '{"a":1}\n{"b":');
    await sleep(30);
    expect(lines).toEqual(['{"a":1}']);
    appendFileSync(path, '2}\n{"result":"ok"}');
    finish();
    await tail;
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"result":"ok"}']);
  });

  test("a large burst arrives whole", async () => {
    const path = join(dir, "big.jsonl");
    const line = "x".repeat(300_000);
    writeFileSync(path, `${line}\n`.repeat(20));
    const lines: string[] = [];
    await tailLines(path, Promise.resolve(), (l) => lines.push(l), 5).done;
    expect(lines.length).toBe(20);
    expect(lines.every((l) => l === line)).toBe(true);
  });

  test("catching up reads what was written at once, without waiting for the next look", async () => {
    const path = join(dir, "catch-up.jsonl");
    writeFileSync(path, "");
    let finish!: () => void;
    const lines: string[] = [];
    const tail = tailLines(path, new Promise<void>((r) => (finish = r)), (l) => lines.push(l), 200);
    await sleep(5);
    appendFileSync(path, '{"type":"assistant"}\n');
    tail.catchUp();
    expect(lines).toEqual(['{"type":"assistant"}']);
    finish();
    await tail.done;
    tail.catchUp();
    expect(lines).toEqual(['{"type":"assistant"}']);
  });
});
