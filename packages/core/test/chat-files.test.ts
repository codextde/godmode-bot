import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, ChatFile, ChatFiles, Conversation } from "@godmode/shared";
import { barePaths, fileRefs, isPathLike } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { resetSettingsCache } from "../src/services/settings";
import { createApp } from "../src/server/app";
import { getAccessToken } from "../src/server/auth";
import { __setFileManagerForTests, fileManagerCommand } from "../src/services/chatFiles";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

let dataDir: string;
let outside: string;
let app: ReturnType<typeof createApp>;
let token: string;
let agent: Agent;
let chat: Conversation;
let shots: string;
const launched: string[][] = [];

/** `from` = the address the request comes from; none = unknown, as for a request that isn't from this computer. */
async function call<T = unknown>(method: string, path: string, body?: unknown, from?: string, headers: Record<string, string> = {}): Promise<{ status: number; data: T; res: Response }> {
  const res = await app.request(
    `http://127.0.0.1${path}`,
    {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    from ? { requestIP: () => ({ address: from, family: "IPv4", port: 50000 }) } : undefined,
  );
  const data = (res.headers.get("content-type")?.includes("json") ? await res.clone().json() : null) as T;
  return { status: res.status, data, res };
}

const resolveRefs = async (...refs: string[]) => (await call<ChatFiles>("POST", `/api/conversations/${chat.id}/files`, { messages: [refs] })).data.files[0]!;
const byRef = (files: ChatFile[]) => Object.fromEntries(files.map((f) => [f.ref, f]));

beforeAll(async () => {
  setLogLevel("error");
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "godmode-chat-files-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "godmode-chat-files-out-")));
  loadConfig({ dataDir });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  app = createApp();
  token = getAccessToken();
  agent = (await call<Agent>("POST", "/api/agents", { name: "File Bot" })).data;
  chat = (await call<Conversation>("POST", "/api/conversations", { agentId: agent.id })).data;
  shots = join(agent.repoPath, "workspace", "shots");
  mkdirSync(shots, { recursive: true });
  writeFileSync(join(shots, "01-positions.png"), PNG);
  writeFileSync(join(shots, "02 total.png"), PNG);
  writeFileSync(join(shots, "notes.txt"), "notes");
  writeFileSync(join(shots, "fake.png"), "not a picture");
  writeFileSync(join(agent.repoPath, "workspace", "report.pdf"), "%PDF-1.4");
  writeFileSync(join(outside, "desktop.png"), PNG);
  __setFileManagerForTests((command) => void launched.push(command));
});

afterAll(() => {
  __setFileManagerForTests(null);
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("paths a message names", () => {
  test("code, links and bare paths are collected; urls, commands and code blocks aren't", () => {
    const markdown = [
      "The screenshots are in `workspace/shots/`: `01-positions.png` and [the total](<workspace/shots/02 total.png>).",
      "See ![shot](workspace/shots/a%20b.png) and /tmp/out/report.pdf, also (~/Desktop/x.png).",
      "Run `npm run build` on https://example.com/a.png or `git status`; `MEMORY.md` has the rest, `src/app.ts:42` the bug.",
      "Line `notes.txt:3`, [copy](/tmp/out/a(1).png), not /tmp/out/b(2).png, the `/tasks` route or `/`.",
      "```sh",
      "cat `secret.txt` /etc/hosts",
      "```",
      "`01-positions.png` again.",
    ].join("\n");
    expect(fileRefs(markdown)).toEqual([
      "workspace/shots/",
      "01-positions.png",
      "workspace/shots/02 total.png",
      "workspace/shots/a b.png",
      "/tmp/out/report.pdf",
      "~/Desktop/x.png",
      "MEMORY.md",
      "src/app.ts:42",
      "notes.txt:3",
      "/tmp/out/a(1).png",
    ]);
  });

  test("text made to be slow is looked through quickly", () => {
    const started = Date.now();
    expect(fileRefs(`${"[".repeat(100_000)} \`a.png\`\n\`b.png\` ${"[x](".repeat(900)}`)).toEqual(["b.png"]);
    for (const piece of ["[", "![x](", "[x](<", "`", "/a/..."]) {
      const line = piece.repeat(Math.floor(3900 / piece.length));
      fileRefs(Array.from({ length: 300 }, () => line).join("\n"));
      barePaths(Array.from({ length: 40 }, () => line).join(" "));
    }
    expect(barePaths(`/a/${".".repeat(150_000)}x`)).toHaveLength(1);
    // Seconds before the repetitions were bounded; the margin is for a busy machine.
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("a bare path ends before the punctuation of its sentence", () => {
    const text = "Saved to /tmp/out/a.png. Also (~/x/y.txt), C:\\Users\\me\\b.png! Not and/or, 1/2, / or https://example.com/a/b.";
    expect(barePaths(text).map((p) => [p.path, text.slice(p.index, p.index + p.path.length)])).toEqual([
      ["/tmp/out/a.png", "/tmp/out/a.png"],
      ["~/x/y.txt", "~/x/y.txt"],
      ["C:\\Users\\me\\b.png", "C:\\Users\\me\\b.png"],
    ]);
    expect(barePaths("/... and /. and /tmp/a(1).png")).toEqual([]);
  });

  test("what can't be a path is never asked about", () => {
    for (const ref of ["workspace/", "a.png", "~/x", "/tmp/out", "C:\\Users\\me\\a.png", "file:///tmp/a.png", "My Report.pdf", "src/app.ts:12:3", "notes.txt:3"]) {
      expect([ref, isPathLike(ref)]).toEqual([ref, true]);
    }
    for (const ref of ["build", "npm run build", "https://example.com/a.png", "mailto:a@b.c", "localhost:3000", "//server/share", "#anchor", "a | b.txt", "*.png", "$HOME/a.png", "/", "/tasks", "/etc/", ""]) {
      expect([ref, isPathLike(ref)]).toEqual([ref, false]);
    }
  });
});

describe("files of a chat", () => {
  test("requires auth and an existing chat", async () => {
    expect((await app.request(`http://127.0.0.1/api/conversations/${chat.id}/files`, { method: "POST" })).status).toBe(401);
    expect((await call("POST", "/api/conversations/nope/files", { messages: [["a.png"]] })).status).toBe(404);
    expect((await call("POST", `/api/conversations/${chat.id}/files`, { messages: "a.png" })).status).toBe(400);
  });

  test("a relative path starts where the agent works; pictures are told from other files by their bytes", async () => {
    const files = byRef(await resolveRefs("workspace/shots/", "workspace/shots/01-positions.png", "report.pdf", "CLAUDE.md", "workspace/shots/fake.png", "missing.png", "https://example.com/a.png"));
    expect(Object.keys(files)).toEqual(["workspace/shots/", "workspace/shots/01-positions.png", "report.pdf", "CLAUDE.md", "workspace/shots/fake.png"]);
    expect(files["workspace/shots/"]).toEqual({ ref: "workspace/shots/", path: shots, name: "shots", kind: "folder", image: null });
    expect(files["workspace/shots/01-positions.png"]).toMatchObject({ path: join(shots, "01-positions.png"), name: "01-positions.png", kind: "file" });
    expect(files["workspace/shots/01-positions.png"]!.image).toStartWith(`/api/files/image?path=${encodeURIComponent(join(shots, "01-positions.png"))}&v=`);
    // Found in the agent's `workspace/`, where it puts what it produces.
    expect(files["report.pdf"]).toMatchObject({ path: join(agent.repoPath, "workspace", "report.pdf"), image: null });
    expect(files["CLAUDE.md"]!.path).toBe(join(agent.repoPath, "CLAUDE.md"));
    expect(files["workspace/shots/fake.png"]!.image).toBeNull();
  });

  test("a bare name lies in the folder the message names, before or after it", async () => {
    const before = byRef(await resolveRefs("workspace/shots/", "01-positions.png", "02 total.png", "MEMORY.md"));
    expect(before["01-positions.png"]!.path).toBe(join(shots, "01-positions.png"));
    expect(before["02 total.png"]!.image).toBeString();
    expect(before["MEMORY.md"]!.path).toBe(join(agent.repoPath, "MEMORY.md"));

    const after = byRef(await resolveRefs("01-positions.png", "notes.txt:3", "workspace/shots"));
    expect(after["01-positions.png"]!.path).toBe(join(shots, "01-positions.png"));
    expect(after["notes.txt:3"]!.path).toBe(join(shots, "notes.txt"));

    // Without the folder, the name alone says nothing.
    expect(await resolveRefs("01-positions.png")).toEqual([]);
    // Every message is looked at on its own.
    const { data } = await call<ChatFiles>("POST", `/api/conversations/${chat.id}/files`, { messages: [["workspace/shots/"], ["01-positions.png"], []] });
    expect(data.files.map((m) => m.length)).toEqual([1, 0, 0]);
  });

  test("absolute paths, ~ and file urls are found anywhere; network paths aren't followed", async () => {
    const picture = join(outside, "desktop.png");
    const files = byRef(await resolveRefs(picture, `file://${picture}`, outside, `${picture}:12`, "//server/share/a.png", join(outside, "gone.png")));
    expect(Object.keys(files)).toEqual([picture, `file://${picture}`, outside, `${picture}:12`]);
    expect(files[picture]!.image).toBeString();
    expect(files[`file://${picture}`]!.path).toBe(picture);
    expect(files[outside]!.kind).toBe("folder");
  });

  test("the chat's own folder comes first", async () => {
    const folder = join(outside, "project");
    mkdirSync(join(folder, "workspace", "shots"), { recursive: true });
    writeFileSync(join(folder, "workspace", "shots", "01-positions.png"), PNG);
    const inFolder = (await call<Conversation>("POST", "/api/conversations", { agentId: agent.id, workingDirectory: folder })).data;
    const { data } = await call<ChatFiles>("POST", `/api/conversations/${inFolder.id}/files`, { messages: [["workspace/shots/01-positions.png", "workspace/report.pdf"]] });
    expect(data.files[0]!.map((f) => f.path)).toEqual([join(folder, "workspace", "shots", "01-positions.png"), join(agent.repoPath, "workspace", "report.pdf")]);
  });

  test("only pictures are served", async () => {
    const image = (await resolveRefs("workspace/shots/01-positions.png"))[0]!.image!;
    const { status, res } = await call("GET", image);
    expect(status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);

    const link = join(outside, "link.png");
    symlinkSync(join(shots, "notes.txt"), link);
    // A named pipe must not make the core wait for its writer.
    const pipe = join(outside, "pipe.png");
    if (process.platform !== "win32") Bun.spawnSync(["mkfifo", pipe]);
    for (const path of [join(shots, "notes.txt"), join(shots, "fake.png"), link, pipe, join(dataDir, "access-token"), shots, join(shots, "gone.png")]) {
      expect([path, (await call("GET", `/api/files/image?path=${encodeURIComponent(path)}`)).status]).toEqual([path, 404]);
    }
    expect((await call("GET", "/api/files/image?path=workspace/shots/01-positions.png")).status).toBe(400);
    expect((await call("GET", "/api/files/image")).status).toBe(400);
    expect((await app.request(`http://127.0.0.1${image}`)).status).toBe(401);
  });
});

describe("showing a file in the file manager", () => {
  test("only for the app on this computer", async () => {
    const path = join(shots, "01-positions.png");
    expect((await call<ChatFiles>("POST", `/api/conversations/${chat.id}/files`, { messages: [] })).data.local).toBe(false);
    expect((await call<ChatFiles>("POST", `/api/conversations/${chat.id}/files`, { messages: [] }, "127.0.0.1")).data.local).toBe(true);
    expect((await call<ChatFiles>("POST", `/api/conversations/${chat.id}/files`, { messages: [] }, "::1", { "x-forwarded-for": "203.0.113.7" })).data.local).toBe(false);

    for (const origin of ["tauri://localhost", "http://127.0.0.1:7777", "http://localhost:1420"]) {
      expect([origin, (await call<ChatFiles>("POST", `/api/conversations/${chat.id}/files`, { messages: [] }, "127.0.0.1", { origin })).data.local]).toEqual([origin, true]);
    }

    const remote = [
      [undefined, {}],
      ["192.168.1.20", {}],
      ["127.0.0.1", { "x-forwarded-for": "203.0.113.7" }],
      ["127.0.0.1", { forwarded: "for=203.0.113.7" }],
      // A reverse proxy on this computer that adds no header: the page still comes from elsewhere.
      ["127.0.0.1", { origin: "https://godmode.example.com" }],
    ] as const;
    for (const [from, headers] of remote) {
      const refused = await call<{ code: string }>("POST", "/api/files/reveal", { path }, from, headers);
      expect([refused.status, refused.data.code]).toEqual([403, "not_local"]);
    }
    expect(launched).toEqual([]);

    expect((await call("POST", "/api/files/reveal", { path }, "127.0.0.1")).status).toBe(200);
    expect((await call("POST", "/api/files/reveal", { path: shots }, "::ffff:127.0.0.1")).status).toBe(200);
    expect(launched).toEqual([fileManagerCommand(path, "file"), fileManagerCommand(shots, "folder")]);
  });

  test("a link to a bundle is selected, not opened", async () => {
    launched.length = 0;
    mkdirSync(join(outside, "Tool.app"));
    symlinkSync(join(outside, "Tool.app"), join(outside, "tool"));
    expect((await call("POST", "/api/files/reveal", { path: join(outside, "tool") }, "127.0.0.1")).status).toBe(200);
    expect(launched).toEqual([fileManagerCommand(join(outside, "tool"), "folder", process.platform, join(outside, "Tool.app"))]);
  });

  test("needs an absolute path that exists", async () => {
    launched.length = 0;
    expect((await call("POST", "/api/files/reveal", { path: join(shots, "gone.png") }, "127.0.0.1")).status).toBe(404);
    expect((await call("POST", "/api/files/reveal", { path: "workspace/shots" }, "127.0.0.1")).status).toBe(400);
    expect((await call("POST", "/api/files/reveal", {}, "127.0.0.1")).status).toBe(400);
    expect(launched).toEqual([]);
  });

  test("a file is selected, a folder opened — and nothing is ever run", () => {
    expect(fileManagerCommand("/a/shot.png", "file", "darwin")).toEqual(["open", "-R", "/a/shot.png"]);
    expect(fileManagerCommand("/a/shots", "folder", "darwin")).toEqual(["open", "/a/shots"]);
    expect(fileManagerCommand("/a/Evil.app", "folder", "darwin")).toEqual(["open", "-R", "/a/Evil.app"]);
    expect(fileManagerCommand("/a/run.command", "file", "darwin")).toEqual(["open", "-R", "/a/run.command"]);
    // A link with a harmless name that leads to an app.
    expect(fileManagerCommand("/a/shots", "folder", "darwin", "/Applications/Evil.app")).toEqual(["open", "-R", "/a/shots"]);
    expect(fileManagerCommand("C:\\a\\shot.png", "file", "win32")).toEqual(["explorer.exe", "/select,C:\\a\\shot.png"]);
    expect(fileManagerCommand("C:\\a\\shots", "folder", "win32")).toEqual(["explorer.exe", "C:\\a\\shots"]);
    expect(fileManagerCommand("/a/shot.png", "file", "linux")).toEqual(["xdg-open", "/a"]);
    expect(fileManagerCommand("/a/shots", "folder", "linux")).toEqual(["xdg-open", "/a/shots"]);
  });

  test("phones can't reach this computer's files", async () => {
    const { deviceMayCall } = await import("../src/mobile/scope");
    expect(deviceMayCall("POST", `/api/conversations/${chat.id}/files`)).toBe(false);
    expect(deviceMayCall("GET", "/api/files/image")).toBe(false);
    expect(deviceMayCall("POST", "/api/files/reveal")).toBe(false);
  });
});
