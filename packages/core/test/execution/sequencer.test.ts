import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { CommitSequencer } from "../../src/execution/sequencer";
import { gitExec } from "../../src/execution/gitExec";
import type { ExecutionResult } from "../../src/execution/types";
import fs from "fs";
import path from "path";
import os from "os";

describe("CommitSequencer", () => {
  let testRepo: string;

  beforeAll(() => {
    testRepo = path.resolve(os.tmpdir(), `fsc-seq-test-${Date.now()}`);
    fs.mkdirSync(testRepo, { recursive: true });
    gitExec(["init"], testRepo);
    gitExec(["checkout", "-b", "main"], testRepo);
    fs.writeFileSync(path.resolve(testRepo, "README.md"), "base");
    gitExec(["add", "-A"], testRepo);
    gitExec(["commit", "--author", "Test <t@t>", "-m", "initial"], testRepo);
  });

  afterAll(() => {
    fs.rmSync(testRepo, { recursive: true, force: true });
  });

  test("applies a commit via cherry-pick", async () => {
    // Create a task branch with a commit
    gitExec(["checkout", "-b", "fsc/seq-test-1"], testRepo);
    fs.writeFileSync(path.resolve(testRepo, "new-file.txt"), "hello");
    gitExec(["add", "-A"], testRepo);
    gitExec(["commit", "--author", "Test <t@t>", "-m", "task commit"], testRepo);
    const hash = gitExec(["rev-parse", "HEAD"], testRepo).stdout.trim();
    gitExec(["checkout", "main"], testRepo);

    const sequencer = new CommitSequencer(testRepo, "main");
    const result = await sequencer.apply({
      workUnitId: "seq-test-1",
      status: "success",
      commitHash: hash,
      branch: "fsc/seq-test-1",
      worktreePath: testRepo,
      startedAt: 0, completedAt: 0,
      agent: { type: "test" },
      filesChanged: ["new-file.txt"],
      logs: [],
    });

    expect(result.success).toBe(true);
    expect(result.commitHash).toBeTruthy();
    // Verify file exists on main
    expect(fs.existsSync(path.resolve(testRepo, "new-file.txt"))).toBe(true);
  });

  test("skips null commitHash", async () => {
    const sequencer = new CommitSequencer(testRepo, "main");
    const result = await sequencer.apply({
      workUnitId: "seq-test-null",
      status: "success",
      commitHash: null,
      branch: "fsc/seq-test-null",
      worktreePath: testRepo,
      startedAt: 0, completedAt: 0,
      agent: { type: "test" },
      filesChanged: [],
      logs: [],
    });
    expect(result.success).toBe(true);
    expect(result.error).toBe("no changes");
  });

  test("handles already-merged commits gracefully", async () => {
    // The commit from test 1 is already on main
    const hash = gitExec(["rev-parse", "HEAD"], testRepo).stdout.trim();
    const sequencer = new CommitSequencer(testRepo, "main");
    const result = await sequencer.apply({
      workUnitId: "seq-test-dup",
      status: "success",
      commitHash: hash,
      branch: "fsc/seq-test-dup",
      worktreePath: testRepo,
      startedAt: 0, completedAt: 0,
      agent: { type: "test" },
      filesChanged: [],
      logs: [],
    });
    expect(result.success).toBe(true);
    expect(result.error).toBe("already merged");
  });
});
