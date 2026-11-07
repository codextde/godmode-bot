import * as SecureStore from "expo-secure-store";
import type { PullRequestMergeMethod, PullRequestView } from "@godmode/shared";
import { request } from "./api";

/** A GitHub pull request as the computer reads it (with its GitHub login), merged or set to merge by itself from here. */
export const prApi = {
  get: (url: string, opts: { background?: boolean; refresh?: boolean } = {}) =>
    request<PullRequestView>(
      "GET",
      `/api/github/pull?url=${encodeURIComponent(url)}${opts.background ? "&background=1" : ""}${opts.refresh ? "&refresh=1" : ""}`,
    ),
  merge: (input: { url: string; method: PullRequestMergeMethod; headSha: string }) => request<PullRequestView>("POST", "/api/github/pull/merge", input, 60_000),
  autoMerge: (input: { url: string; method: PullRequestMergeMethod | null }) => request<PullRequestView>("POST", "/api/github/pull/auto-merge", input, 60_000),
};

export const prKey = (url: string) => ["github", "pull", url];

const METHOD_KEY = "godmode.mergeMethod";
let savedMethod: PullRequestMergeMethod | null = null;
void SecureStore.getItemAsync(METHOD_KEY)
  .catch(() => null)
  .then((v) => {
    if (v === "merge" || v === "squash" || v === "rebase") savedMethod = v;
  });

/** The way this phone merged last, when the repository allows it; else the repository's first. */
export function preferredMethod(methods: PullRequestMergeMethod[]): PullRequestMergeMethod | null {
  return savedMethod && methods.includes(savedMethod) ? savedMethod : (methods[0] ?? null);
}

export function rememberMethod(method: PullRequestMergeMethod) {
  savedMethod = method;
  void SecureStore.setItemAsync(METHOD_KEY, method).catch(() => undefined);
}

/** Open pull requests change often (checks, reviews); merged and closed ones rarely. */
export function refreshEvery(pr: PullRequestView | undefined): number | false {
  if (!pr) return false;
  const wait = pr.state === "open" || pr.state === "draft" ? 60_000 : 10 * 60_000;
  const retryIn = pr.retryAt ? Date.parse(pr.retryAt) - Date.now() : 0;
  return Math.max(wait, retryIn);
}
