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

describe("StreamAccumulator — workflow fixture (a workflow that outlives its turn)", () => {
  const evts = events("stream-workflow.jsonl");
  const workflowOf = (acc: StreamAccumulator) => {
    const tool = acc.blocks[0]!;
    if (tool.type !== "tool_use" || !tool.task) throw new Error("expected a tool_use with a task");
    return tool.task;
  };

  test("the Workflow call carries its task: description, progress, agents and how it ended", () => {
    const acc = feed(evts);
    expect(acc.blocks.map((b) => b.type)).toEqual(["tool_use", "text", "text"]);
    const tool = acc.blocks[0]!;
    expect(tool.type === "tool_use" && tool.name).toBe("Workflow");
    expect(tool.type === "tool_use" && tool.result).toStartWith("Workflow launched in background.");
    expect(workflowOf(acc)).toEqual({
      id: "wl744orcm",
      kind: "local_workflow",
      status: "completed",
      description: "Count words in a.txt and b.txt with two agents",
      activity: "Count: b.txt",
      totalTokens: 18556,
      toolUses: 4,
      durationMs: 4066,
      agents: [
        { label: "a.txt", phase: "Count", state: "done", lastTool: "StructuredOutput", tokens: 9278 },
        { label: "b.txt", phase: "Count", state: "done", lastTool: "StructuredOutput", tokens: 9278 },
      ],
    });
  });

  test("agents are queued, then running, then done; progress without a list keeps them", () => {
    const acc = new StreamAccumulator();
    const seen: string[] = [];
    for (const e of evts) {
      const type = (e as { subtype?: string }).subtype ?? "";
      const changed = acc.push(e);
      if (!type.startsWith("task_")) continue;
      // Every task event of the capture changes the block (the notification: the final usage).
      expect(changed).toBe(true);
      const task = workflowOf(acc);
      seen.push(`${type} ${task.status} ${task.totalTokens} ${task.agents.map((a) => a.state).join("+")}`);
    }
    expect(seen).toEqual([
      "task_started running 0 ",
      "task_progress running 0 running+queued",
      "task_progress running 0 running+running",
      "task_progress running 9180 running+running",
      "task_progress running 18360 running+running",
      "task_progress running 18458 done+running",
      "task_progress running 18556 done+done",
      "task_updated completed 18556 done+done",
      "task_notification completed 18556 done+done",
    ]);
    expect(acc.push(evts.find((e) => (e as { subtype?: string }).subtype === "task_updated"))).toBe(false);
  });

  test("the label follows the workflow once its tool call has returned", () => {
    const acc = new StreamAccumulator();
    const labels: string[] = [];
    for (const e of evts) {
      acc.push(e);
      const l = acc.activityLabel();
      if (labels[labels.length - 1] !== l) labels.push(l);
    }
    expect(labels).toEqual([
      "Starting…",
      "Starting a workflow…",
      "Running workflow · Count words in a.txt and b.txt with two agents",
      "Running workflow · Count: a.txt",
      "Running workflow · Count: b.txt",
      "Running workflow · Count: a.txt",
      "Running workflow · Count: b.txt",
      "Running workflow · Count: a.txt",
      "Running workflow · Count: b.txt",
      "Writing…",
      "Done",
    ]);
  });

  test("two results: the answer is the last one's; time, turns and tokens add up, the cost is the session's", () => {
    const acc = feed(evts);
    expect(acc.final!.text).toBe("The total is **2 words**: a.txt has 1 word and b.txt has 1 word.");
    expect(acc.finalText()).toBe("The total is **2 words**: a.txt has 1 word and b.txt has 1 word.");
    expect(acc.final!.isError).toBe(false);
    expect(acc.final!.subtype).toBe("success");
    expect(acc.final!.costUsd).toBeCloseTo(0.1025937);
    expect(acc.final!.durationMs).toBe(4494 + 1706);
    expect(acc.final!.numTurns).toBe(2 + 1);
    expect(acc.final!.usage).toEqual({ inputTokens: 4 + 4, outputTokens: 323 + 31, cacheReadTokens: 34685 + 23454, cacheWriteTokens: 11166 + 1013 });
    expect(acc.sessionId).toBe("bb30141f-2042-4237-837c-16f308c70de6");
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
    expect(acc.activityLabel()).toBe("Opening a page…");
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

  test("background tasks: how they end, agents that fail, and events without their tool call", () => {
    const launch = (acc: StreamAccumulator, id: string, taskType = "local_workflow") => {
      acc.push({ type: "assistant", message: { id: `m_${id}`, content: [{ type: "tool_use", id: `t_${id}`, name: "Workflow", input: {} }] } });
      expect(acc.push({ type: "system", subtype: "task_started", task_id: id, tool_use_id: `t_${id}`, description: `Task ${id}`, task_type: taskType })).toBe(true);
      acc.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t_${id}`, content: "launched" }] } });
      const block = acc.blocks.find((b) => b.type === "tool_use" && b.id === `t_${id}`);
      if (block?.type !== "tool_use" || !block.task) throw new Error("expected a task");
      return block.task;
    };
    const acc = new StreamAccumulator();
    const failed = launch(acc, "a");
    acc.push({
      type: "system",
      subtype: "task_progress",
      task_id: "a",
      tool_use_id: "t_a",
      description: "Build: api",
      usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 },
      workflow_progress: [
        { type: "workflow_phase", index: 1, title: "Build" },
        { type: "workflow_agent", index: 1, label: "api", phaseTitle: "Build", state: "error", startedAt: 1 },
        { type: "workflow_agent", index: 2, label: "web", state: "failed", startedAt: 2 },
        { type: "workflow_agent", index: 3, label: "docs", state: "progress", startedAt: 3, lastToolName: "Read" },
        { type: "workflow_agent", index: 4, label: "tests", state: "start" },
      ],
    });
    expect(failed.agents).toEqual([
      { label: "api", phase: "Build", state: "failed" },
      { label: "web", phase: "", state: "failed" },
      { label: "docs", phase: "", state: "running", lastTool: "Read" },
      { label: "tests", phase: "", state: "queued" },
    ]);
    // Paused or running again ends nothing.
    expect(acc.push({ type: "system", subtype: "task_updated", task_id: "a", patch: { status: "paused" } })).toBe(false);
    expect(acc.push({ type: "system", subtype: "task_updated", task_id: "a", patch: { is_backgrounded: true } })).toBe(false);
    expect(failed.status).toBe("running");
    acc.push({ type: "system", subtype: "task_notification", task_id: "a", tool_use_id: "t_a", status: "failed", summary: "failed", usage: { total_tokens: 12, tool_uses: 2, duration_ms: 9 } });
    expect(failed).toMatchObject({ status: "failed", totalTokens: 12, toolUses: 2, durationMs: 9, activity: "Build: api" });

    const killed = launch(acc, "b");
    acc.push({ type: "system", subtype: "task_updated", task_id: "b", patch: { status: "killed" } });
    expect(killed.status).toBe("stopped");
    const stopped = launch(acc, "c");
    acc.push({ type: "system", subtype: "task_notification", task_id: "c", tool_use_id: "t_c", status: "stopped", summary: "stopped" });
    expect(stopped.status).toBe("stopped");

    // No tool call to hang it on: ignored, and so is everything that follows for it.
    expect(acc.push({ type: "system", subtype: "task_started", task_id: "x", tool_use_id: "t_missing", description: "?", task_type: "local_workflow" })).toBe(false);
    expect(acc.push({ type: "system", subtype: "task_started", task_id: "y", description: "?" })).toBe(false);
    expect(acc.push({ type: "system", subtype: "task_progress", task_id: "x", description: "?", usage: {} })).toBe(false);
    expect(acc.push({ type: "system", subtype: "task_notification", task_id: "x", status: "completed" })).toBe(false);
    expect(acc.push({ type: "system", subtype: "task_progress" })).toBe(false);
  });

  test("the workflow label yields to a top-level tool call and is only for workflows", () => {
    const acc = new StreamAccumulator();
    acc.push({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "w1", name: "Workflow", input: {} }] } });
    acc.push({ type: "system", subtype: "task_started", task_id: "wf", tool_use_id: "w1", description: "Review the changes", task_type: "local_workflow" });
    expect(acc.activityLabel()).toBe("Starting a workflow…");
    acc.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w1", content: "launched" }] } });
    expect(acc.activityLabel()).toBe("Running workflow · Review the changes");
    // A subagent's open tool call doesn't count, the run's own does.
    acc.push({ type: "assistant", parent_tool_use_id: "w1", message: { id: "s1", content: [{ type: "tool_use", id: "b0", name: "Read", input: {} }] } });
    expect(acc.activityLabel()).toBe("Running workflow · Review the changes");
    acc.push({ type: "assistant", message: { id: "m2", content: [{ type: "tool_use", id: "b1", name: "Bash", input: {} }] } });
    expect(acc.activityLabel()).toBe("Running a command…");
    acc.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "ok" }] } });
    acc.push({ type: "system", subtype: "task_progress", task_id: "wf", tool_use_id: "w1", description: "Review: bugs", usage: { total_tokens: 1, tool_uses: 0, duration_ms: 1 } });
    expect(acc.activityLabel()).toBe("Running workflow · Review: bugs");
    acc.push({ type: "system", subtype: "task_notification", task_id: "wf", tool_use_id: "w1", status: "completed", summary: "done" });
    expect(acc.activityLabel()).toBe("Thinking…");

    // A shell command in the background is a task too, but no workflow.
    const shell = new StreamAccumulator();
    shell.push({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { run_in_background: true } }] } });
    shell.push({ type: "system", subtype: "task_started", task_id: "sh", tool_use_id: "b1", description: "npm run dev", task_type: "local_bash" });
    shell.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "started" }] } });
    const block = shell.blocks[0]!;
    expect(block.type === "tool_use" && block.task).toMatchObject({ kind: "local_bash", status: "running", description: "npm run dev", agents: [] });
    expect(shell.activityLabel()).toBe("Thinking…");
  });

  test("a pause cuts a running workflow off: its task is stopped, for the run that continues too", () => {
    const first = new StreamAccumulator();
    first.push({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "w1", name: "Workflow", input: {} }] } });
    first.push({ type: "system", subtype: "task_started", task_id: "wf", tool_use_id: "w1", description: "Review the changes", task_type: "local_workflow" });
    first.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w1", content: "launched" }] } });
    first.push({ type: "assistant", message: { id: "m2", content: [{ type: "tool_use", id: "w2", name: "Workflow", input: {} }] } });
    first.push({ type: "system", subtype: "task_started", task_id: "wf2", tool_use_id: "w2", description: "Write the tests", task_type: "local_workflow" });
    first.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w2", content: "launched" }] } });
    first.push({ type: "system", subtype: "task_notification", task_id: "wf2", tool_use_id: "w2", status: "completed", summary: "done" });
    const statuses = (acc: StreamAccumulator) => acc.blocks.flatMap((b) => (b.type === "tool_use" && b.task ? [b.task.status] : []));
    expect(statuses(first)).toEqual(["running", "completed"]);
    expect(first.activityLabel()).toBe("Running workflow · Review the changes");

    first.markPause({ type: "pause", reason: "user", at: new Date(0).toISOString() });
    // What had ended keeps how it ended.
    expect(statuses(first)).toEqual(["stopped", "completed"]);
    expect(first.activityLabel()).not.toContain("Running workflow");

    // The run continues from what was stored.
    const resumed = new StreamAccumulator(JSON.parse(JSON.stringify(first.blocks)));
    expect(statuses(resumed)).toEqual(["stopped", "completed"]);
    resumed.push({ type: "assistant", message: { id: "m3", content: [{ type: "text", text: "Back at it" }] } });
    expect(statuses(resumed)).toEqual(["stopped", "completed"]);
    expect(resumed.activityLabel()).toBe("Writing…");
  });

  test("results of one process add up; a later result without a cost keeps the last one", () => {
    const acc = new StreamAccumulator();
    acc.push({ type: "result", subtype: "success", is_error: false, result: "first", total_cost_usd: 0.5, duration_ms: 10, num_turns: 2, usage: { input_tokens: 1, output_tokens: 2 } });
    acc.push({ type: "result", subtype: "error_during_execution", is_error: true, result: "second", duration_ms: 5, usage: { input_tokens: 10, cache_read_input_tokens: 7 } });
    expect(acc.final).toMatchObject({
      text: "second",
      isError: true,
      subtype: "error_during_execution",
      costUsd: 0.5,
      durationMs: 15,
      numTurns: 2,
      usage: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 7, cacheWriteTokens: 0 },
    });
  });

  test("ignores garbage", () => {
    const acc = new StreamAccumulator();
    expect(acc.push(null)).toBe(false);
    expect(acc.push({ type: "stream_event" })).toBe(false);
    expect(acc.push({ type: "stream_event", event: { type: "content_block_delta", index: 9, delta: { type: "text_delta", text: "x" } } })).toBe(false);
    expect(acc.blocks).toHaveLength(0);
  });
});

describe("StreamAccumulator — a process that ends more than once", () => {
  const result = (extra: Record<string, unknown>) => ({ type: "result", subtype: "success", is_error: false, session_id: "s1", ...extra });

  test("time, turns and tokens add up; the cost is the latest total", () => {
    const acc = new StreamAccumulator();
    acc.push(result({ result: "answer", total_cost_usd: 1.5, duration_ms: 60_000, num_turns: 12, usage: { input_tokens: 5, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 } }));
    acc.push(result({ result: "the task finished", total_cost_usd: 1.75, duration_ms: 8_000, num_turns: 1, usage: { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 } }));
    expect(acc.results).toBe(2);
    expect(acc.final).toMatchObject({
      text: "the task finished",
      costUsd: 1.75,
      durationMs: 68_000,
      numTurns: 13,
      usage: { inputTokens: 7, outputTokens: 110, cacheReadTokens: 3000, cacheWriteTokens: 50 },
    });
  });

  test("an ending that says less keeps what the one before said", () => {
    const acc = new StreamAccumulator();
    acc.push(result({ result: "answer", total_cost_usd: 0.4, duration_ms: 1000, num_turns: 2, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 } }));
    acc.push(result({ result: "again" }));
    expect(acc.final).toMatchObject({ costUsd: 0.4, durationMs: 1000, numTurns: 2, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 } });
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

  test("redactBlocks masks what a task says about itself", () => {
    const r = (s: string) => s.split("hunter22").join("••••");
    const acc = feed(events("stream-workflow.jsonl"));
    const tool = acc.blocks[0]!;
    if (tool.type !== "tool_use" || !tool.task) throw new Error("expected a tool_use with a task");
    tool.task.description = "Log in with hunter22";
    tool.task.activity = "Login hunter22: try hunter22";
    tool.task.agents[0]!.label = "try hunter22";
    tool.task.agents[0]!.phase = "Login hunter22";
    const [out] = redactBlocks(acc.blocks, r);
    expect(JSON.stringify(out)).not.toContain("hunter22");
    if (out?.type !== "tool_use") throw new Error("expected tool_use");
    expect(out.task).toEqual({
      ...tool.task,
      description: "Log in with ••••",
      activity: "Login ••••: try ••••",
      agents: [{ ...tool.task.agents[0]!, label: "try ••••", phase: "Login ••••" }, tool.task.agents[1]!],
    });
    // A copy: the run's own blocks keep the text.
    expect(tool.task.description).toBe("Log in with hunter22");
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
