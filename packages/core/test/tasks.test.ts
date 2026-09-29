import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, Task } from "@godmode/shared";
import { makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { get, run as sql } from "../src/db";
import { getRun, activeRunForConversation } from "../src/runner/runner";
import { createWorkspace, deleteWorkspace, updateWorkspace } from "../src/services/workspaces";
import { workingDirectoryProblem } from "../src/services/folders";
import {
  checkPullRequests,
  checkoutDir,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  sendTaskMessage,
  startTasks,
  stopTasks,
  updateTask,
} from "../src/tasks/service";
import { __setGhForTests, compareUrl, hostedRepo, openPullRequest, validBranchName, validRepoUrl } from "../src/tasks/git";
import { HttpError } from "../src/util";

let env: TestEnv;
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

async function makeRemote(name: string): Promise<string> {
  const bare = join(env.dataDir, "remotes", `${name}.git`);
  const seed = join(env.dataDir, "remotes", `${name}-seed`);
  mkdirSync(seed, { recursive: true });
  await git(["init", "--bare", "--initial-branch=main", bare], env.dataDir);
  await git(["init", "--initial-branch=main"], seed);
  writeFileSync(join(seed, "README.md"), "# demo\n");
  await git(["add", "-A"], seed);
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], seed);
  await git(["remote", "add", "origin", bare], seed);
  await git(["push", "origin", "main"], seed);
  return bare;
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

describe("coding tasks", () => {
  test("need a repository", async () => {
    const task = createTask({ title: "TASK_EDIT something", type: "coding", agentId: agent.id });
    await settled(task.id, ["blocked"]);
    expect(getTask(task.id).blockedReason).toContain("git repository");
  });

  test("clone onto a branch, commit and push the agent's work, update it after follow-ups", async () => {
    const remote = await makeRemote("app");
    updateWorkspace(workspaceId, { repoUrl: remote });
    const task = createTask({ workspaceId, title: "TASK_EDIT add a change file", type: "coding", agentId: wsAgent.id });
    await settled(task.id, ["in_review"]);
    const t = getTask(task.id);
    expect(t.repoUrl).toBe(remote);
    expect(t.baseBranch).toBe("main");
    expect(t.branch).toBe(`godmode/${t.number}-task-edit-add-a-change-file`);
    expect(t.pullRequest).toBeNull();
    const dir = checkoutDir(t.id);
    expect(get<{ working_directory: string }>("SELECT working_directory FROM conversations WHERE id = ?", t.conversationId!)?.working_directory).toBe(dir);
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
if [ "$1 $2" = "pr create" ]; then echo "Creating pull request"; echo "https://github.com/acme/app/pull/7"; exit 0; fi
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

  test("url helpers", () => {
    expect(hostedRepo("https://github.com/acme/app.git")).toEqual({ host: "github", path: "acme/app" });
    expect(hostedRepo("git@github.com:acme/app.git")).toEqual({ host: "github", path: "acme/app" });
    expect(hostedRepo("https://git.example.com/acme/app.git")).toBeNull();
    expect(compareUrl("https://example.com/x.git", "main", "b")).toBeNull();
    expect(validRepoUrl("https://github.com/acme/app")).toBe(true);
    expect(validRepoUrl("git@github.com:acme/app.git")).toBe(true);
    expect(validRepoUrl("--upload-pack=evil")).toBe(false);
    expect(validRepoUrl("acme/app")).toBe(false);
    expect(validBranchName("feature/x-1")).toBe(true);
    expect(validBranchName("-x")).toBe(false);
  });
});

describe("workspaces", () => {
  test("repository settings are validated and deleting a workspace with tasks needs force", async () => {
    expect((await catchHttp(() => updateWorkspace(otherWorkspaceId, { repoUrl: "nope nope" }))).status).toBe(400);
    const ws = updateWorkspace(otherWorkspaceId, { repoUrl: "https://github.com/acme/app.git", repoBranch: "develop" });
    expect(ws.repoUrl).toBe("https://github.com/acme/app.git");
    expect(ws.repoBranch).toBe("develop");
    const err = await catchHttp(() => deleteWorkspace(otherWorkspaceId));
    expect(err.status).toBe(409);
    expect(err.message).toContain("task");
    await deleteWorkspace(otherWorkspaceId, true);
    expect(listTasks({ workspaceId: otherWorkspaceId })).toEqual([]);
  });
});
