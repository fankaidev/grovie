export type Result<T> =
  | {
    ok: true;
    value: T;
  }
  | {
    ok: false;
    error: GitHubGatewayError;
  };

export type GitHubGatewayError = {
  code: "gh_failed" | "invalid_issue_reference" | "invalid_json";
  message: string;
  command?: string;
  exitCode?: number;
  stderr?: string;
};

export type CommandRunner = {
  run(command: string, args: string[], input?: string, options?: CommandRunOptions): CommandResult;
};

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CommandRunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
};

export type IssueReference = {
  owner: string;
  repo: string;
  number: number;
};

export type GitHubUser = {
  login: string;
};

export type GitHubLabel = {
  name: string;
};

export type GitHubComment = {
  id: number;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
};

export type GitHubPullRequestReview = {
  id: number;
  state: string;
  author: string;
  body: string;
  submittedAt: string;
};

export type GitHubCheckSummary = {
  totalCount: number;
  conclusionCounts: Record<string, number>;
};

export type GitHubRelatedPullRequest = {
  number: number;
  title: string;
  state: string;
  mergeStateStatus?: string;
  url: string;
  body: string;
  baseRef: string;
  headRef: string;
  headSha: string;
  updatedAt: string;
  comments: GitHubComment[];
  reviewComments: GitHubComment[];
  reviews: GitHubPullRequestReview[];
  checks: GitHubCheckSummary;
  diffSummary?: string;
};

export type GitHubRepositoryEvent = {
  id: string;
  type: string;
  createdAt: string;
  actor: string;
  action?: string;
  issueNumber?: number;
  issueUrl?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  commentUrl?: string;
  reviewUrl?: string;
};

export type GitHubRepositoryEventsResult =
  | {
    status: "modified";
    events: GitHubRepositoryEvent[];
    etag?: string;
    pollIntervalSeconds?: number;
  }
  | {
    status: "not-modified";
    etag?: string;
    pollIntervalSeconds?: number;
  };

export type GitHubPullRequestIssueLink = {
  pullRequestNumber: number;
  issueNumber: number;
  source: "closing-reference" | "body" | "branch";
};

export type GitHubIssue = {
  reference: IssueReference;
  title: string;
  body: string;
  author: string;
  state: string;
  updatedAt: string;
  labels: string[];
  comments: GitHubComment[];
  defaultBranch: string;
};

export type GitHubIssueSummary = {
  reference: IssueReference;
  title: string;
  labels: string[];
};

export type CreatedComment = {
  id: number;
  nodeId?: string;
  body: string;
  url: string;
  createdAt?: string;
};

export type CreatedPullRequest = {
  number: number;
  url: string;
};

export type CreatedRepository = {
  repository: string;
  private: boolean;
  url: string;
};

export type CreatePullRequestInput = {
  repository: string;
  title: string;
  body: string;
  head: string;
  base: string;
  draft: boolean;
};

export type GitHubGateway = {
  getAuthenticatedUser(): Result<GitHubUser>;
  listOpenIssues(repository: string, label: string): Result<GitHubIssueSummary[]>;
  readIssue(reference: IssueReference): Result<GitHubIssue>;
  addLabels(reference: IssueReference, labels: string[]): Result<void>;
  removeLabel(reference: IssueReference, label: string): Result<void>;
  createIssueComment(reference: IssueReference, body: string): Result<CreatedComment>;
  updateIssueComment(repository: string, commentId: number, body: string): Result<CreatedComment>;
  minimizeComment?(commentNodeId: string, classifier?: "OUTDATED" | "RESOLVED"): Result<void>;
  createPullRequest(input: CreatePullRequestInput): Result<CreatedPullRequest>;
  readRelatedPullRequests?(reference: IssueReference): Result<GitHubRelatedPullRequest[]>;
  listRepositoryEvents?(repository: string, options?: { ifNoneMatch?: string }): Result<GitHubRepositoryEventsResult>;
  readPullRequestIssueLinks?(repository: string, pullRequestNumber: number): Result<GitHubPullRequestIssueLink[]>;
  listRepositoryOwners?(): Result<string[]>;
  readRepository?(repository: string): Result<CreatedRepository>;
  createRepository?(input: { repository: string; private: boolean }): Result<CreatedRepository>;
};
