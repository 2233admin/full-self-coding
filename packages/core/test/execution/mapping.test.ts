// packages/core/test/execution/mapping.test.ts
import { describe, test, expect } from "bun:test";
import { toTaskResult, buildTaskPrompt } from "../../src/execution/mapping";
import { TaskStatus } from "../../src/task";

describe("toTaskResult", () => {
  const baseTask = {
    ID: "task-1",
    title: "Test task",
    description: "Test desc",
    priority: 1,
  };

  test("maps success ExecutionResult to TaskResult", () => {
    const er = {
      workUnitId: "task-1",
      status: "success" as const,
      commitHash: "abc123",
      branch: "fsc/task-1",
      worktreePath: "/tmp/test",
      startedAt: 1000,
      completedAt: 2000,
      agent: { type: "claude" },
      filesChanged: ["a.ts"],
      logs: [],
    };
    const result = toTaskResult(er, baseTask);
    expect(result.status).toBe(TaskStatus.SUCCESS);
    expect(result.commitHash).toBe("abc123");
    expect(result.worktreeBranch).toBe("fsc/task-1");
  });

  test("maps timeout to FAILURE", () => {
    const er = {
      workUnitId: "task-1",
      status: "timeout" as const,
      commitHash: null,
      branch: "fsc/task-1",
      worktreePath: "/tmp/test",
      startedAt: 1000,
      completedAt: 2000,
      agent: { type: "codex" },
      filesChanged: [],
      logs: [],
      error: { message: "timed out", category: "TRANSIENT" as const },
    };
    const result = toTaskResult(er, baseTask);
    expect(result.status).toBe(TaskStatus.FAILURE);
    expect(result.report).toContain("TRANSIENT");
  });
});

describe("buildTaskPrompt", () => {
  test("includes title and description", () => {
    const prompt = buildTaskPrompt({
      ID: "t1", title: "Fix bug", description: "Fix the null check", priority: 1,
    });
    expect(prompt).toContain("Fix bug");
    expect(prompt).toContain("Fix the null check");
    expect(prompt).toContain("Commit your changes");
  });
});

describe("normalizeAgentType", () => {
  const { normalizeAgentType, toWorkUnitForAgent } = require("../../src/execution/mapping");

  test("maps config names to catalog keys", () => {
    expect(normalizeAgentType("claude-code")).toBe("claude");
    expect(normalizeAgentType("gemini-cli")).toBe("gemini");
    expect(normalizeAgentType("codex")).toBe("codex");
  });

  test("unknown agents are an error, not a silent fallback to another agent", () => {
    expect(() => normalizeAgentType("cursor")).toThrow(/Unsupported agent/);
    expect(() => normalizeAgentType("nope")).toThrow(/Supported:/);
  });

  test("claude is launched unattended and without the nonexistent --cwd flag", () => {
    const unit = toWorkUnitForAgent({ ID: "t", title: "x", description: "y", priority: 1 }, "claude-code", ".");
    expect(unit.agentConfig.command).toBe("claude");
    const args = unit.agentConfig.buildArgs("do it", "/wt");
    expect(args).not.toContain("--cwd");
    expect(args).toContain("--permission-mode");
  });
});

describe("claude isolation", () => {
  const { toWorkUnitForAgent } = require("../../src/execution/mapping");
  const task = { ID: "t", title: "x", description: "y", priority: 1 };

  test("agents ignore the operator's user-level settings by default", () => {
    const prev = process.env.FSC_CLAUDE_USER_SETTINGS;
    delete process.env.FSC_CLAUDE_USER_SETTINGS;
    try {
      const args = toWorkUnitForAgent(task, "claude-code", ".").agentConfig.buildArgs("p", "/wt");
      const i = args.indexOf("--setting-sources");
      expect(i).toBeGreaterThan(-1);
      expect(args[i + 1]).toBe("project,local");
    } finally {
      if (prev !== undefined) process.env.FSC_CLAUDE_USER_SETTINGS = prev;
    }
  });

  test("FSC_CLAUDE_USER_SETTINGS=1 opts back in", () => {
    const prev = process.env.FSC_CLAUDE_USER_SETTINGS;
    process.env.FSC_CLAUDE_USER_SETTINGS = "1";
    try {
      const args = toWorkUnitForAgent(task, "claude-code", ".").agentConfig.buildArgs("p", "/wt");
      expect(args).not.toContain("--setting-sources");
    } finally {
      if (prev === undefined) delete process.env.FSC_CLAUDE_USER_SETTINGS;
      else process.env.FSC_CLAUDE_USER_SETTINGS = prev;
    }
  });
});
