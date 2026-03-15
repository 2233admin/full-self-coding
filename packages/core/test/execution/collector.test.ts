// packages/core/test/execution/collector.test.ts
import { describe, test, expect } from "bun:test";
import { validateResult } from "../../src/execution/mapping";

describe("validateResult", () => {
  const validResult = {
    workUnitId: "task-1",
    status: "success",
    commitHash: "abc123",
    branch: "fsc/task-1",
    worktreePath: "/tmp/repo-fsc-task-1",
    startedAt: 1000,
    completedAt: 2000,
    agent: { type: "claude" },
    filesChanged: ["src/foo.ts"],
    logs: [],
  };

  test("accepts a valid result object", () => {
    expect(() => validateResult(validResult)).not.toThrow();
    const er = validateResult(validResult);
    expect(er.workUnitId).toBe("task-1");
    expect(er.status).toBe("success");
  });

  test("rejects null", () => {
    expect(() => validateResult(null)).toThrow("not an object");
  });

  test("rejects non-object", () => {
    expect(() => validateResult("string")).toThrow("not an object");
    expect(() => validateResult(42)).toThrow("not an object");
  });

  test("rejects missing required field workUnitId", () => {
    const { workUnitId: _, ...rest } = validResult;
    expect(() => validateResult(rest)).toThrow("missing required field 'workUnitId'");
  });

  test("rejects missing required field status", () => {
    const { status: _, ...rest } = validResult;
    expect(() => validateResult(rest)).toThrow("missing required field 'status'");
  });

  test("rejects missing required field branch", () => {
    const { branch: _, ...rest } = validResult;
    expect(() => validateResult(rest)).toThrow("missing required field 'branch'");
  });

  test("rejects invalid status value", () => {
    expect(() => validateResult({ ...validResult, status: "pending" })).toThrow("invalid status");
  });

  test("accepts null commitHash", () => {
    expect(() => validateResult({ ...validResult, commitHash: null })).not.toThrow();
  });

  test("rejects non-string commitHash", () => {
    expect(() => validateResult({ ...validResult, commitHash: 123 })).toThrow("commitHash must be string or null");
  });

  test("accepts all valid statuses", () => {
    for (const status of ["success", "failure", "timeout", "error"] as const) {
      expect(() => validateResult({ ...validResult, status })).not.toThrow();
    }
  });
});
