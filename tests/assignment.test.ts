import { describe, expect, it } from "vitest";
import {
  buildAgentLabel,
  getAssignedAgentIds,
  isAssignedToLocalMachine,
  parseAgentId,
} from "../src/assignment.js";

describe("agent assignments", () => {
  it("[UC-AGENT-02-S01] builds assignment labels from normalized agent ids", () => {
    expect(buildAgentLabel("coder@fankai-mac")).toBe("agent:coder@fankai-mac");
  });

  it("[UC-AGENT-02-S01] rejects non-normalized agent ids", () => {
    expect(() => parseAgentId("Code Reviewer@Fankai Mac")).toThrow(
      'Invalid agent id "Code Reviewer@Fankai Mac". Use normalized id "code-reviewer@fankai-mac".',
    );
  });

  it("[UC-AGENT-02-S03] returns multiple assigned agent ids", () => {
    expect(getAssignedAgentIds(["agent:planner@fankai-mac", "agent:coder@fankai-mac", "mvp"])).toEqual([
      "planner@fankai-mac",
      "coder@fankai-mac",
    ]);
  });

  it("[UC-AGENT-02-S05] detects assignments for other machines", () => {
    expect(isAssignedToLocalMachine(["agent:coder@other-machine"], "fankai-mac")).toBe(false);
    expect(isAssignedToLocalMachine(["agent:coder@fankai-mac"], "fankai-mac")).toBe(true);
  });
});
