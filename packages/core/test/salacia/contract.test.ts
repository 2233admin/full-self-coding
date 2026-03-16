import { describe, test, expect } from "bun:test";
import { generateContract, contractToPromptSuffix } from "../../src/salacia/contract";
import type { Task } from "../../src/task";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    ID: "test-001",
    title: "Fix scheduler bug",
    description: "The scheduler crashes when pool is full",
    priority: 3,
    ...overrides,
  };
}

describe("generateContract", () => {
  test("extracts keyword-based paths from description", () => {
    const contract = generateContract(makeTask());
    expect(contract.taskId).toBe("test-001");
    expect(contract.allowedPaths.some(p => p.includes("execution"))).toBe(true);
    expect(contract.generatedBy).toBe("heuristic");
  });

  test("falls back to broad scope when no keywords match", () => {
    const contract = generateContract(makeTask({
      title: "Improve color scheme",
      description: "Adjust the palette for better contrast",
    }));
    expect(contract.allowedPaths).toContain("packages/core/src/**");
    expect(contract.allowedPaths).toContain("tests/**");
  });

  test("readme keyword maps to README.md", () => {
    const contract = generateContract(makeTask({
      title: "Update readme",
      description: "Add installation instructions",
    }));
    expect(contract.allowedPaths).toContain("README.md");
  });

  test("detects quoted file paths in description", () => {
    const contract = generateContract(makeTask({
      description: 'Fix the bug in "packages/core/src/codeRAG.ts" file',
    }));
    expect(contract.allowedPaths).toContain("packages/core/src/codeRAG.ts");
  });

  test("maxFilesChanged scales with risk level", () => {
    const low = generateContract(makeTask({ riskLevel: "low" }));
    const critical = generateContract(makeTask({ riskLevel: "critical" }));
    expect(low.maxFilesChanged).toBe(5);
    expect(critical.maxFilesChanged).toBe(30);
  });

  test("protected paths always include .env", () => {
    const contract = generateContract(makeTask());
    expect(contract.protectedPaths).toContain(".env");
  });
});

describe("contractToPromptSuffix", () => {
  test("generates readable scope instructions", () => {
    const contract = generateContract(makeTask());
    const suffix = contractToPromptSuffix(contract);
    expect(suffix).toContain("Scope Contract");
    expect(suffix).toContain("Allowed paths");
    expect(suffix).toContain("PROTECTED");
  });
});
