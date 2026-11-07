import { describe, expect, test } from "bun:test";
import "./test-natives.test";

const { fileEditOf, textChunks, toolInputText } = await import("./tool-details");

describe("fileEditOf", () => {
  test("an edit keeps every line", () => {
    const old_string = Array.from({ length: 300 }, (_, i) => `old ${i}`).join("\n");
    const new_string = Array.from({ length: 300 }, (_, i) => `new ${i}`).join("\n");
    const edit = fileEditOf({ name: "Edit", input: { file_path: "/a.ts", old_string, new_string } })!;
    expect(edit.file).toBe("/a.ts");
    expect(edit.added).toBe(300);
    expect(edit.removed).toBe(300);
    expect(edit.rows.length).toBe(600);
  });

  test("unchanged lines stay as context", () => {
    const edit = fileEditOf({ name: "Edit", input: { old_string: "a\nb\nc", new_string: "a\nx\nc" } })!;
    expect(edit.rows.map((r) => r.kind)).toEqual(["same", "del", "add", "same"]);
  });

  test("a new file is all additions", () => {
    const edit = fileEditOf({ name: "Write", input: { file_path: "/b.md", content: "one\ntwo" } })!;
    expect(edit.rows).toEqual([
      { kind: "add", text: "one" },
      { kind: "add", text: "two" },
    ]);
  });

  test("several edits are set apart", () => {
    const edit = fileEditOf({ name: "MultiEdit", input: { edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] } })!;
    expect(edit.rows.map((r) => r.kind)).toEqual(["del", "add", "fold", "del", "add"]);
  });

  test("other tools have none", () => {
    expect(fileEditOf({ name: "Bash", input: { command: "ls" } })).toBeNull();
    expect(fileEditOf({ name: "Edit", input: {} })).toBeNull();
  });
});

describe("toolInputText", () => {
  test("strings stay, objects are indented", () => {
    expect(toolInputText("ls")).toBe("ls");
    expect(toolInputText({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(toolInputText(null)).toBe("");
  });
});

describe("textChunks", () => {
  test("loses nothing", () => {
    const whole = Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(i % 90)}`).join("\n");
    const chunks = textChunks(whole, 400);
    expect(chunks.join("\n")).toBe(whole);
    expect(chunks.every((c) => c.length <= 400)).toBe(true);
  });

  test("cuts a very long line", () => {
    const chunks = textChunks("y".repeat(1000), 300);
    expect(chunks.length).toBe(4);
    expect(chunks.join("")).toBe("y".repeat(1000));
  });

  test("empty text is one empty piece", () => {
    expect(textChunks("")).toEqual([""]);
  });
});
