export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

export type PullRequestViewState = "open" | "draft" | "merged" | "closed";

export type PullRequestCheckState = "success" | "failure" | "pending" | "neutral";

export interface PullRequestCheck {
  name: string;
  state: PullRequestCheckState;
  url: string | null;
}

export type PullRequestReviewState = "approved" | "changes_requested" | "commented";

export interface PullRequestReview {
  author: string;
  avatarUrl: string | null;
  state: PullRequestReviewState;
}

export interface PullRequestFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface PullRequestView {
  ref: PullRequestRef;
  url: string;
  title: string;
  state: PullRequestViewState;
  author: string;
  authorAvatarUrl: string | null;
  body: string;
  baseBranch: string;
  headBranch: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  comments: number;
  mergeable: "clean" | "conflicting" | "blocked" | "unknown";
  labels: { name: string; color: string }[];
  checks: PullRequestCheck[] | null;
  reviews: PullRequestReview[] | null;
  files: PullRequestFile[] | null;
  fetchedAt: string;
  stale: boolean;
  retryAt: string | null;
  signedIn: boolean;
}

export const GithubErrorCode = {
  RateLimited: "github_rate_limited",
  NotFound: "github_not_found",
  Unauthorized: "github_unauthorized",
  Unreachable: "github_unreachable",
} as const;

const PR_PATH = /^\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,9})(?:\/[^?#]*)?$/;

export function parsePullRequestUrl(input: string): PullRequestRef | null {
  const match = /^https?:\/\/(?:www\.)?github\.com(\/[^?#]*)(?:[?#].*)?$/i.exec(input.trim());
  if (!match) return null;
  const path = PR_PATH.exec(match[1]!.replace(/\/+$/, ""));
  if (!path) return null;
  const number = Number(path[3]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { owner: path[1]!, repo: path[2]!, number };
}

export function pullRequestUrl(ref: PullRequestRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}
