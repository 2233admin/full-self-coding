// packages/core/test/execution/concurrency.test.ts
import { describe, test, expect } from "bun:test";
import { ConcurrencyPool } from "../../src/execution/concurrency";

describe("ConcurrencyPool", () => {
  test("limits concurrent execution", async () => {
    const pool = new ConcurrencyPool(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 50));
      concurrent--;
    };

    await Promise.all(
      Array.from({ length: 6 }, () => pool.run(task))
    );

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  test("returns results from tasks", async () => {
    const pool = new ConcurrencyPool(3);
    const results = await Promise.all(
      [1, 2, 3].map(n => pool.run(async () => n * 2))
    );
    expect(results).toEqual([2, 4, 6]);
  });

  test("propagates errors from tasks", async () => {
    const pool = new ConcurrencyPool(2);
    await expect(
      pool.run(async () => { throw new Error("boom"); })
    ).rejects.toThrow("boom");
  });

  test("continues processing after error", async () => {
    const pool = new ConcurrencyPool(2);
    const results: number[] = [];

    await Promise.allSettled([
      pool.run(async () => { throw new Error("fail"); }),
      pool.run(async () => { results.push(1); }),
      pool.run(async () => { results.push(2); }),
    ]);

    expect(results).toHaveLength(2);
  });
});
