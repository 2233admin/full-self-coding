import { describe, test, expect } from "bun:test";
import { ABExperiment, assignGroup } from "../../src/salacia/experiment";

describe("assignGroup", () => {
  test("deterministic — same taskId always gets same group", () => {
    const g1 = assignGroup("task-abc", 0.5);
    const g2 = assignGroup("task-abc", 0.5);
    expect(g1).toBe(g2);
  });

  test("different taskIds can get different groups", () => {
    const groups = new Set<string>();
    for (let i = 0; i < 100; i++) {
      groups.add(assignGroup(`task-${i}`, 0.5));
    }
    // With 100 tasks and 50/50 split, both groups should appear
    expect(groups.has("control")).toBe(true);
    expect(groups.has("salacia")).toBe(true);
  });

  test("splitRatio 1.0 puts all in salacia", () => {
    for (let i = 0; i < 20; i++) {
      expect(assignGroup(`t-${i}`, 1.0)).toBe("salacia");
    }
  });

  test("splitRatio 0.0 puts all in control", () => {
    for (let i = 0; i < 20; i++) {
      expect(assignGroup(`t-${i}`, 0.0)).toBe("control");
    }
  });
});

describe("ABExperiment", () => {
  test("report aggregates metrics correctly", () => {
    const exp = new ABExperiment(0.5);

    exp.record({ taskId: "t1", group: "control", filesChanged: 3, outOfScopeFiles: 1, qualityScore: 80, driftScore: 5, success: true, durationMs: 1000 });
    exp.record({ taskId: "t2", group: "control", filesChanged: 5, outOfScopeFiles: 3, qualityScore: 60, driftScore: 15, success: false, durationMs: 2000 });
    exp.record({ taskId: "t3", group: "salacia", filesChanged: 2, outOfScopeFiles: 0, qualityScore: 95, driftScore: 0, success: true, durationMs: 1200 });
    exp.record({ taskId: "t4", group: "salacia", filesChanged: 4, outOfScopeFiles: 0, qualityScore: 85, driftScore: 0, success: true, durationMs: 1400 });

    const report = exp.report();

    expect(report.control.count).toBe(2);
    expect(report.salacia.count).toBe(2);
    expect(report.control.successRate).toBe(0.5);
    expect(report.salacia.successRate).toBe(1.0);
    expect(report.delta.successRate).toBe(0.5); // salacia 100% - control 50%
    expect(report.delta.outOfScope).toBe(-2); // salacia 0 avg - control 2 avg
    expect(report.totalTasks).toBe(4);
  });
});
