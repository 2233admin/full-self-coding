// packages/core/test/execution/worktree.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { WorktreeManager } from "../../src/execution/worktree";
import { gitExec } from "../../src/execution/gitExec";
import fs from "fs";
import path from "path";
import os from "os";

describe("WorktreeManager", () => {
  let testRepo: string;
  let manager: WorktreeManager;

  beforeAll(() => {
    // Create a temp git repo for testing
    testRepo = path.resolve(os.tmpdir(), `fsc-wt-test-${Date.now()}`);
    fs.mkdirSync(testRepo, { recursive: true });
    gitExec(["init"], testRepo);
    gitExec(["checkout", "-b", "main"], testRepo);
    fs.writeFileSync(path.resolve(testRepo, "README.md"), "test repo");
    gitExec(["add", "-A"], testRepo);
    gitExec(["commit", "--allow-empty-message", "-m", "initial"], testRepo);
    manager = new WorktreeManager();
  });

  afterAll(() => {
    // Cleanup: remove worktrees then repo
    try { manager.cleanup(testRepo); } catch {}
    fs.rmSync(testRepo, { recursive: true, force: true });
    // Also clean sibling dirs
    const parent = path.dirname(testRepo);
    const base = path.basename(testRepo);
    for (const entry of fs.readdirSync(parent)) {
      if (entry.startsWith(`${base}-fsc-`)) {
        gitExec(["worktree", "remove", "--force", path.resolve(parent, entry)], testRepo);
        fs.rmSync(path.resolve(parent, entry), { recursive: true, force: true });
      }
    }
  });

  test("create() creates a git worktree as sibling dir", async () => {
    const info = await manager.create(testRepo, "main", "task-1");
    expect(info.branch).toBe("fsc/task-1");
    expect(fs.existsSync(info.worktreePath)).toBe(true);
    // Should be a sibling, not inside repo
    expect(path.dirname(info.worktreePath)).toBe(path.dirname(testRepo));
    // Cleanup
    await manager.remove(info.worktreePath, testRepo);
  });

  test("create() serializes concurrent calls (no index.lock conflict)", async () => {
    // Create 3 worktrees concurrently — should not crash
    const results = await Promise.all([
      manager.create(testRepo, "main", "concurrent-1"),
      manager.create(testRepo, "main", "concurrent-2"),
      manager.create(testRepo, "main", "concurrent-3"),
    ]);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(fs.existsSync(r.worktreePath)).toBe(true);
      await manager.remove(r.worktreePath, testRepo);
    }
  });

  test("list() returns FSC-managed worktrees", async () => {
    const info = await manager.create(testRepo, "main", "list-test");
    const list = manager.list(testRepo);
    expect(list.some(w => w.taskId === "list-test")).toBe(true);
    await manager.remove(info.worktreePath, testRepo);
  });

  test("remove() cleans up worktree and branch", async () => {
    const info = await manager.create(testRepo, "main", "remove-test");
    await manager.remove(info.worktreePath, testRepo);
    expect(fs.existsSync(info.worktreePath)).toBe(false);
  });

  test("cleanup() removes all FSC worktrees", async () => {
    await manager.create(testRepo, "main", "clean-1");
    await manager.create(testRepo, "main", "clean-2");
    manager.cleanup(testRepo);
    const list = manager.list(testRepo);
    expect(list).toHaveLength(0);
  });
});
