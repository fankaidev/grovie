import { describe, expect, it } from "vitest";
import {
  buildAgentId,
  resolveMachineId,
  slugifyIdentityPart,
} from "../src/identity.js";

describe("identity resolution", () => {
  it("[UC-AGENT-01-S01] resolves hostnames into machine ids", () => {
    expect(resolveMachineId("Fankai MacBook Pro.local")).toBe("fankai-macbook-pro-local");
  });

  it("[UC-AGENT-01-S02] builds full agent ids from agent names and machine ids", () => {
    expect(buildAgentId("Code Reviewer", "fankai-mac")).toBe("code-reviewer@fankai-mac");
  });

  it("[UC-AGENT-01-S03] collapses invalid slug characters and trims leading or trailing dashes", () => {
    expect(slugifyIdentityPart("  Code___Reviewer...2026  ")).toBe("code-reviewer-2026");
  });

});
