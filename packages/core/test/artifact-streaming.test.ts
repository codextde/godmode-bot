import { describe, expect, test } from "bun:test";
import { StreamAccumulator } from "../src/runner/stream";
import { ARTIFACT_PREVIEW_STEP, partialArtifactInput } from "../src/runner/partialArtifact";
import { handleRpc, type McpServerDef } from "../src/mcp/http";

describe("partialArtifactInput", () => {
  test("reads fields of an input cut off in the middle of the html", () => {
    const full = JSON.stringify({ title: "Sales \"Q4\"", html: "<!doctype html><h1>Hi</h1>\n<p>ünïcode   ok</p>", data: { a: [1, 2] } });
    const cut = full.slice(0, full.indexOf("ok"));
    const p = partialArtifactInput(cut);
    expect(p).toMatchObject({ _streaming: true, title: 'Sales "Q4"' });
    expect(p.html).toBe("<!doctype html><h1>Hi</h1>\n<p>ünïcode   ");
    expect(p.dataText).toBeUndefined();
  });

  test("keeps the raw text of spec and data objects, complete or not", () => {
    const full = JSON.stringify({ id: "art_1", spec: { type: "page", children: [{ type: "text", text: "a}b" }] }, data: { rows: [1, 2, 3] } });
    expect(partialArtifactInput(full)).toEqual({
      _streaming: true,
      id: "art_1",
      specText: JSON.stringify({ type: "page", children: [{ type: "text", text: "a}b" }] }),
      dataText: JSON.stringify({ rows: [1, 2, 3] }),
    });
    const cut = full.slice(0, full.indexOf("rows") + 8);
    const p = partialArtifactInput(cut);
    expect(p.specText).toBe(JSON.stringify({ type: "page", children: [{ type: "text", text: "a}b" }] }));
    expect(p.dataText).toBe('{"rows":[1');
  });

  test("a half-typed escape or key is left out", () => {
    expect(partialArtifactInput('{"html":"a\\').html).toBe("a");
    expect(partialArtifactInput('{"html":"a\\u00').html).toBe("a");
    expect(partialArtifactInput('{"tit')).toEqual({ _streaming: true });
    expect(partialArtifactInput('{"id":"art_')).toEqual({ _streaming: true });
  });
});

describe("live artifact input while it streams", () => {
  function start(name: string) {
    const acc = new StreamAccumulator();
    acc.push({ type: "stream_event", event: { type: "message_start", message: { id: "m1", model: "x" } } });
    acc.push({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name, input: {} } } });
    const delta = (partial_json: string) => acc.push({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json } } });
    return { acc, delta };
  }

  test("artifact_create shows what is typed so far, then the real input", () => {
    const { acc, delta } = start("mcp__godmode__artifact_create");
    const body = "x".repeat(ARTIFACT_PREVIEW_STEP);
    expect(delta('{"title":"Sales","html":"<p>')).toBe(false);
    expect(delta(body)).toBe(true);
    const block = acc.blocks[0]!;
    expect(block.type === "tool_use" && block.input).toEqual({ _streaming: true, title: "Sales", html: `<p>${body}` });
    expect(delta("y")).toBe(false);
    delta('</p>"}');
    acc.push({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    expect(block.type === "tool_use" && block.input).toEqual({ title: "Sales", html: `<p>${body}y</p>` });
  });

  test("other tools still wait for the whole input", () => {
    const { acc, delta } = start("Write");
    expect(delta(`{"content":"${"x".repeat(ARTIFACT_PREVIEW_STEP * 2)}`)).toBe(false);
    const block = acc.blocks[0]!;
    expect(block.type === "tool_use" && block.input).toEqual({});
  });
});

describe("tool pictures over MCP", () => {
  test("images of a tool result go out as image content after the text", async () => {
    const server: McpServerDef = {
      name: "t",
      instructions: "",
      list: () => [],
      call: async () => ({ content: [{ type: "text", text: "done" }], images: [{ data: "aW1n", mimeType: "image/jpeg" }] }),
      isUnknownTool: () => false,
    };
    const ctx = { runId: "run_x", agentId: "agt_x", conversationId: "cnv_x", workspaceId: null, depth: 0 };
    const res = (await handleRpc(ctx, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x", arguments: {} } }, server)) as { result: unknown };
    expect(res.result).toEqual({ content: [{ type: "text", text: "done" }, { type: "image", data: "aW1n", mimeType: "image/jpeg" }] });
  });
});
