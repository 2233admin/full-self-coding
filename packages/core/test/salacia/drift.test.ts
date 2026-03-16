import { describe, test, expect } from "bun:test";
import { detectDrift, isFatalDrift, exceedsThreshold } from "../../src/salacia/drift";
import type { ExecutionContract } from "../../src/salacia/contract";

function makeContract(overrides: Partial<ExecutionContract> = {}): ExecutionContract {
  return {
    taskId: "test-001",
    allowedPaths: ["packages/core/src/execution/**"],
    excludedPaths: ["node_modules/**", ".git/**", "dist/**"],
    protectedPaths: [".env", "package-lock.json"],
    maxFilesChanged: 5,
    generatedAt: Date.now(),
    generatedBy: "heuristic",
    ...overrides,
  };
}

describe("detectDrift", () => {
  test("in-scope files score 0", () => {
    const report = detectDrift(
      makeContract(),
      ["packages/core/src/execution/local.ts"],
      ".",
    );
    expect(report.score).toBe(0);
    expect(report.inScopeFiles).toContain("packages/core/src/execution/local.ts");
    expect(report.outOfScopeFiles).toHaveLength(0);
  });

  test("out-of-scope files score +5 each", () => {
    const report = detectDrift(
      makeContract(),
      ["packages/cli/src/main.ts", "README.md"],
      ".",
    );
    expect(report.outOfScopeFiles).toHaveLength(2);
    expect(report.score).toBe(10); // 2 * 5
  });

  test("protected path violation scores +40", () => {
    const report = detectDrift(
      makeContract(),
      [".env", "packages/core/src/execution/local.ts"],
      ".",
    );
    expect(report.protectedViolations).toContain(".env");
    expect(report.score).toBe(40);
  });

  test("excess files add +2 per file beyond max", () => {
    const files = Array.from({ length: 8 }, (_, i) =>
      `packages/core/src/execution/file${i}.ts`
    );
    const report = detectDrift(
      makeContract({ maxFilesChanged: 5 }),
      files,
      ".",
    );
    expect(report.excessFiles).toBe(3);
    expect(report.score).toBe(6); // 3 * 2 (all in scope, just excess)
  });

  test("excluded paths treated as out-of-scope", () => {
    const report = detectDrift(
      makeContract(),
      ["node_modules/foo/index.js"],
      ".",
    );
    expect(report.outOfScopeFiles).toContain("node_modules/foo/index.js");
    expect(report.score).toBe(5);
  });
});

describe("isFatalDrift", () => {
  test("true when protected paths violated", () => {
    const report = detectDrift(makeContract(), [".env"], ".");
    expect(isFatalDrift(report)).toBe(true);
  });

  test("false when no protected violations", () => {
    const report = detectDrift(makeContract(), ["README.md"], ".");
    expect(isFatalDrift(report)).toBe(false);
  });
});

describe("exceedsThreshold", () => {
  test("true when score >= threshold", () => {
    const report = detectDrift(
      makeContract(),
      // 6 out-of-scope files = 30 points
      Array.from({ length: 6 }, (_, i) => `random/file${i}.ts`),
      ".",
    );
    expect(exceedsThreshold(report, 30)).toBe(true);
  });

  test("false when score < threshold", () => {
    const report = detectDrift(
      makeContract(),
      ["packages/core/src/execution/local.ts"],
      ".",
    );
    expect(exceedsThreshold(report, 30)).toBe(false);
  });
});
