import { parsePullRequestIssueLinks } from "./mappers.js";
import { parseRepositoryName } from "./parsing.js";
import type { GitHubPullRequestIssueLinksGraphqlResponse } from "./responses.js";
import type { CommandRunner, GitHubPullRequestIssueLink, Result } from "./types.js";

export function readPullRequestIssueLinks(input: {
  runner: CommandRunner;
  repository: string;
  pullRequestNumber: number;
}): Result<GitHubPullRequestIssueLink[]> {
  const parsedRepository = parseRepositoryName(input.repository);

  if (!parsedRepository.ok) {
    return parsedRepository;
  }

  const query = [
    "query($owner: String!, $name: String!, $number: Int!) {",
    "  repository(owner: $owner, name: $name) {",
    "    pullRequest(number: $number) {",
    "      body",
    "      headRefName",
    "      closingIssuesReferences(first: 20) { nodes { number } }",
    "    }",
    "  }",
    "}",
  ].join("\n");
  const result = input.runner.run("gh", [
    "api",
    "graphql",
    "-f",
    `owner=${parsedRepository.value.owner}`,
    "-f",
    `name=${parsedRepository.value.repo}`,
    "-F",
    `number=${input.pullRequestNumber}`,
    "-f",
    `query=${query}`,
  ]);

  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: {
        code: "gh_failed",
        message: result.stderr.trim() || `gh api graphql failed with exit code ${result.exitCode}.`,
        command: "gh api graphql",
        exitCode: result.exitCode,
        stderr: result.stderr,
      },
    };
  }

  try {
    const parsed = JSON.parse(result.stdout) as GitHubPullRequestIssueLinksGraphqlResponse;
    const pullRequest = parsed.data?.repository?.pullRequest;

    if (pullRequest === undefined || pullRequest === null) {
      return {
        ok: true,
        value: [],
      };
    }

    return {
      ok: true,
      value: parsePullRequestIssueLinks({
        pullRequestNumber: input.pullRequestNumber,
        body: pullRequest.body ?? "",
        headRefName: pullRequest.headRefName ?? "",
        closingIssueNumbers: pullRequest.closingIssuesReferences?.nodes
          ?.map((node) => node?.number)
          .filter((number): number is number => typeof number === "number") ?? [],
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      ok: false,
      error: {
        code: "invalid_json",
        message: `gh api graphql returned invalid JSON: ${message}`,
        command: "gh api graphql",
        stderr: result.stdout,
      },
    };
  }
}
