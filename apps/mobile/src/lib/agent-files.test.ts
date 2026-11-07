import { describe, expect, test } from "bun:test";
import "./test-natives.test";

const { filesApi, moveEntries, onFileChange } = await import("./agent-files");

describe("moving several entries", () => {
  test("trying again after a later one failed goes on with the rest", async () => {
    const asked: string[] = [];
    let refuse = true;
    filesApi.move = async (_agent, from, to) => {
      asked.push(from);
      if (from === "workspace/b.md" && refuse) throw new Error("Name taken");
      return { path: to, rewritten: [] } as never;
    };
    const told: unknown[] = [];
    const stop = onFileChange((change) => void told.push(change));
    const gone = new Set<string>();
    const paths = ["workspace/a.md", "workspace/b.md", "workspace/c.md"];

    await expect(moveEntries("agt", paths, "memory", gone)).rejects.toThrow("Name taken");
    expect(told).toEqual([{ agentId: "agt", moves: [{ from: "workspace/a.md", to: "memory/a.md" }] }]);

    refuse = false;
    const done = await moveEntries("agt", paths, "memory", gone);
    stop();
    expect(done.map((d) => d.from)).toEqual(["workspace/b.md", "workspace/c.md"]);
    expect(asked).toEqual(["workspace/a.md", "workspace/b.md", "workspace/b.md", "workspace/c.md"]);
  });

  test("what already is there stays where it is", async () => {
    filesApi.move = async () => {
      throw new Error("not asked");
    };
    expect(await moveEntries("agt", ["memory/a.md"], "memory", new Set())).toEqual([]);
  });
});
