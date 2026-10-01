import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Agent, Task } from "@godmode/shared";
import { githubBranchUrl, hostedRepo, taskAttachmentUrl } from "@godmode/shared";
import { invocations, makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { startSmartGitServer, type SmartGitServer } from "./fixtures/smart-git-server";
import { all, get, run as sql } from "../src/db";
import { getRun, activeRunForConversation } from "../src/runner/runner";
import { createWorkspace, deleteWorkspace, updateWorkspace } from "../src/services/workspaces";
import { workingDirectoryProblem } from "../src/services/folders";
import {
  archiveTasks,
  checkPullRequests,
  checkoutDir,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  pushTaskBranch,
  sendTaskMessage,
  startTasks,
  stopTasks,
  updateTask,
} from "../src/tasks/service";
import { getFollowup, scheduleFollowup } from "../src/services/followups";
import { __setGhForTests, compareUrl, openPullRequest, repoCacheDir } from "../src/tasks/git";
import { HttpError } from "../src/util";
import { rememberSecret } from "../src/vault/vault";
import { updateSettings } from "../src/services/settings";
import { mkdtempSync } from "node:fs";

let env: TestEnv;
let gitServer: SmartGitServer;
let agent: Agent;
let wsAgent: Agent;
let workspaceId: string;
let otherWorkspaceId: string;

const git = async (args: string[], cwd: string) => {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
};

function makeRemote(name: string): { url: string; bare: string } {
  return gitServer.create(name);
}

const settled = (id: string, statuses: Task["status"][]) =>
  until(() => statuses.includes(getTask(id).status) && !getTask(id).activity, 20_000, `task ${id} → ${statuses.join("/")}`);

async function catchHttp(fn: () => unknown): Promise<HttpError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return err as HttpError;
  }
  throw new Error("expected an HttpError");
}

beforeAll(async () => {
  env = await setupEnv("godmode-tasks-");
  gitServer = startSmartGitServer();
  __setGhForTests(null);
  startTasks();
  agent = await makeAgent({ name: "Task Bot" });
  workspaceId = createWorkspace({ name: "Board" }).id;
  otherWorkspaceId = createWorkspace({ name: "Elsewhere" }).id;
  wsAgent = await makeAgent({ name: "Board Bot", workspaceId });
});

afterAll(async () => {
  stopTasks();
  __setGhForTests(undefined);
  await env.close();
  gitServer.close();
});

describe("board", () => {
  test("create numbers tasks, parks them without an agent and orders columns", () => {
    const a = createTask({ workspaceId, title: "  First   task " });
    const b = createTask({ workspaceId, title: "Second", description: "details", type: "research" });
    expect(a.title).toBe("First task");
    expect(a.status).toBe("backlog");
    expect(b.number).toBe(a.number + 1);
    expect(b.type).toBe("research");
    expect(b.position).toBeGreaterThan(a.position);

    const moved = updateTask(b.id, { beforeId: a.id });
    expect(moved.position).toBeLessThan(getTask(a.id).position);
    const backlog = listTasks({ workspaceId }).filter((t) => t.status === "backlog").map((t) => t.id);
    expect(backlog.indexOf(b.id)).toBeLessThan(backlog.indexOf(a.id));
    expect(listTasks({ workspaceId: "global" }).some((t) => t.id === a.id)).toBe(false);
    expect(listTasks().some((t) => t.id === a.id)).toBe(true);
  });

  test("validates input and agent reach", async () => {
    expect((await catchHttp(() => createTask({ workspaceId, title: "  " }))).status).toBe(400);
    expect((await catchHttp(() => createTask({ workspaceId, title: "x", type: "nope" as never }))).status).toBe(400);
    expect((await catchHttp(() => createTask({ workspaceId, title: "x", repoUrl: "not a url" }))).status).toBe(400);
    expect((await catchHttp(() => createTask({ workspaceId, title: "x", repoUrl: "https://me:token@github.com/acme/app.git" }))).status).toBe(400);
    expect(createTask({ workspaceId, title: "web link", repoUrl: "https://github.com/acme/app/tree/main", status: "backlog" }).repoUrl).toBe("https://github.com/acme/app.git");
    expect((await catchHttp(() => createTask({ workspaceId, title: "x", baseBranch: "bad..branch" }))).status).toBe(400);
    const err = await catchHttp(() => createTask({ workspaceId: otherWorkspaceId, title: "x", agentId: wsAgent.id }));
    expect(err.message).toContain("another workspace");
    // Global agents may work on any workspace's tasks.
    expect(createTask({ workspaceId: otherWorkspaceId, title: "global agent ok", agentId: agent.id, status: "backlog" }).agentId).toBe(agent.id);
  });

  test("a task checkout is allowed as a working folder, the rest of the data dir is not", () => {
    const dir = checkoutDir("tsk_probe");
    mkdirSync(dir, { recursive: true });
    expect(workingDirectoryProblem(dir)).toBeNull();
    mkdirSync(join(dir, "nested"), { recursive: true });
    expect(workingDirectoryProblem(join(dir, "nested"))).not.toBeNull();
    expect(workingDirectoryProblem(join(env.dataDir, "tasks"))).not.toBeNull();
  });
});

describe("agents work on tasks", () => {
  test("assigning an agent in Todo starts it; a successful run lands in review", async () => {
    const task = createTask({ workspaceId, title: "Say hello", agentId: wsAgent.id });
    expect(["todo", "in_progress"]).toContain(task.status);
    await settled(task.id, ["in_review"]);
    const done = getTask(task.id);
    expect(done.summary).toContain("Hello");
    expect(done.runStatus).toBe("succeeded");
    const conv = get<{ origin: string; archived: number; agent_id: string }>("SELECT origin, archived, agent_id FROM conversations WHERE id = ?", done.conversationId!);
    expect(conv).toEqual({ origin: "task", archived: 1, agent_id: wsAgent.id });
    expect(getRun(done.runId!).trigger).toBe("task");
    expect(getRun(done.runId!).prompt).toContain("# Say hello");
  });

  test("backlog never starts; moving to Todo does", async () => {
    const task = createTask({ workspaceId, title: "Parked", agentId: wsAgent.id, status: "backlog" });
    await Bun.sleep(100);
    expect(getTask(task.id).conversationId).toBeNull();
    updateTask(task.id, { status: "todo" });
    await settled(task.id, ["in_review"]);
  });

  test("a failed run blocks the task with the reason, and Todo retries it", async () => {
    const task = createTask({ workspaceId, title: "CRASH please", agentId: wsAgent.id });
    await settled(task.id, ["blocked"]);
    expect(getTask(task.id).blockedReason).toContain("exploded");
    const firstConversation = getTask(task.id).conversationId;
    updateTask(task.id, { status: "todo", title: "Say hi instead" });
    await settled(task.id, ["in_review"]);
    expect(getTask(task.id).conversationId).toBe(firstConversation);
    expect(getTask(task.id).blockedReason).toBeNull();
  });

  test("the agent can report that it's blocked", async () => {
    const task = createTask({ workspaceId, title: "TASK_BLOCKED billing export", agentId: wsAgent.id });
    await settled(task.id, ["blocked"]);
    const t = getTask(task.id);
    expect(t.blockedReason).toBe("Need admin access to the billing portal");
    expect(t.summary).toContain('"listed":true');
  });

  test("moving a running task away stops its agent", async () => {
    const task = createTask({ workspaceId, title: "SLEEP forever", agentId: wsAgent.id });
    await until(() => getTask(task.id).runStatus === "running", 10_000, "run to start");
    updateTask(task.id, { status: "backlog" });
    await until(() => getTask(task.id).runStatus === "cancelled", 10_000, "run to be cancelled");
    expect(getTask(task.id).status).toBe("backlog");
    expect(activeRunForConversation(getTask(task.id).conversationId!)).toBeNull();
  });

  test("a follow-up puts a delivered task back to work", async () => {
    const task = createTask({ workspaceId, title: "Hello again", agentId: wsAgent.id });
    await settled(task.id, ["in_review"]);
    const before = getTask(task.id).runId;
    await sendTaskMessage(task.id, "One more thing");
    await until(() => getTask(task.id).runId !== before, 5_000, "follow-up run");
    await settled(task.id, ["in_review"]);
    expect(getTask(task.id).runStatus).toBe("succeeded");
  });

  test("Godmode restarts interrupted work as blocked and picks up queued tasks", async () => {
    const t = createTask({ workspaceId, title: "Interrupted", status: "backlog" });
    sql("UPDATE tasks SET status = 'in_progress' WHERE id = ?", t.id);
    const queued = createTask({ workspaceId, title: "Queued before restart", status: "backlog" });
    sql("UPDATE tasks SET status = 'todo', agent_id = ? WHERE id = ?", wsAgent.id, queued.id);
    stopTasks();
    startTasks();
    expect(getTask(t.id).status).toBe("blocked");
    expect(getTask(t.id).blockedReason).toContain("Interrupted");
    await settled(queued.id, ["in_review"]);
  });
});

describe("archive", () => {
  test("archived tasks leave the board with their status and come back on top of their column", () => {
    const a = createTask({ workspaceId, title: "Shipped", status: "done" });
    const b = createTask({ workspaceId, title: "Also shipped", status: "done" });
    const archived = updateTask(a.id, { archived: true });
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.status).toBe("done");
    expect(listTasks({ workspaceId }).some((t) => t.id === a.id)).toBe(false);
    expect(listTasks({ workspaceId, archived: true }).map((t) => t.id)).toContain(a.id);
    expect(listTasks({ archived: true }).every((t) => t.archivedAt)).toBe(true);
    expect(updateTask(a.id, { title: "Shipped!" }).archivedAt).not.toBeNull();

    const back = updateTask(a.id, { archived: false });
    expect(back.archivedAt).toBeNull();
    expect(back.position).toBeLessThan(getTask(b.id).position);
  });

  test("moving an archived task brings it back on top of its new column", () => {
    createTask({ workspaceId, title: "Already parked", status: "backlog" });
    const t = createTask({ workspaceId, title: "Reopen me", status: "cancelled" });
    updateTask(t.id, { archived: true });
    const moved = updateTask(t.id, { status: "backlog" });
    expect(moved.archivedAt).toBeNull();
    expect(moved.status).toBe("backlog");
    expect(listTasks({ workspaceId }).find((x) => x.status === "backlog")?.id).toBe(t.id);
    expect(updateTask(t.id, { status: "done", archived: true }).archivedAt).not.toBeNull();
  });

  test("restoring a whole column keeps its order", () => {
    const ids = ["Order A", "Order B", "Order C"].map((title) => createTask({ workspaceId: otherWorkspaceId, title, status: "done" }).id);
    archiveTasks(ids, true);
    expect(listTasks({ workspaceId: otherWorkspaceId }).some((t) => ids.includes(t.id))).toBe(false);
    expect(archiveTasks(ids, false).map((t) => t.id)).toEqual(ids);
    const column = listTasks({ workspaceId: otherWorkspaceId }).filter((t) => ids.includes(t.id));
    expect(column.map((t) => t.id)).toEqual(ids);
  });

  test("archiving a working task stops its agent and parks it in the backlog", async () => {
    const task = createTask({ workspaceId, title: "SLEEP forever", agentId: wsAgent.id });
    await until(() => getTask(task.id).runStatus === "running", 10_000, "run to start");
    expect(updateTask(task.id, { archived: true }).status).toBe("backlog");
    await until(() => getTask(task.id).runStatus === "cancelled", 10_000, "run to be cancelled");
    expect(getTask(task.id).status).toBe("backlog");
    expect(getTask(task.id).archivedAt).not.toBeNull();
  });

  test("archiving while a restart waits for the old run keeps the task from starting", async () => {
    const task = createTask({ workspaceId, title: "SLEEP forever", agentId: wsAgent.id });
    await until(() => getTask(task.id).runStatus === "running", 10_000, "run to start");
    const firstRun = getTask(task.id).runId;
    updateTask(task.id, { status: "todo" });
    updateTask(task.id, { archived: true });
    await until(() => getTask(task.id).runStatus === "cancelled", 10_000, "old run to be cancelled");
    await Bun.sleep(150);
    const t = getTask(task.id);
    expect(t.runId).toBe(firstRun);
    expect(t.status).toBe("todo");
    expect(t.archivedAt).not.toBeNull();
    expect(t.activity).toBeNull();
  });

  test("archiving cancels the follow-up the agent scheduled", async () => {
    const task = createTask({ workspaceId, title: "Hello, check back later", agentId: wsAgent.id });
    await settled(task.id, ["in_review"]);
    const conversationId = getTask(task.id).conversationId!;
    scheduleFollowup({ conversationId, agentId: wsAgent.id, dueAt: new Date(Date.now() + 3_600_000), note: "Check the CI run" });
    expect(getFollowup(conversationId)).not.toBeNull();
    updateTask(task.id, { archived: true });
    expect(getFollowup(conversationId)).toBeNull();
  });

  test("archived tasks never start, not even after a restart; restoring a queued one starts it", async () => {
    const task = createTask({ workspaceId, title: "Say hello later", status: "todo" });
    updateTask(task.id, { archived: true });
    updateTask(task.id, { agentId: wsAgent.id });
    stopTasks();
    startTasks();
    await Bun.sleep(150);
    expect(getTask(task.id).conversationId).toBeNull();
    expect(getTask(task.id).status).toBe("todo");

    updateTask(task.id, { archived: false });
    await settled(task.id, ["in_review"]);
  });

  test("a follow-up brings an archived task back to work", async () => {
    const task = createTask({ workspaceId, title: "Hello archive", agentId: wsAgent.id });
    await settled(task.id, ["in_review"]);
    updateTask(task.id, { status: "done", archived: true });
    const before = getTask(task.id).runId;
    await sendTaskMessage(task.id, "One more thing");
    await until(() => getTask(task.id).runId !== before, 5_000, "follow-up run");
    await settled(task.id, ["in_review"]);
    expect(getTask(task.id).archivedAt).toBeNull();
  });

  test("a whole column is archived in one request; archived tasks are listed apart", async () => {
    const { createApp } = await import("../src/server/app");
    const { getAccessToken } = await import("../src/server/auth");
    const app = createApp();
    const headers = { authorization: `Bearer ${getAccessToken()}`, "content-type": "application/json" };
    const ids = [createTask({ title: "Global done 1", status: "done" }).id, createTask({ title: "Global done 2", status: "done" }).id];
    const res = await app.request("http://127.0.0.1/api/tasks/archive", { method: "POST", headers, body: JSON.stringify({ ids }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Task[]).every((t) => t.archivedAt)).toBe(true);

    const list = async (query: string) => ((await (await app.request(`http://127.0.0.1/api/tasks?${query}`, { headers })).json()) as Task[]).map((t) => t.id);
    expect((await list("workspaceId=global")).some((id) => ids.includes(id))).toBe(false);
    expect(await list("workspaceId=global&archived=1")).toEqual(expect.arrayContaining(ids));

    const unknown = await app.request("http://127.0.0.1/api/tasks/archive", {
      method: "POST",
      headers,
      body: JSON.stringify({ ids: [ids[0], "tsk_missing"], archived: false }),
    });
    expect(unknown.status).toBe(404);
    expect(getTask(ids[0]!).archivedAt).not.toBeNull();
  });
});

describe("coding tasks", () => {
  test("need a repository", async () => {
    const task = createTask({ title: "TASK_EDIT something", type: "coding", agentId: agent.id });
    await settled(task.id, ["blocked"]);
    expect(getTask(task.id).blockedReason).toContain("git repository");
  });

  test("clone onto a branch, commit and push the agent's work, update it after follow-ups", async () => {
    const { url, bare: remote } = makeRemote("app");
    updateWorkspace(workspaceId, { sources: [{ kind: "git", url }] });
    const task = createTask({ workspaceId, title: "TASK_EDIT add a change file", type: "coding", agentId: wsAgent.id });
    await settled(task.id, ["in_review"]);
    const t = getTask(task.id);
    expect(t.repoUrl).toBe(url);
    expect(t.baseBranch).toBe("main");
    expect(t.branch).toBe(`godmode/${t.number}-task-edit-add-a-change-file`);
    expect(t.pullRequest).toBeNull();
    const dir = checkoutDir(t.id);
    expect(t.worktree).toBe(dir);
    expect(get<{ working_directory: string }>("SELECT working_directory FROM conversations WHERE id = ?", t.conversationId!)?.working_directory).toBe(dir);
    // A worktree of Godmode's one clone of the repository, not a clone of its own.
    expect(statSync(join(dir, ".git")).isFile()).toBe(true);
    expect(realpathSync(resolve(dir, await git(["rev-parse", "--git-common-dir"], dir)))).toBe(realpathSync(repoCacheDir(url)));
    expect(await git(["rev-list", "--count", `main..${t.branch}`], remote)).toBe("1");
    expect(await git(["log", "-1", "--format=%s", t.branch!], remote)).toBe(`${t.title} (#${t.number})`);
    expect(await git(["show", `${t.branch}:TASK_CHANGE.md`], remote)).toContain("assigned task");

    await sendTaskMessage(t.id, "TASK_EDIT once more");
    await until(() => getTask(t.id).runId !== t.runId, 5_000, "follow-up run");
    await settled(t.id, ["in_review"]);
    expect(await git(["rev-list", "--count", `main..${t.branch}`], remote)).toBe("2");
  });

  test("no code changes: in review without a pull request", async () => {
    const task = createTask({ workspaceId, title: "Look but don't touch", type: "coding", agentId: wsAgent.id });
    await settled(task.id, ["in_review"]);
    expect(getTask(task.id).pullRequest).toBeNull();
  });

  test("an unknown base branch blocks with a clear reason", async () => {
    const task = createTask({ workspaceId, title: "TASK_EDIT", type: "coding", agentId: wsAgent.id, baseBranch: "release" });
    await settled(task.id, ["blocked"]);
    expect(getTask(task.id).blockedReason).toContain('"release" doesn\'t exist');
  });

  test("deleting a task removes its checkout", async () => {
    const task = createTask({ workspaceId, title: "TASK_EDIT temp", type: "coding", agentId: wsAgent.id });
    await settled(task.id, ["in_review"]);
    expect(existsSync(checkoutDir(task.id))).toBe(true);
    await deleteTask(task.id);
    expect(existsSync(checkoutDir(task.id))).toBe(false);
    expect(listTasks().some((t) => t.id === task.id)).toBe(false);
  });
});

describe("every task works in its own worktree", () => {
  let url = "";
  let remote = "";
  /** The human's own clone, added to the workspace as a folder. */
  let local = "";
  let repoWorkspace = "";
  let repoAgent: Agent;
  const roots: string[] = [];
  const tempRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "godmode-task-folder-"));
    roots.push(root);
    return root;
  };
  const taskLine = (t: Task) => `task #${t.number} on the task board`;

  beforeAll(async () => {
    ({ url, bare: remote } = makeRemote("local-app"));
    const root = tempRoot();
    local = join(root, "app");
    await git(["clone", "-q", url, local], root);
    repoWorkspace = createWorkspace({ name: "Local repo", sources: [{ kind: "folder", path: local }] }).id;
    repoAgent = await makeAgent({ name: "Repo Bot", workspaceId: repoWorkspace });
  });

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  test("tasks started side by side get worktrees of the workspace's folder; the human's copy stays untouched", async () => {
    const a = createTask({ workspaceId: repoWorkspace, title: "TASK_EDIT first change", type: "coding", agentId: repoAgent.id });
    const b = createTask({ workspaceId: repoWorkspace, title: "TASK_EDIT second change", type: "coding", agentId: repoAgent.id });
    await settled(a.id, ["in_review"]);
    await settled(b.id, ["in_review"]);
    for (const t of [getTask(a.id), getTask(b.id)]) {
      expect(t.repoPath).toBe(local);
      expect(t.repoUrl).toBe(url);
      expect(t.baseBranch).toBe("main");
      expect(t.worktree).toBe(checkoutDir(t.id));
      // A worktree of the human's repository: the branch lives there, and Godmode pushed it.
      expect(statSync(join(t.worktree!, ".git")).isFile()).toBe(true);
      expect(realpathSync(resolve(t.worktree!, await git(["rev-parse", "--git-common-dir"], t.worktree!)))).toBe(realpathSync(join(local, ".git")));
      expect(await git(["branch", "--list", t.branch!], local)).toContain(t.branch!);
      expect(await git(["show", `${t.branch}:TASK_CHANGE.md`], remote)).toContain(taskLine(t));
      // The run worked in the worktree, without the human's folder.
      const run = invocations(env).find((i) => i.prompt.includes(`# ${t.title}`))!;
      expect(run.cwd).toBe(realpathSync(t.worktree!));
      expect(run.args).not.toContain(local);
      expect(run.prompt).toContain("your own git worktree of");
    }
    // Each worktree only has its own task's change.
    expect(readFileSync(join(checkoutDir(a.id), "TASK_CHANGE.md"), "utf8")).not.toContain(taskLine(getTask(b.id)));
    expect(readFileSync(join(checkoutDir(b.id), "TASK_CHANGE.md"), "utf8")).not.toContain(taskLine(getTask(a.id)));
    expect(existsSync(join(local, "TASK_CHANGE.md"))).toBe(false);
    expect(await git(["branch", "--show-current"], local)).toBe("main");
    expect(await git(["status", "--porcelain"], local)).toBe("");
  });

  test("general tasks get a worktree too: their changes are committed on their branch, which isn't pushed", async () => {
    const task = createTask({ workspaceId: repoWorkspace, title: "TASK_EDIT jot a note", agentId: repoAgent.id });
    await settled(task.id, ["in_review"]);
    const t = getTask(task.id);
    expect(t.type).toBe("general");
    expect(t.branch).toStartWith(`godmode/${t.number}-`);
    expect(await git(["show", `${t.branch}:TASK_CHANGE.md`], local)).toContain(taskLine(t));
    expect(await git(["status", "--porcelain"], t.worktree!)).toBe("");
    expect(existsSync(join(local, "TASK_CHANGE.md"))).toBe(false);
    expect(await git(["branch", "--list", t.branch!], remote)).toBe("");
  });

  test("without bypass mode the agent can't edit the worktree's .git", async () => {
    updateSettings({ runner: { bypassPermissions: false } });
    try {
      const task = createTask({ workspaceId: repoWorkspace, title: "Say hello from a guarded worktree", agentId: repoAgent.id });
      await settled(task.id, ["in_review"]);
      const run = invocations(env).find((i) => i.prompt.includes("# Say hello from a guarded worktree"))!;
      const denied = run.args[run.args.indexOf("--disallowedTools") + 1]!;
      expect(denied).toContain(`Edit(/${checkoutDir(task.id)}/.git)`);
    } finally {
      updateSettings({ runner: { bypassPermissions: true } });
    }
  });

  test("a new task never takes over a branch that already has its name", async () => {
    const task = createTask({ workspaceId: repoWorkspace, title: "TASK_EDIT taken name", type: "coding", status: "backlog" });
    const name = `godmode/${task.number}-task-edit-taken-name`;
    await git(["branch", name, "main"], local);
    updateTask(task.id, { agentId: repoAgent.id, status: "todo" });
    await settled(task.id, ["in_review"]);
    expect(getTask(task.id).branch).toBe(`${name}-2`);
    expect(await git(["rev-list", "--count", `main..${name}`], local)).toBe("0");
  });

  test("a worktree whose creation was interrupted is set aside, not reused", async () => {
    const task = createTask({ workspaceId: repoWorkspace, title: "TASK_EDIT interrupted", type: "coding", agentId: repoAgent.id });
    await settled(task.id, ["in_review"]);
    const t = getTask(task.id);
    rmSync(resolve(t.worktree!, await git(["rev-parse", "--git-path", "index"], t.worktree!)));
    updateTask(t.id, { status: "todo" });
    await until(() => getTask(t.id).runId !== t.runId, 10_000, "restarted run");
    await settled(t.id, ["in_review"]);
    expect(await git(["status", "--porcelain"], t.worktree!)).toBe("");
    expect(await git(["rev-list", "--count", `main..${t.branch}`], remote)).toBe("2");
    expect(readdirSync(join(env.dataDir, "repos", ".trash")).some((n) => n.startsWith(t.id))).toBe(true);
  });

  test("a full clone from before worktrees is kept, and a new task never works on its default branch", async () => {
    const task = createTask({ title: "TASK_EDIT legacy clone", type: "coding", repoUrl: url, status: "backlog" });
    const before = await git(["rev-parse", "main"], remote);
    await git(["clone", "-q", url, checkoutDir(task.id)], env.dataDir);
    updateTask(task.id, { agentId: agent.id, status: "todo" });
    await settled(task.id, ["in_review"]);
    const t = getTask(task.id);
    expect(t.branch).toBe(`godmode/${t.number}-task-edit-legacy-clone`);
    expect(statSync(join(t.worktree!, ".git")).isDirectory()).toBe(true);
    expect(await git(["rev-parse", "main"], remote)).toBe(before);
    expect(await git(["show", `${t.branch}:TASK_CHANGE.md`], remote)).toContain(taskLine(t));
  });

  test("a clone of one branch only still takes and updates the task's pushed branch", async () => {
    const root = tempRoot();
    const narrow = join(root, "narrow");
    await git(["clone", "-q", "--single-branch", url, narrow], root);
    const ws = createWorkspace({ name: "Single branch", sources: [{ kind: "folder", path: narrow }] }).id;
    const task = createTask({ workspaceId: ws, title: "TASK_EDIT narrow change", type: "coding", agentId: agent.id });
    await settled(task.id, ["in_review"]);
    const t = getTask(task.id);
    await sendTaskMessage(t.id, "TASK_EDIT once more");
    await until(() => getTask(t.id).runId !== t.runId, 5_000, "follow-up run");
    await settled(t.id, ["in_review"]);
    expect(getTask(t.id).blockedReason).toBeNull();
    expect(await git(["rev-list", "--count", `main..${t.branch}`], remote)).toBe("2");
  });

  test("other tasks don't need git: without a reachable repository they work without a worktree", async () => {
    const ws = createWorkspace({ name: "Unreachable", sources: [{ kind: "git", url: "http://127.0.0.1:9/nobody/nothing.git" }] }).id;
    const task = createTask({ workspaceId: ws, title: "Say hello without git", type: "research", agentId: agent.id });
    await settled(task.id, ["in_review"]);
    expect(getTask(task.id).worktree).toBeNull();
    const coding = createTask({ workspaceId: ws, title: "TASK_EDIT needs git", type: "coding", agentId: agent.id });
    await settled(coding.id, ["blocked"]);
    expect(getTask(coding.id).blockedReason).toContain("worktree");
  });

  test("a remote that can't be reached later: tasks start from Godmode's clone", async () => {
    const gone = makeRemote("vanishing");
    const first = createTask({ title: "Say hello first", type: "research", repoUrl: gone.url, agentId: agent.id });
    await settled(first.id, ["in_review"]);
    rmSync(gone.bare, { recursive: true, force: true });
    const second = createTask({ title: "Say hello again", type: "research", repoUrl: gone.url, agentId: agent.id });
    await settled(second.id, ["in_review"]);
    expect(getTask(second.id).worktree).toBe(checkoutDir(second.id));
    expect(existsSync(join(checkoutDir(second.id), "README.md"))).toBe(true);
  });

  test("a removed worktree is made again on the task's branch when it restarts", async () => {
    const task = createTask({ workspaceId: repoWorkspace, title: "TASK_EDIT restart me", type: "coding", agentId: repoAgent.id });
    await settled(task.id, ["in_review"]);
    const t = getTask(task.id);
    rmSync(t.worktree!, { recursive: true, force: true });
    updateTask(t.id, { status: "todo" });
    await until(() => getTask(t.id).runId !== t.runId, 10_000, "restarted run");
    await settled(t.id, ["in_review"]);
    expect(await git(["rev-list", "--count", `main..${t.branch}`], remote)).toBe("2");
  });

  test("deleting a task removes its worktree from the repository; its branch stays", async () => {
    const task = createTask({ workspaceId: repoWorkspace, title: "TASK_EDIT short-lived", type: "coding", agentId: repoAgent.id });
    await settled(task.id, ["in_review"]);
    const t = getTask(task.id);
    const where = realpathSync(t.worktree!);
    expect(await git(["worktree", "list", "--porcelain"], local)).toContain(where);
    await deleteTask(t.id);
    expect(existsSync(t.worktree!)).toBe(false);
    expect(await git(["worktree", "list", "--porcelain"], local)).not.toContain(where);
    expect(await git(["branch", "--list", t.branch!], local)).toContain(t.branch!);
  });

  test("a local repository without a remote keeps the work on the task's branch", async () => {
    const root = tempRoot();
    const offline = join(root, "offline");
    mkdirSync(offline);
    await git(["init", "-q", "-b", "trunk"], offline);
    writeFileSync(join(offline, "README.md"), "offline\n");
    await git(["add", "-A"], offline);
    await git(["-c", "user.name=Human", "-c", "user.email=h@example.com", "commit", "-qm", "Start"], offline);
    const ws = createWorkspace({ name: "Offline", sources: [{ kind: "folder", path: offline }] }).id;
    const task = createTask({ workspaceId: ws, title: "TASK_EDIT offline change", type: "coding", agentId: agent.id });
    await settled(task.id, ["in_review"]);
    const t = getTask(task.id);
    expect(t.repoUrl).toBe("");
    expect(t.baseBranch).toBe("trunk");
    expect(t.pullRequest).toBeNull();
    expect(await git(["log", "-1", "--format=%s", t.branch!], offline)).toBe(`${t.title} (#${t.number})`);
    expect(await git(["branch", "--show-current"], offline)).toBe("trunk");
    expect(existsSync(join(offline, "TASK_CHANGE.md"))).toBe(false);
  });

  test("a task may name one of the workspace's repository folders, nothing else", async () => {
    expect(createTask({ workspaceId: repoWorkspace, title: "Named folder", repoPath: local }).repoPath).toBe(local);
    expect((await catchHttp(() => createTask({ workspaceId: repoWorkspace, title: "x", repoPath: tempRoot() }))).status).toBe(400);
    const plain = tempRoot();
    const ws = createWorkspace({ name: "Plain folder", sources: [{ kind: "folder", path: plain }] }).id;
    expect((await catchHttp(() => createTask({ workspaceId: ws, title: "x", repoPath: plain }))).message).toContain("isn't a git repository");
    // Without a repository, a task works as before: no worktree.
    const task = createTask({ workspaceId: ws, title: "Say hello from a plain folder", agentId: agent.id });
    await settled(task.id, ["in_review"]);
    expect(getTask(task.id).worktree).toBeNull();
  });
});

describe("races and safety", () => {
  let remote = "";
  let url = "";
  beforeAll(() => {
    ({ url, bare: remote } = makeRemote("safety"));
    updateWorkspace(workspaceId, { sources: [{ kind: "git", url }] });
  });

  test("a restart asked for while the repository is being cloned isn't lost", async () => {
    const task = createTask({ workspaceId, title: "TASK_EDIT restart while cloning", type: "coding", agentId: wsAgent.id });
    expect(getTask(task.id).activity).toBe("Cloning the repository…");
    updateTask(task.id, { status: "backlog" });
    updateTask(task.id, { status: "todo" });
    await settled(task.id, ["in_review"]);
    expect(getTask(task.id).runStatus).toBe("succeeded");
  });

  test("reassigning a task whose run is still queued hands it to the new agent", async () => {
    updateSettings({ runner: { maxConcurrentRuns: 1 } });
    try {
      const hog = createTask({ workspaceId, title: "SLEEP hogging the only slot", agentId: wsAgent.id });
      await until(() => getTask(hog.id).runStatus === "running", 10_000, "hog to run");
      const task = createTask({ workspaceId, title: "Waiting in line", agentId: wsAgent.id });
      await until(() => getTask(task.id).runStatus === "queued", 10_000, "queued run");
      const first = getTask(task.id).conversationId;
      updateTask(task.id, { agentId: agent.id });
      await until(() => getTask(task.id).conversationId !== first && getTask(task.id).runStatus === "queued", 10_000, "run for the new agent");
      expect(getTask(task.id).status).toBe("in_progress");
      updateTask(hog.id, { status: "backlog" });
      await settled(task.id, ["in_review"]);
      expect(get<{ agent_id: string }>("SELECT agent_id FROM conversations WHERE id = ?", getTask(task.id).conversationId!)?.agent_id).toBe(agent.id);
    } finally {
      updateSettings({ runner: { maxConcurrentRuns: 3 } });
    }
  });

  test("commits someone else pushed to the branch are merged in, never overwritten", async () => {
    const task = createTask({ workspaceId, title: "TASK_EDIT shared branch", type: "coding", agentId: wsAgent.id });
    await settled(task.id, ["in_review"]);
    const branch = getTask(task.id).branch!;
    const other = mkdtempSync(join(env.dataDir, "reviewer-"));
    await git(["clone", "-q", "--branch", branch, url, other], env.dataDir);
    writeFileSync(join(other, "REVIEW.md"), "reviewer fix\n");
    await git(["add", "-A"], other);
    await git(["-c", "user.name=Reviewer", "-c", "user.email=r@example.com", "commit", "-qm", "Reviewer fix"], other);
    await git(["push", "-q", "origin", branch], other);

    await sendTaskMessage(task.id, "TASK_EDIT address the review");
    await until(() => getTask(task.id).status === "in_progress", 5_000, "follow-up");
    await settled(task.id, ["in_review"]);
    const log = await git(["log", "--format=%s", branch], remote);
    expect(log).toContain("Reviewer fix");
    expect(log.split("\n")[0]).toMatch(/shared branch|Merge/);
    expect(await git(["show", `${branch}:REVIEW.md`], remote)).toBe("reviewer fix");
  });

  test("new env files are left out of the commit", async () => {
    const task = createTask({ workspaceId, title: "TASK_ENV add a feature", type: "coding", agentId: wsAgent.id });
    await settled(task.id, ["in_review"]);
    const files = await git(["ls-tree", "-r", "--name-only", getTask(task.id).branch!], remote);
    expect(files).toContain("feature.txt");
    expect(files).not.toContain(".env");
  });

  test("a secret-looking file the agent committed itself blocks the push", async () => {
    const task = createTask({ workspaceId, title: "TASK_COMMIT_ENV configure production", type: "coding", agentId: wsAgent.id });
    await settled(task.id, ["blocked"]);
    const t = getTask(task.id);
    expect(t.blockedReason).toContain(".env.production");
    expect(await git(["branch", "--list", t.branch!], remote)).toBe("");
  });

  test("changes containing a vault secret are not pushed", async () => {
    const secret = "Zq9-vault-Secret-4242";
    rememberSecret(secret);
    const task = createTask({ workspaceId, title: "Configure it", description: `TASK_LEAK:${secret}`, type: "coding", agentId: wsAgent.id });
    await settled(task.id, ["blocked"]);
    const t = getTask(task.id);
    expect(t.blockedReason).toContain("secret saved in the vault");
    expect(await git(["branch", "--list", t.branch!], remote)).toBe("");
  });

  test("task numbers are never reused", async () => {
    const a = createTask({ workspaceId, title: "Short-lived" });
    await deleteTask(a.id);
    expect(createTask({ workspaceId, title: "Next" }).number).toBe(a.number + 1);
  });
});

describe("pull requests", () => {
  const fakeGh = () => {
    const path = join(env.dataDir, "fake-gh.sh");
    writeFileSync(
      path,
      `#!/bin/sh
echo "$@" >> "${join(env.dataDir, "gh-calls.log")}"
if [ "$1 $2" = "pr view" ]; then
  if [ -n "$FAKE_GH_STATE" ]; then echo "{\\"url\\":\\"https://github.com/acme/app/pull/7\\",\\"number\\":7,\\"state\\":\\"$FAKE_GH_STATE\\"}"; exit 0; fi
  echo "no pull requests found" >&2; exit 1
fi
if [ "$1 $2" = "pr create" ]; then
  if [ -n "$FAKE_GH_CREATE_FAIL" ]; then echo "GraphQL: Resource not accessible by integration" >&2; exit 1; fi
  echo "Creating pull request"; echo "https://github.com/acme/app/pull/7"; exit 0
fi
exit 1
`,
    );
    chmodSync(path, 0o755);
    return path;
  };

  test("gh opens the pull request; other hosts get a compare link", async () => {
    __setGhForTests(fakeGh());
    try {
      const opened = await openPullRequest({ dir: env.dataDir, url: "git@github.com:acme/app.git", base: "main", branch: "godmode/1-x", title: "X", body: "Body" });
      expect(opened).toEqual({ pullRequest: { url: "https://github.com/acme/app/pull/7", number: 7, state: "open" }, problem: null });
      const gitlab = await openPullRequest({ dir: env.dataDir, url: "https://gitlab.com/acme/app.git", base: "main", branch: "b", title: "X", body: "" });
      expect(gitlab.pullRequest?.url).toStartWith("https://gitlab.com/acme/app/-/merge_requests/new?");
      expect(gitlab.pullRequest?.number).toBeNull();
    } finally {
      __setGhForTests(null);
    }
    // A closed pull request of the branch isn't taken for a new one when gh can't open it.
    __setGhForTests(fakeGh());
    process.env.FAKE_GH_STATE = "CLOSED";
    process.env.FAKE_GH_CREATE_FAIL = "1";
    try {
      const failed = await openPullRequest({ dir: env.dataDir, url: "https://github.com/acme/app", base: "main", branch: "godmode/1-x", title: "X", body: "" });
      expect(failed.pullRequest).toEqual({ url: "https://github.com/acme/app/compare/main...godmode%2F1-x?expand=1", number: null, state: null });
      expect(failed.problem).toContain("Resource not accessible");
    } finally {
      delete process.env.FAKE_GH_STATE;
      delete process.env.FAKE_GH_CREATE_FAIL;
      __setGhForTests(null);
    }
    const noGh = await openPullRequest({ dir: env.dataDir, url: "https://github.com/acme/app", base: "main", branch: "godmode/1-x", title: "X", body: "" });
    expect(noGh.pullRequest).toEqual({ url: "https://github.com/acme/app/compare/main...godmode%2F1-x?expand=1", number: null, state: null });
    expect(noGh.problem).toContain("GitHub CLI");
  });

  test("a merged pull request moves its task to Done", async () => {
    const task = createTask({ workspaceId, title: "Merged elsewhere", status: "backlog" });
    sql("UPDATE tasks SET status = 'in_review', pr_url = ?, pr_number = 7, pr_state = 'open' WHERE id = ?", "https://github.com/acme/app/pull/7", task.id);
    __setGhForTests(fakeGh());
    process.env.FAKE_GH_STATE = "MERGED";
    try {
      await checkPullRequests();
    } finally {
      delete process.env.FAKE_GH_STATE;
      __setGhForTests(null);
    }
    const t = getTask(task.id);
    expect(t.status).toBe("done");
    expect(t.pullRequest?.state).toBe("merged");
    expect(t.completedAt).not.toBeNull();
  });

  test("the board pushes a task's branch and opens its pull request", async () => {
    const { url, bare } = makeRemote("board-push");
    const task = createTask({ title: "TASK_EDIT share from the board", repoUrl: url, agentId: agent.id });
    await settled(task.id, ["in_review"]);
    const t = getTask(task.id);
    expect(t.branchPushed).toBe(false);
    expect(await git(["branch", "--list", t.branch!], bare)).toBe("");

    const pushed = await pushTaskBranch(t.id, { pullRequest: false });
    expect(pushed.branchPushed).toBe(true);
    expect(pushed.activity).toBeNull();
    expect(await git(["log", "-1", "--format=%s", t.branch!], bare)).toBe(`${t.title} (#${t.number})`);
    expect((await catchHttp(() => pushTaskBranch(t.id, { pullRequest: true }))).message).toContain("GitHub repositories only");

    // On GitHub, gh opens it (the push still goes to the task's origin), and a blocked task goes to review.
    sql("UPDATE tasks SET repo_url = ?, status = 'blocked', blocked_reason = 'Push failed' WHERE id = ?", "https://github.com/acme/app.git", t.id);
    __setGhForTests(fakeGh());
    try {
      const opened = await pushTaskBranch(t.id, { pullRequest: true });
      expect(opened.pullRequest).toEqual({ url: "https://github.com/acme/app/pull/7", number: 7, state: "open" });
      expect(opened.status).toBe("in_review");
      expect(opened.blockedReason).toBeNull();
    } finally {
      __setGhForTests(null);
    }
    expect(readFileSync(join(env.dataDir, "gh-calls.log"), "utf8")).toContain(`--head ${t.branch}`);

    // Once pushed, follow-ups keep the branch (and its pull request) up to date.
    await sendTaskMessage(t.id, "TASK_EDIT once more");
    await until(() => getTask(t.id).runId !== t.runId, 5_000, "follow-up run");
    await settled(t.id, ["in_review"]);
    expect(await git(["rev-list", "--count", `main..${t.branch}`], bare)).toBe("2");

    sql("UPDATE tasks SET status = 'in_progress' WHERE id = ?", t.id);
    expect((await catchHttp(() => pushTaskBranch(t.id, { pullRequest: false }))).message).toContain("in progress");
    sql("UPDATE tasks SET status = 'in_review' WHERE id = ?", t.id);
  });

  test("pushing from the board needs a branch with changes", async () => {
    const unstarted = createTask({ title: "Not started yet", status: "backlog" });
    expect((await catchHttp(() => pushTaskBranch(unstarted.id, { pullRequest: true }))).message).toContain("no branch yet");
    const { url } = makeRemote("board-nothing");
    const task = createTask({ title: "Say hello without changes", repoUrl: url, agentId: agent.id });
    await settled(task.id, ["in_review"]);
    const err = await catchHttp(() => pushTaskBranch(task.id, { pullRequest: false }));
    expect(err.status).toBe(409);
    expect(err.message).toContain("no changes");
    expect(getTask(task.id).branchPushed).toBe(false);
  });

  test("url helpers", () => {
    expect(hostedRepo("https://github.com/acme/app.git")).toEqual({ host: "github", path: "acme/app" });
    expect(hostedRepo("git@github.com:acme/app.git")).toEqual({ host: "github", path: "acme/app" });
    expect(hostedRepo("https://git.example.com/acme/app.git")).toBeNull();
    expect(compareUrl("https://example.com/x.git", "main", "b")).toBeNull();
    expect(githubBranchUrl("git@github.com:acme/app.git", "godmode/6-make-it-yellow")).toBe("https://github.com/acme/app/tree/godmode/6-make-it-yellow");
    expect(githubBranchUrl("https://gitlab.com/acme/app.git", "main")).toBeNull();
  });
});

describe("workspaces", () => {
  test("deleting a workspace with tasks needs force", async () => {
    const err = await catchHttp(() => deleteWorkspace(otherWorkspaceId));
    expect(err.status).toBe(409);
    expect(err.message).toContain("task");
    await deleteWorkspace(otherWorkspaceId, true);
    expect(listTasks({ workspaceId: otherWorkspaceId })).toEqual([]);
  });
});

describe("attachments", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  async function upload(name: string, type: string, bytes: Uint8Array<ArrayBuffer>) {
    const { createApp } = await import("../src/server/app");
    const { getAccessToken } = await import("../src/server/auth");
    const form = new FormData();
    form.set("file", new File([bytes], name, { type }));
    const res = await createApp().request("http://127.0.0.1/api/tasks/attachments", {
      method: "POST",
      headers: { authorization: `Bearer ${getAccessToken()}` },
      body: form,
    });
    return { status: res.status, data: (await res.json()) as import("@godmode/shared").TaskAttachment };
  }

  test("uploads are served back (images inline, other files as downloads) and need a login", async () => {
    const { createApp } = await import("../src/server/app");
    const { getAccessToken } = await import("../src/server/auth");
    const app = createApp();
    const img = await upload("shot (1).png", "image/png", png);
    expect(img.status).toBe(200);
    expect(img.data.url).toBe(`/api/tasks/attachments/${img.data.id}/shot%20%281%29.png`);

    expect((await app.request(`http://127.0.0.1${img.data.url}`)).status).toBe(401);
    const res = await app.request(`http://127.0.0.1${img.data.url}`, { headers: { authorization: `Bearer ${getAccessToken()}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toStartWith("inline");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);

    const page = await upload("evil.html", "text/html", new TextEncoder().encode("<script>alert(1)</script>"));
    const html = await app.request(`http://127.0.0.1${page.data.url}`, { headers: { authorization: `Bearer ${getAccessToken()}` } });
    expect(html.headers.get("content-type")).toBe("application/octet-stream");
    expect(html.headers.get("content-disposition")).toStartWith("attachment");
    expect(html.headers.get("content-security-policy")).toContain("sandbox");
  });

  test("the agent gets a copy of every linked file and is told to read them", async () => {
    const { taskAttachmentMarkdown } = await import("@godmode/shared");
    const img = (await upload("screenshot.png", "image/png", png)).data;
    const pdf = (await upload("spec sheet.pdf", "application/pdf", new TextEncoder().encode("%PDF-1.4 fake"))).data;
    const description = `The button is broken:\n\n${taskAttachmentMarkdown(img)}\n\nSee ${taskAttachmentMarkdown(pdf)} and ${taskAttachmentMarkdown(img)}.`;
    const task = createTask({ title: "Fix the button from the screenshot", description, agentId: agent.id });
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM task_attachments WHERE task_id = ?", task.id)?.n).toBe(2);

    await settled(task.id, ["in_review"]);
    const run = invocations(env).find((i) => i.prompt.includes("# Fix the button from the screenshot"))!;
    const dir = join(agent.repoPath, "workspace", "uploads", `task-${task.number}`);
    expect(run.prompt).toContain("Open every one with the Read tool");
    expect(run.prompt).toContain(`![screenshot.png](${join(dir, "screenshot.png")})`);
    expect(run.prompt).toContain(`[spec sheet.pdf](<${join(dir, "spec sheet.pdf")}>)`);
    expect(run.prompt).not.toContain("/api/tasks/attachments/");
    expect(readFileSync(join(dir, "screenshot.png"))).toEqual(Buffer.from(png));
    expect(readFileSync(join(dir, "spec sheet.pdf"), "utf8")).toBe("%PDF-1.4 fake");

    // The conversation shows the files attached to the message, and their names in the text.
    const message = get<{ content: string; attachments: string }>(
      "SELECT content, attachments FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at LIMIT 1",
      getTask(task.id).conversationId!,
    )!;
    expect(message.content).toContain("📎 screenshot.png");
    expect(message.content).toContain("See 📎 spec sheet.pdf and 📎 screenshot.png.");
    expect(message.content).not.toContain("/api/tasks/attachments/");
    expect(JSON.parse(message.attachments).map((a: { name: string }) => a.name)).toEqual(["screenshot.png", "spec sheet.pdf"]);
  });

  test("a deleted task takes its files along; unclaimed uploads are swept after a day", async () => {
    const { sweepTaskAttachments } = await import("../src/tasks/attachments");
    const { taskAttachmentMarkdown } = await import("@godmode/shared");
    const kept = (await upload("kept.png", "image/png", png)).data;
    const stray = (await upload("stray.png", "image/png", png)).data;
    const fresh = (await upload("fresh.png", "image/png", png)).data;
    const task = createTask({ title: "Has a file", description: taskAttachmentMarkdown(kept), status: "backlog" });
    const fileOf = (id: string, name: string) => join(env.dataDir, "attachments", "tasks", id, name);
    expect(existsSync(fileOf(kept.id, "kept.png"))).toBe(true);

    sql("UPDATE task_attachments SET created_at = ? WHERE id = ?", new Date(Date.now() - 2 * 86_400_000).toISOString(), stray.id);
    sweepTaskAttachments();
    expect(existsSync(fileOf(stray.id, "stray.png"))).toBe(false);
    expect(existsSync(fileOf(fresh.id, "fresh.png"))).toBe(true);
    expect(existsSync(fileOf(kept.id, "kept.png"))).toBe(true);

    // A copy of the description in another task keeps the file alive.
    const copy = createTask({ title: "Copied description", description: taskAttachmentMarkdown(kept), status: "backlog" });
    await deleteTask(task.id);
    expect(existsSync(fileOf(kept.id, "kept.png"))).toBe(true);
    expect(get<{ task_id: string }>("SELECT task_id FROM task_attachments WHERE id = ?", kept.id)?.task_id).toBe(copy.id);

    await deleteTask(copy.id);
    expect(existsSync(fileOf(kept.id, "kept.png"))).toBe(false);
    expect(get("SELECT id FROM task_attachments WHERE id = ?", kept.id)).toBeNull();
  });

  test("screenshots the agent names in its result are kept with the task and shown", async () => {
    const { readTaskAttachment } = await import("../src/tasks/attachments");
    const dir = mkdtempSync(join(tmpdir(), "godmode-shots-"));
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    writeFileSync(join(dir, "light.png"), png);
    writeFileSync(join(dir, "dark mode.png"), jpeg);
    writeFileSync(join(dir, "notes.txt"), "notes");
    writeFileSync(join(dir, "fake.png"), "not a picture");
    const task = createTask({ title: `Make the header yellow TASK_SHOTS:${dir}`, agentId: agent.id });
    await settled(task.id, ["in_review"]);

    const pictures = () => all<{ id: string; name: string; mime: string }>("SELECT id, name, mime FROM task_attachments WHERE task_id = ? ORDER BY name", task.id);
    const [dark, light] = pictures();
    expect(pictures().map((p) => [p.name, p.mime])).toEqual([
      ["dark mode.png", "image/jpeg"],
      ["light.png", "image/png"],
    ]);
    const url = (p: { id: string; name: string }) => taskAttachmentUrl(p.id, p.name);
    const summary = getTask(task.id).summary!;
    expect(summary).toContain(`- ![light.png](${url(light!)})`);
    expect(summary).toContain(`- ![Dark mode](${url(dark!)})`);
    expect(summary).toContain(`- Again: ![light.png](${url(light!)}).`);
    expect(summary).toContain(`- ![The same](${url(light!)})`);
    expect(summary).toContain(`- Not shown: \`${dir}/notes.txt\`, \`${dir}/missing.png\`, \`${dir}/fake.png\`, [online](https://example.com/shot.png)`);
    expect(summary).toContain(`\`\`\`sh\nopen ${dir}/light.png\n\`\`\``);
    expect(readTaskAttachment(light!.id).data).toEqual(Buffer.from(png));

    // A new result brings its own copies; the earlier ones go.
    rmSync(join(dir, "dark mode.png"));
    await sendTaskMessage(task.id, `TASK_SHOTS:${dir}`);
    await until(() => !getTask(task.id).summary!.includes(light!.id), 10_000, "the new result");
    await settled(task.id, ["in_review"]);
    expect(pictures().map((p) => p.name)).toEqual(["light.png"]);
    expect(getTask(task.id).summary).toContain(`- ![light.png](${url(pictures()[0]!)})`);
    expect(getTask(task.id).summary).toContain(`- ![Dark mode](<${dir}/dark mode.png>)`);
    expect(existsSync(join(env.dataDir, "attachments", "tasks", light!.id))).toBe(false);

    // A picture the human copied into the description outlives the result it came from.
    const kept = pictures()[0]!;
    updateTask(task.id, { description: `Like this: ![light](${url(kept)})` });
    await sendTaskMessage(task.id, "Thanks");
    await until(() => !getTask(task.id).summary!.includes(kept.id), 10_000, "a result without pictures");
    await settled(task.id, ["in_review"]);
    expect(readTaskAttachment(kept.id).data).toEqual(Buffer.from(png));

    await deleteTask(task.id);
    expect(get("SELECT id FROM task_attachments WHERE task_id = ?", task.id)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("only pictures in the agent's folders are taken, and the Markdown around them stays intact", async () => {
    const { symlinkSync } = await import("node:fs");
    const { withResultImages } = await import("../src/tasks/attachments");
    const inside = mkdtempSync(join(tmpdir(), "godmode-inside-"));
    const outside = mkdtempSync(join(tmpdir(), "godmode-outside-"));
    writeFileSync(join(inside, "a.png"), png);
    writeFileSync(join(outside, "b.png"), png);
    symlinkSync(join(outside, "b.png"), join(inside, "link.png"));
    const task = createTask({ title: "Pictures", status: "backlog" });
    const result = [
      `\`${outside}/b.png\` \`${inside}/link.png\` \`${inside}/../${outside.split("/").pop()}/b.png\``,
      "`\\\\host\\share\\c.png` //host/share/c.png",
      "```inline``` stays code",
      `![titled](${inside}/a.png 'A title') and [![shot](${inside}/a.png)](${inside}/a.png)`,
    ].join("\n");
    const out = withResultImages(task.id, result, [inside]);
    const [a] = all<{ id: string; name: string }>("SELECT id, name FROM task_attachments WHERE task_id = ?", task.id);
    const lines = out.split("\n");
    expect(lines.slice(0, 3)).toEqual(result.split("\n").slice(0, 3));
    expect(lines[3]).toBe(`![titled](${taskAttachmentUrl(a!.id, "a.png")}) and ![a.png](${taskAttachmentUrl(a!.id, "a.png")})`);
    await deleteTask(task.id);
    rmSync(inside, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test("follow-ups carry files like chat messages", async () => {
    const task = createTask({ title: "Reply with a file", agentId: agent.id });
    await settled(task.id, ["in_review"]);
    await sendTaskMessage(task.id, "", [{ name: "notes.txt", mime: "text/plain", data: Buffer.from("more details").toString("base64") }]);
    await settled(task.id, ["in_review"]);
    const run = invocations(env).filter((i) => i.prompt.includes("Attached files:")).at(-1)!;
    expect(run.prompt).toContain("notes.txt");
  });
});
