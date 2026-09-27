import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StreamAccumulator, detectLoginFailure, displayToolName, redactBlocks, toolResultContent } from "../src/runner/stream";

function events(name: string): unknown[] {
  return readFileSync(join(import.meta.dir, "fixtures", name), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function feed(evts: unknown[]): StreamAccumulator {
  const acc = new StreamAccumulator();
  for (const e of evts) acc.push(e);
  return acc;
}

describe("StreamAccumulator — tool use fixture (no partial messages)", () => {
  const acc = feed(events("stream-tooluse.jsonl"));

  test("produces thinking, tool_use with result, thinking, text", () => {
    expect(acc.blocks.map((b) => b.type)).toEqual(["thinking", "tool_use", "thinking", "text"]);
    const tool = acc.blocks[1]!;
    if (tool.type !== "tool_use") throw new Error("expected tool_use");
    expect(tool.name).toBe("Bash");
    expect(tool.input).toEqual({ command: "echo hi" });
    expect(tool.result).toBe("hi");
    expect(tool.isError).toBe(false);
    expect(tool.parentToolUseId).toBeNull();
    const last = acc.blocks[3]!;
    expect(last.type === "text" && last.text).toBe("DONE");
  });

  test("keeps redacted (empty) thinking blocks", () => {
    const t = acc.blocks[0]!;
    expect(t.type === "thinking" && t.text).toBe("");
  });

  test("final result", () => {
    expect(acc.final).not.toBeNull();
    expect(acc.final!.text).toBe("DONE");
    expect(acc.final!.isError).toBe(false);
    expect(acc.final!.subtype).toBe("success");
    expect(acc.final!.costUsd).toBeCloseTo(0.0189655);
    expect(acc.final!.durationMs).toBe(3773);
    expect(acc.final!.numTurns).toBe(2);
    expect(acc.final!.sessionId).toBe("ea0156c3-36f4-4e45-91aa-ac904a05f116");
    expect(acc.final!.usage).toEqual({ inputTokens: 18, outputTokens: 143, cacheReadTokens: 34925, cacheWriteTokens: 7370 });
    expect(acc.sessionId).toBe("ea0156c3-36f4-4e45-91aa-ac904a05f116");
    expect(acc.model).toBe("claude-haiku-4-5-20251001");
    expect(acc.toolsCalled.has("Bash")).toBe(true);
    expect(acc.activityLabel()).toBe("Done");
  });

  test("text deltas come from full assistant messages too", () => {
    const a = new StreamAccumulator();
    const deltas: string[] = [];
    for (const e of events("stream-tooluse.jsonl")) {
      a.push(e);
      const d = a.takeTextDelta();
      if (d) deltas.push(d);
    }
    expect(deltas.join("")).toBe("DONE");
  });
});

describe("StreamAccumulator — partial messages fixture", () => {
  const evts = events("stream-partial.jsonl");

  test("final blocks are one thinking + one text without duplicates", () => {
    const acc = feed(evts);
    expect(acc.blocks.map((b) => b.type)).toEqual(["thinking", "text"]);
    const text = acc.blocks[1]!;
    expect(text.type === "text" && text.text).toBe("Hello, nice to meet you!");
    expect(acc.final!.text).toBe("Hello, nice to meet you!");
    expect(acc.finalText()).toBe("Hello, nice to meet you!");
    expect(acc.sessionId).toBe("7d0f7f3e-1111-4222-8333-944455556666");
  });

  test("streams text deltas exactly once and reports activity", () => {
    const acc = new StreamAccumulator();
    const deltas: string[] = [];
    const labels: string[] = [];
    for (const e of evts) {
      acc.push(e);
      const d = acc.takeTextDelta();
      if (d) deltas.push(d);
      const l = acc.activityLabel();
      if (labels[labels.length - 1] !== l) labels.push(l);
    }
    expect(deltas).toEqual(["Hello, nice", " to meet you!"]);
    expect(labels).toEqual(["Starting…", "Thinking…", "Writing…", "Done"]);
  });
});

describe("StreamAccumulator — synthetic cases", () => {
  test("input_json_delta is parsed on content_block_stop and matched with the full event", () => {
    const acc = new StreamAccumulator();
    acc.push({ type: "stream_event", event: { type: "message_start", message: { id: "m1", model: "x" } } });
    acc.push({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "mcp__browser__browser_navigate", input: {} } },
    });
    expect(acc.activityLabel()).toBe("Using browser_navigate");
    acc.push({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"url":"https://exa' } } });
    acc.push({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'mple.com"}' } } });
    acc.push({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    expect(acc.blocks).toHaveLength(1);
    const b = acc.blocks[0]!;
    expect(b.type === "tool_use" && b.input).toEqual({ url: "https://example.com" });
    // Full assistant event for the same block must not duplicate it.
    acc.push({
      type: "assistant",
      message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "mcp__browser__browser_navigate", input: { url: "https://example.com" } }] },
    });
    expect(acc.blocks).toHaveLength(1);
    acc.push({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              { type: "text", text: "Navigated" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
            ],
          },
        ],
      },
    });
    const r = acc.blocks[0]!;
    expect(r.type === "tool_use" && r.result).toBe("Navigated");
    expect(r.type === "tool_use" && r.image).toBe("iVBORw0KGgo=");
    expect(acc.activityLabel()).toBe("Thinking…");
  });

  test("cumulative assistant events (older CLI) are not duplicated", () => {
    const acc = new StreamAccumulator();
    acc.push({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Hi" }] } });
    acc.push({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Hi" }, { type: "tool_use", id: "t1", name: "Read", input: {} }] } });
    expect(acc.blocks.map((b) => b.type)).toEqual(["text", "tool_use"]);
  });

  test("subagent output is flagged with parentToolUseId and excluded from text deltas", () => {
    const acc = new StreamAccumulator();
    acc.push({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "task1", name: "Task", input: { prompt: "x" } }] } });
    acc.takeTextDelta();
    acc.push({ type: "assistant", parent_tool_use_id: "task1", message: { id: "s1", content: [{ type: "text", text: "sub says" }] } });
    acc.push({ type: "assistant", parent_tool_use_id: "task1", message: { id: "s1", content: [{ type: "tool_use", id: "t2", name: "Bash", input: {} }] } });
    expect(acc.takeTextDelta()).toBe("");
    const sub = acc.blocks[1]!;
    expect(sub.type === "text" && sub.parentToolUseId).toBe("task1");
    const subTool = acc.blocks[2]!;
    expect(subTool.type === "tool_use" && subTool.parentToolUseId).toBe("task1");
  });

  test("error result with CLI errors array", () => {
    const acc = new StreamAccumulator();
    acc.push({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      num_turns: 0,
      total_cost_usd: 0,
      session_id: "abc",
      errors: ["No conversation found with session ID: abc"],
    });
    expect(acc.final!.isError).toBe(true);
    expect(acc.final!.errors).toEqual(["No conversation found with session ID: abc"]);
    expect(acc.final!.text).toBe("");
    expect(acc.activityLabel()).toBe("Failed");
  });

  test("ignores garbage", () => {
    const acc = new StreamAccumulator();
    expect(acc.push(null)).toBe(false);
    expect(acc.push({ type: "stream_event" })).toBe(false);
    expect(acc.push({ type: "stream_event", event: { type: "content_block_delta", index: 9, delta: { type: "text_delta", text: "x" } } })).toBe(false);
    expect(acc.blocks).toHaveLength(0);
  });
});

describe("helpers", () => {
  test("displayToolName", () => {
    expect(displayToolName("mcp__browser__browser_navigate")).toBe("browser_navigate");
    expect(displayToolName("mcp__godmode__vault_fill_login")).toBe("vault_fill_login");
    expect(displayToolName("Bash")).toBe("Bash");
  });

  test("toolResultContent stringifies arrays and objects", () => {
    expect(toolResultContent("x").text).toBe("x");
    expect(toolResultContent([{ type: "text", text: "a" }, { type: "text", text: "b" }]).text).toBe("a\nb");
    expect(toolResultContent({ a: 1 }).text).toBe('{"a":1}');
  });

  test("redactBlocks masks strings everywhere", () => {
    const r = (s: string) => s.split("hunter22").join("••••");
    const out = redactBlocks(
      [
        { type: "text", text: "pw hunter22" },
        { type: "tool_use", id: "t", name: "x", input: { nested: ["hunter22"] }, result: "hunter22!" },
      ],
      r,
    );
    expect(JSON.stringify(out)).not.toContain("hunter22");
  });

  test("detectLoginFailure", () => {
    expect(detectLoginFailure("All done. I couldn't log in to GitHub because the password was rejected.")).toBe(
      "I couldn't log in to GitHub because the password was rejected.",
    );
    expect(detectLoginFailure("There are no saved credentials for acme.com, so I stopped.")).not.toBeNull();
    expect(detectLoginFailure("The site asked for a verification code, which is required but not available.")).not.toBeNull();
    expect(detectLoginFailure("I logged in and downloaded the invoice.")).toBeNull();
    expect(detectLoginFailure("No login required — the page is public.")).toBeNull();
    expect(detectLoginFailure("I couldn't find the log in button at first, but then succeeded.")).toBeNull();
  });
});
