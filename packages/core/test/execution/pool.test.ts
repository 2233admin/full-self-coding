import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { WorktreePool } from "../../src/execution/pool";
import { gitExec } from "../../src/execution/gitExec";
import fs from "fs";
import path from "path";
import os from "os";

describe("WorktreePool", () => {
  let testRepo: string;

  beforeAll(() => {
    testRepo = path.resolve(os.tmpdir(), `fsc-pool-test-${Date.now()}`);
    fs.mkdirSync(testRepo, { recursive: true });
    gitExec(["init"], testRepo);
    gitExec(["checkout", "-b", "main"], testRepo);
    fs.writeFileSync(path.resolve(testRepo, "README.md"), "test");
    gitExec(["add", "-A"], testRepo);
    gitExec(["commit", "--author", "Test <t@t>", "-m", "initial"], testRepo);
  });

  afterAll(() => {
    // Clean up sibling dirs
    const parent = path.dirname(testRepo);
    const base = path.basename(testRepo);
    for (const e of fs.readdirSync(parent)) {
      if (e.startsWith(`${base}-fsc-`)) {
        gitExec(["worktree", "remove", "--force", path.resolve(parent, e)], testRepo);
        fs.rmSync(path.resolve(parent, e), { recursive: true, force: true });
      }
    }
    fs.rmSync(testRepo, { recursive: true, force: true });
  });

  test("init creates pool of worktrees", async () => {
    const pool = new WorktreePool(testRepo, "main", 3);
    await pool.init();
    const stats = pool.stats();
    expect(stats.total).toBe(3);
    expect(stats.available).toBe(3);
    expect(stats.leased).toBe(0);
    await pool.destroy();
  });

  test("lease and release cycle", async () => {
    const pool = new WorktreePool(testRepo, "main", 2);
    await pool.init();

    const wt1 = await pool.lease("task-a");
    expect(pool.stats().available).toBe(1);
    expect(pool.stats().leased).toBe(1);

    await pool.release("task-a");
    expect(pool.stats().available).toBe(2);
    expect(pool.stats().leased).toBe(0);

    await pool.destroy();
  });

  test("blocks when pool exhausted, unblocks on release", async () => {
    const pool = new WorktreePool(testRepo, "main", 1);
    await pool.init();

    await pool.lease("task-1");
    // Pool exhausted — next lease should block
    let resolved = false;
    const leasePromise = pool.lease("task-2").then((wt) => {
      resolved = true;
      return wt;
    });

    // Give it a tick — should still be blocked
    await new Promise(r => setTimeout(r, 50));
    expect(resolved).toBe(false);
    expect(pool.stats().waiting).toBe(1);

    // Release task-1 — should unblock task-2
    await pool.release("task-1");
    await leasePromise;
    expect(resolved).toBe(true);

    await pool.release("task-2");
    await pool.destroy();
  });

  test("prepareForTask creates task branch", async () => {
    const pool = new WorktreePool(testRepo, "main", 1);
    await pool.init();

    await pool.lease("branch-test");
    const branch = await pool.prepareForTask("branch-test");
    expect(branch).toBe("fsc/branch-test");

    await pool.release("branch-test");
    await pool.destroy();
  });
});
