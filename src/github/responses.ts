import type { GitHubLabel } from "./types.js";

export type GitHubUserResponse = {
  login: string;
};

export type GitHubRepositoryResponse = {
  default_branch: string;
  full_name: string;
  private: boolean;
  html_url: string;
};

export type GitHubIssueResponse = {
  title: string;
  body: string | null;
  user: {
    login: string;
  } | null;
  state: string;
  updated_at: string;
  labels: GitHubLabel[];
};

export type GitHubIssueListItemResponse = {
  number: number;
  title: string;
  labels: GitHubLabel[];
  pull_request?: unknown;
};

export type GitHubCommentResponse = {
  id: number;
  body: string;
  user: {
    login: string;
  };
  created_at: string;
  updated_at: string;
};

export type GitHubCommentMutationResponse = {
  id: number;
  body: string;
  html_url: string;
  created_at?: string;
};

export type GitHubPullRequestResponse = {
  number: number;
  html_url: string;
};

export type GitHubPullRequestListItemResponse = {
  number: number;
  title: string;
  state: string;
  html_url: string;
  body: string | null;
  updated_at: string;
  base: {
    ref: string;
  };
  head: {
    ref: string;
    sha: string;
  };
};

export type GitHubPullRequestDetailsResponse = {
  mergeable_state?: string | null;
};

export type GitHubPullRequestReviewResponse = {
  id: number;
  state: string;
  body: string | null;
  user: {
    login: string;
  };
  submitted_at: string | null;
};

export type GitHubCheckRunResponse = {
  conclusion: string | null;
};

export type GitHubCheckRunsResponse = {
  total_count: number;
  check_runs: GitHubCheckRunResponse[];
};

export type GitHubRepositoryEventResponse = {
  id: string;
  type: string;
  created_at: string;
  actor?: {
    login?: string;
  };
  payload?: {
    action?: string;
    issue?: {
      number?: number;
      html_url?: string;
    };
    pull_request?: {
      number?: number;
      html_url?: string | null;
    };
    comment?: {
      html_url?: string;
    };
    review?: {
      html_url?: string;
    };
  };
};

export type GitHubPullRequestIssueLinksGraphqlResponse = {
  data?: {
    repository?: {
      pullRequest?: {
        body?: string | null;
        headRefName?: string | null;
        closingIssuesReferences?: {
          nodes?: Array<{
            number?: number;
          } | null>;
        };
      } | null;
    } | null;
  };
};
