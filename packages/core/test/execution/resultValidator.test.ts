// packages/core/test/execution/resultValidator.test.ts
import { describe, test, expect } from "bun:test";
import { validateResult } from "../../src/execution/mapping";

describe("validateResult", () => {
  const valid = {
    workUnitId: "task-1",
    status: "success",
    commitHash: "abc",
    branch: "fsc/task-1",
    worktreePath: "/tmp/x",
    startedAt: 1000,
    completedAt: 2000,
    agent: { type: "claude" },
    filesChanged: [],
    logs: [],
  };

  test("accepts valid result", () => {
    expect(() => validateResult(valid)).not.toThrow();
  });

  test("rejects missing required fields", () => {
    const { workUnitId, ...rest } = valid;
    expect(() => validateResult(rest)).toThrow("workUnitId");
  });

  test("rejects invalid status", () => {
    expect(() => validateResult({ ...valid, status: "bogus" })).toThrow("status");
  });

  test("accepts null commitHash", () => {
    expect(() => validateResult({ ...valid, commitHash: null })).not.toThrow();
  });

  test("rejects non-object input", () => {
    expect(() => validateResult("string")).toThrow("not an object");
    expect(() => validateResult(null)).toThrow("not an object");
  });
});
