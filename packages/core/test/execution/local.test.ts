// packages/core/test/execution/local.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { LocalExecution } from "../../src/execution/local";
import { WorktreeManager } from "../../src/execution/worktree";
import { gitExec } from "../../src/execution/gitExec";
import type { WorkUnit } from "../../src/execution/types";
import fs from "fs";
import path from "path";
import os from "os";

describe("LocalExecution", () => {
  let testRepo: string;
  let execution: LocalExecution;

  beforeAll(() => {
    testRepo = path.resolve(os.tmpdir(), `fsc-local-test-${Date.now()}`);
    fs.mkdirSync(testRepo, { recursive: true });
    gitExec(["init"], testRepo);
    gitExec(["checkout", "-b", "main"], testRepo);
    fs.writeFileSync(path.resolve(testRepo, "README.md"), "test");
    gitExec(["add", "-A"], testRepo);
    gitExec([
      "commit", "--author", "Test <test@test.com>", "-m", "initial",
    ], testRepo);
    execution = new LocalExecution(new WorktreeManager());
  });

  afterAll(() => {
    new WorktreeManager().cleanup(testRepo);
    fs.rmSync(testRepo, { recursive: true, force: true });
    // Clean sibling dirs
    const parent = path.dirname(testRepo);
    const base = path.basename(testRepo);
    for (const e of fs.readdirSync(parent)) {
      if (e.startsWith(`${base}-fsc-`)) {
        fs.rmSync(path.resolve(parent, e), { recursive: true, force: true });
      }
    }
  });

  test("executes a simple agent that creates a file", async () => {
    // Use bash as a "mock agent" — creates a file and commits
    const shell = process.platform === "win32" ? "bash" : "/bin/sh";
    const unit: WorkUnit = {
      id: "local-test-1",
      repoPath: testRepo,
      baseBranch: "main",
      taskPrompt: "test prompt",
      agentConfig: {
        type: "custom",
        costTier: "free",
        memoryMB: 50,
        command: shell,
        buildArgs: () => ["-c", 'echo "hello" > test_output.txt && git add -A && git commit --author "Test <t@t>" -m "agent commit"'],
      },
      constraints: { timeoutMs: 10_000 },
    };

    const result = await execution.execute(unit);
    expect(result.status).toBe("success");
    expect(result.commitHash).toBeTruthy();
    expect(result.filesChanged).toContain("test_output.txt");
  });

  test("auto-commits uncommitted changes", async () => {
    const shell = process.platform === "win32" ? "bash" : "/bin/sh";
    const unit: WorkUnit = {
      id: "local-test-2",
      repoPath: testRepo,
      baseBranch: "main",
      taskPrompt: "test",
      agentConfig: {
        type: "custom",
        costTier: "free",
        memoryMB: 50,
        command: shell,
        // Agent creates file but does NOT commit
        buildArgs: () => ["-c", 'echo "uncommitted" > auto_commit_test.txt'],
      },
      constraints: { timeoutMs: 10_000 },
    };

    const result = await execution.execute(unit);
    // Should have auto-committed
    expect(result.commitHash).toBeTruthy();
    expect(result.filesChanged).toContain("auto_commit_test.txt");
  });

  test("interpreter byproducts alone are not a result", async () => {
    const shell = process.platform === "win32" ? "bash" : "/bin/sh";
    const unit: WorkUnit = {
      id: "local-test-pyc-only",
      repoPath: testRepo,
      baseBranch: "main",
      taskPrompt: "test",
      agentConfig: {
        type: "custom",
        costTier: "free",
        memoryMB: 50,
        command: shell,
        buildArgs: () => ["-c", "mkdir -p __pycache__ && echo x > __pycache__/a.cpython-312.pyc"],
      },
      constraints: { timeoutMs: 10_000 },
    };

    const result = await execution.execute(unit);
    expect(result.commitHash).toBeNull();
    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("no changes");
  });

  test("agent output is kept in the repo's .fsc/logs", async () => {
    const log = path.resolve(testRepo, ".fsc", "logs", "local-test-pyc-only.log");
    expect(fs.existsSync(log)).toBe(true);
    expect(fs.readFileSync(log, "utf-8")).toContain("# exit=0");
  });

  test("handles timeout", async () => {
    const shell = process.platform === "win32" ? "bash" : "/bin/sh";
    const unit: WorkUnit = {
      id: "local-test-timeout",
      repoPath: testRepo,
      baseBranch: "main",
      taskPrompt: "test",
      agentConfig: {
        type: "custom",
        costTier: "free",
        memoryMB: 50,
        command: shell,
        buildArgs: () => ["-c", "sleep 30"],
      },
      constraints: { timeoutMs: 1_000 },  // 1s timeout
    };

    const result = await execution.execute(unit);
    expect(result.status).toBe("timeout");
  }, 10_000);

  test("returns null commitHash when agent makes no changes", async () => {
    const shell = process.platform === "win32" ? "bash" : "/bin/sh";
    const unit: WorkUnit = {
      id: "local-test-noop",
      repoPath: testRepo,
      baseBranch: "main",
      taskPrompt: "test",
      agentConfig: {
        type: "custom",
        costTier: "free",
        memoryMB: 50,
        command: shell,
        buildArgs: () => ["-c", "echo 'no changes'"],
      },
      constraints: { timeoutMs: 5_000 },
    };

    const result = await execution.execute(unit);
    expect(result.commitHash).toBeNull();
  });
});
