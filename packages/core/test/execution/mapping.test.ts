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
