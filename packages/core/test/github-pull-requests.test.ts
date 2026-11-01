import { afterEach, describe, expect, test } from "bun:test";
import { parsePullRequestUrl } from "@godmode/shared";
import { __setGithubForTests, checksOf, getPullRequest, mergePullRequest, reviewsOf, setAutoMerge } from "../src/github/pullRequests";
import { HttpError } from "../src/util";

const ref = { owner: "acme", repo: "app", number: 7 };

interface Call {
  url: string;
  headers: Record<string, string>;
}

function pull(state: "open" | "closed" = "open", merged = false) {
  return {
    html_url: "https://github.com/acme/app/pull/7",
    title: "Make it fast",
    state,
    merged,
    merged_at: merged ? "2026-10-30T10:00:00Z" : null,
    draft: false,
    user: { login: "ana", avatar_url: "https://avatars/ana" },
    body: "Speeds things up",
    base: { ref: "main" },
    head: { ref: "fast", label: "ana:fast", sha: "abc123" },
    created_at: "2026-10-29T10:00:00Z",
    updated_at: "2026-10-30T10:00:00Z",
    additions: 10,
    deletions: 2,
    changed_files: 1,
    commits: 3,
    comments: 1,
    review_comments: 2,
    mergeable_state: "dirty",
    labels: [{ name: "perf", color: "00ff00" }],
  };
}

function answers(clock: { now: number }, route: (url: string, headers: Record<string, string>) => Response) {
  const calls: Call[] = [];
  __setGithubForTests({
    now: () => clock.now,
    token: async () => "ghp_testtokentesttokentesttoken",
    fetch: async (url, init) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ url, headers });
      return route(url, headers);
    },
  });
  return calls;
}

function json(body: unknown, headers: Record<string, string> = {}, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function ok(url: string, extra: Record<string, string> = {}) {
  const headers = { etag: `"${url.length}"`, "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4000", "x-ratelimit-reset": "9999999999", "x-ratelimit-resource": "core", ...extra };
  if (url.endsWith("/pulls/7")) return json(pull(), headers);
  if (url.includes("/check-runs")) return json({ check_runs: [{ name: "ci", status: "completed", conclusion: "failure", html_url: "https://ci" }] }, headers);
  if (url.includes("/status")) return json({ statuses: [{ context: "deploy", state: "pending" }] }, headers);
  if (url.includes("/reviews")) return json([{ user: { login: "bo" }, state: "APPROVED" }], headers);
  if (url.endsWith("/repos/acme/app")) return json({ allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: true, permissions: { push: true } }, headers);
  if (url.includes("/files")) return json([{ filename: "src/a.ts", status: "modified", additions: 10, deletions: 2 }], headers);
  return json({}, headers, 404);
}

afterEach(() => __setGithubForTests(null));

describe("parsePullRequestUrl", () => {
  test("reads pull request links, also their tabs", () => {
    expect(parsePullRequestUrl("https://github.com/pingdotgg/t3code/pull/42")).toEqual({ owner: "pingdotgg", repo: "t3code", number: 42 });
    expect(parsePullRequestUrl("https://github.com/a/b/pull/3/files#diff-1")).toEqual({ owner: "a", repo: "b", number: 3 });
    expect(parsePullRequestUrl("https://github.com/a/b.js/pull/3/")).toEqual({ owner: "a", repo: "b.js", number: 3 });
  });

  test("leaves other links alone", () => {
    expect(parsePullRequestUrl("https://github.com/a/b/issues/3")).toBeNull();
    expect(parsePullRequestUrl("https://github.com/a/b")).toBeNull();
    expect(parsePullRequestUrl("https://gitlab.com/a/b/pull/3")).toBeNull();
    expect(parsePullRequestUrl("https://github.com.evil.dev/a/b/pull/3")).toBeNull();
  });
});

describe("getPullRequest", () => {
  test("builds a concise view from the pull request, its checks and reviews", async () => {
    const clock = { now: 1_000_000 };
    const calls = answers(clock, (url) => ok(url));
    const view = await getPullRequest(ref);
    expect(view.title).toBe("Make it fast");
    expect(view.state).toBe("open");
    expect(view.mergeable).toBe("conflicting");
    expect(view.comments).toBe(3);
    expect(view.headBranch).toBe("ana:fast");
    expect(view.checks).toEqual([
      { name: "ci", state: "failure", url: "https://ci" },
      { name: "deploy", state: "pending", url: null },
    ]);
    expect(view.reviews).toEqual([{ author: "bo", avatarUrl: null, state: "approved" }]);
    expect(view.files).toHaveLength(1);
    expect(view.stale).toBe(false);
    expect(view.signedIn).toBe(true);
    expect(view.mergeMethods).toEqual(["squash", "rebase"]);
    expect(view.canMerge).toBe(true);
    expect(view.headSha).toBe("abc123");
    expect(calls).toHaveLength(6);
    expect(calls[0]!.headers.authorization).toBe("Bearer ghp_testtokentesttokentesttoken");
  });

  test("answers from its cache inside the freshness window and revalidates with ETags after it", async () => {
    const clock = { now: 1_000_000 };
    let revalidated = 0;
    const calls = answers(clock, (url, headers) => {
      if (headers["if-none-match"]) {
        revalidated++;
        return new Response(null, { status: 304, headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4000", "x-ratelimit-reset": "9999999999" } });
      }
      return ok(url);
    });
    await getPullRequest(ref);
    await getPullRequest(ref);
    expect(calls).toHaveLength(6);
    clock.now += 61_000;
    const view = await getPullRequest(ref);
    expect(view.title).toBe("Make it fast");
    expect(revalidated).toBe(5);
  });

  test("shares one GitHub read between callers asking at the same time", async () => {
    const clock = { now: 1_000_000 };
    const calls = answers(clock, (url) => ok(url));
    await Promise.all([getPullRequest(ref), getPullRequest(ref), getPullRequest(ref)]);
    expect(calls).toHaveLength(6);
  });

  test("a rate limit pauses GitHub until it resets and serves what it has, marked stale", async () => {
    const clock = { now: 1_000_000 };
    let limited = false;
    const calls = answers(clock, (url) =>
      limited ? json({ message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((clock.now + 600_000) / 1000) }, 403) : ok(url),
    );
    await getPullRequest(ref);
    limited = true;
    clock.now += 61_000;
    const view = await getPullRequest(ref, { force: true });
    expect(view.stale).toBe(true);
    expect(view.title).toBe("Make it fast");
    expect(Date.parse(view.retryAt!)).toBe(1_061_000 + 600_000);
    const before = calls.length;
    await getPullRequest(ref, { force: true });
    expect(calls.length).toBe(before);
  });

  test("without anything cached a rate limit is an error that says when to retry", async () => {
    const clock = { now: 1_000_000 };
    answers(clock, () => json({ message: "slow down" }, { "retry-after": "120" }, 429));
    const err = (await getPullRequest(ref).catch((e) => e)) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(429);
    expect(err.code).toBe("github_rate_limited");
    expect((err.details as { retryAt: string }).retryAt).toBe(new Date(1_000_000 + 120_000).toISOString());
  });

  test("background refreshes leave the last tenth of the quota to what the human opens", async () => {
    const clock = { now: 1_000_000 };
    const calls = answers(clock, (url) => ok(url, { "x-ratelimit-remaining": "300" }));
    await getPullRequest(ref);
    clock.now += 61_000;
    const background = await getPullRequest(ref, { interactive: false });
    expect(background.stale).toBe(true);
    expect(calls).toHaveLength(6);
    const opened = await getPullRequest(ref, { interactive: true });
    expect(opened.stale).toBe(false);
  });

  test("a pull request GitHub can't find is a 404", async () => {
    const clock = { now: 1_000_000 };
    answers(clock, () => json({ message: "Not Found" }, {}, 404));
    const err = (await getPullRequest(ref).catch((e) => e)) as HttpError;
    expect(err.status).toBe(404);
    expect(err.code).toBe("github_not_found");
  });
});

describe("mergePullRequest", () => {
  const sha = "a".repeat(40);

  test("merges with the chosen method, pinned to the head it showed, and reloads", async () => {
    const clock = { now: 1_000_000 };
    let merged = false;
    const calls = answers(clock, (url) => {
      if (url.endsWith("/merge")) {
        merged = true;
        return json({ merged: true });
      }
      if (merged && url.endsWith("/pulls/7")) return json({ ...pull("closed", true) });
      return ok(url);
    });
    await getPullRequest(ref);
    const view = await mergePullRequest(ref, "squash", sha);
    const put = calls.find((c) => c.url.endsWith("/merge"))!;
    expect(put.headers["content-type"]).toBe("application/json");
    expect(view.state).toBe("merged");
    expect(view.canMerge).toBe(false);
  });

  test("GitHub's reason for refusing comes through", async () => {
    const clock = { now: 1_000_000 };
    answers(clock, (url) => (url.endsWith("/merge") ? json({ message: "Required status check \"ci\" is failing." }, {}, 405) : ok(url)));
    const err = (await mergePullRequest(ref, "squash", sha).catch((e) => e)) as HttpError;
    expect(err.status).toBe(409);
    expect(err.code).toBe("github_merge_refused");
    expect(err.message).toContain("ci");
  });

  test("never merges without a GitHub login", async () => {
    const clock = { now: 1_000_000 };
    const calls = answers(clock, (url) => ok(url));
    __setGithubForTests({ now: () => clock.now, token: async () => null, fetch: async (url) => (calls.push({ url, headers: {} }), ok(url)) });
    const err = (await mergePullRequest(ref, "merge", sha).catch((e) => e)) as HttpError;
    expect(err.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe("setAutoMerge", () => {
  test("enables auto-merge through GraphQL with the pull request's node id and shows it", async () => {
    const clock = { now: 1_000_000 };
    let enabled = false;
    const bodies: unknown[] = [];
    __setGithubForTests({
      now: () => clock.now,
      token: async () => "ghp_testtokentesttokentesttoken",
      fetch: async (url, init) => {
        if (url.endsWith("/graphql")) {
          bodies.push(JSON.parse(String(init.body)));
          enabled = true;
          return json({ data: { enablePullRequestAutoMerge: { clientMutationId: null } } });
        }
        if (url.endsWith("/pulls/7")) return json({ ...pull(), mergeable_state: "blocked", node_id: "PR_kw7", auto_merge: enabled ? { merge_method: "squash", enabled_by: { login: "ana" } } : null });
        if (url.endsWith("/repos/acme/app")) return json({ allow_squash_merge: true, allow_auto_merge: true, permissions: { push: true } });
        return ok(url);
      },
    });
    const before = await getPullRequest(ref);
    expect(before.autoMerge).toBeNull();
    expect(before.autoMergeAllowed).toBe(true);
    const view = await setAutoMerge(ref, "squash");
    expect(bodies[0]).toMatchObject({ variables: { id: "PR_kw7", method: "SQUASH" } });
    expect(view.autoMerge).toEqual({ method: "squash", enabledBy: "ana" });
  });

  test("GitHub's GraphQL error comes through as a refusal", async () => {
    const clock = { now: 1_000_000 };
    answers(clock, (url) =>
      url.endsWith("/graphql") ? json({ errors: [{ message: "Pull request is in clean status" }] }) : url.endsWith("/pulls/7") ? json({ ...pull(), node_id: "PR_kw7" }) : ok(url),
    );
    const err = (await setAutoMerge(ref, "merge").catch((e) => e)) as HttpError;
    expect(err.status).toBe(409);
    expect(err.code).toBe("github_merge_refused");
    expect(err.message).toContain("clean status");
  });
});

describe("summaries", () => {
  test("a reviewer's latest decision counts, a later comment doesn't undo it", () => {
    expect(
      reviewsOf([
        { user: { login: "a" }, state: "CHANGES_REQUESTED" },
        { user: { login: "a" }, state: "APPROVED" },
        { user: { login: "a" }, state: "COMMENTED" },
        { user: { login: "b" }, state: "COMMENTED" },
        { user: { login: "c" }, state: "APPROVED" },
        { user: { login: "c" }, state: "DISMISSED" },
      ]).map((r) => [r.author, r.state]),
    ).toEqual([
      ["a", "approved"],
      ["b", "commented"],
    ]);
  });

  test("a check that ran again shows its latest run", () => {
    expect(
      checksOf(
        {
          check_runs: [
            { name: "ci", status: "completed", conclusion: "failure", started_at: "2026-10-30T10:00:00Z" },
            { name: "ci", status: "in_progress", conclusion: null, started_at: "2026-10-30T11:00:00Z" },
            { name: "lint", status: "completed", conclusion: "skipped" },
          ],
        },
        null,
      ),
    ).toEqual([
      { name: "ci", state: "pending", url: null },
      { name: "lint", state: "neutral", url: null },
    ]);
  });
});
