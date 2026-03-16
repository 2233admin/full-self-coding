import { describe, test, expect } from "bun:test";
import { getCoChangedFiles, expandWithCoupling } from "../../src/salacia/coupling";

const REPO = "D:/projects/full-self-coding";

describe("getCoChangedFiles", () => {
  test("returns co-changed files for scheduler.ts", () => {
    const results = getCoChangedFiles(
      "packages/core/src/execution/scheduler.ts",
      REPO,
      180, // 6 months lookback for enough data
      0.2, // lower threshold for test
      2,
    );
    console.log("\n┌── Co-change coupling: scheduler.ts ──┐");
    for (const r of results) {
      console.log(`│ ${r.coupling.toFixed(3)} (${r.coChanges}x) ${r.file}`);
    }
    console.log("└───────────────────────────────────────┘\n");

    // scheduler.ts should have some companions in this repo
    expect(Array.isArray(results)).toBe(true);
    // Each entry has the right shape
    for (const r of results) {
      expect(r.coupling).toBeGreaterThanOrEqual(0);
      expect(r.coupling).toBeLessThanOrEqual(1);
      expect(r.coChanges).toBeGreaterThanOrEqual(2);
    }
  });

  test("returns empty for non-existent file", () => {
    const results = getCoChangedFiles("does/not/exist.ts", REPO, 90);
    expect(results).toEqual([]);
  });

  test("results are sorted by coupling descending", () => {
    const results = getCoChangedFiles(
      "packages/core/src/execution/scheduler.ts", REPO, 180, 0.1, 2,
    );
    for (let i = 1; i < results.length; i++) {
      expect(results[i].coupling).toBeLessThanOrEqual(results[i - 1].coupling);
    }
  });
});

describe("expandWithCoupling", () => {
  test("expands core files with companions", () => {
    const expanded = expandWithCoupling(
      ["packages/core/src/execution/scheduler.ts"],
      REPO,
      180,
    );
    // Should not include the input file itself
    expect(expanded).not.toContain("packages/core/src/execution/scheduler.ts");
    console.log(`Expanded ${expanded.length} companion files`);
  });

  test("deduplicates across multiple inputs", () => {
    const expanded = expandWithCoupling(
      [
        "packages/core/src/execution/scheduler.ts",
        "packages/core/src/execution/pool.ts",
      ],
      REPO,
      180,
    );
    const unique = new Set(expanded);
    expect(unique.size).toBe(expanded.length);
  });
});
