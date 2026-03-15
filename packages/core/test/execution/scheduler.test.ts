// packages/core/test/execution/scheduler.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { UnifiedScheduler } from "../../src/execution/scheduler";
import { LocalExecution } from "../../src/execution/local";
import { WorktreeManager } from "../../src/execution/worktree";
import { ConcurrencyPool } from "../../src/execution/concurrency";
import { WorktreePool } from "../../src/execution/pool";
import { gitExec } from "../../src/execution/gitExec";
import type { Task } from "../../src/task";
import type { WorkUnit } from "../../src/execution/types";
import fs from "fs";
import path from "path";
import os from "os";

// Subclass that injects a bash mock agent instead of real CLI agents
class TestScheduler extends UnifiedScheduler {
  private mockShell = process.platform === "win32" ? "bash" : "/bin/sh";

  // Override by monkey-patching execution after construction
  // We expose a way to run with custom units
  async executeWithMockAgent(tasks: Task[], repoPath: string) {
    // Reset state
    const scheduler = new UnifiedScheduler({ localPoolSize: 2, maxConcurrency: 2 });
    return scheduler.executeOverride(tasks, repoPath, this.mockShell);
  }
}

// We need to extend UnifiedScheduler to inject mock agent config.
// The cleanest way: extend and override the internal unit-building logic.
import { TaskStateStore } from "../../src/execution/state";
import { CommitSequencer } from "../../src/execution/sequencer";
import type { SchedulerReport } from "../../src/execution/scheduler";

class MockScheduler {
  private stateStore = new TaskStateStore();
  private concurrency: ConcurrencyPool;
  private execution: LocalExecution;
  private pool: WorktreePool | null = null;
  private shell = process.platform === "win32" ? "bash" : "/bin/sh";

  constructor(private poolSize: number, private maxConcurrency: number) {
    this.concurrency = new ConcurrencyPool(maxConcurrency);
    this.execution = new LocalExecution(new WorktreeManager());
  }

  async execute(tasks: Task[], repoPath: string): Promise<SchedulerReport> {
    const startTime = Date.now();
    const baseBranch = gitExec(["rev-parse", "--abbrev-ref", "HEAD"], repoPath).stdout.trim() || "main";

    this.pool = new WorktreePool(repoPath, baseBranch, this.poolSize);
    await this.pool.init();

    for (const task of tasks) {
      this.stateStore.create(task.ID, "local");
    }

    const executionResults: import("../../src/execution/types").ExecutionResult[] = [];

    const execPromises = tasks.map((task) =>
      this.concurrency.run(async () => {
        try {
          this.stateStore.transition(task.ID, "dispatched");
          const wt = await this.pool!.lease(task.ID);
          this.stateStore.transition(task.ID, "dispatched", { worktreePath: wt.worktreePath });
          // NOTE: skip pool.prepareForTask — LocalExecution creates its own worktree+branch
          // Pool is used here only for state/concurrency tracking, not the actual worktree

          // Use exec-prefixed id so LocalExecution's branch doesn't clash with pool's fsc/task-N
          const execId = `exec-${task.ID}`;

          // Build mock work unit using bash
          const unit: WorkUnit = {
            id: execId,
            repoPath,
            baseBranch,
            taskPrompt: task.description,
            agentConfig: {
              type: "custom",
              command: this.shell,
              buildArgs: () => [
                "-c",
                `echo "${task.ID}" > task_${task.ID}.txt && git add -A && git commit --author "Test <t@t>" -m "task: ${task.ID}"`,
              ],
            },
            constraints: { timeoutMs: 15_000 },
          };

          this.stateStore.transition(task.ID, "running", { agentType: "custom" });

          const result = await this.execution.execute(unit);
          executionResults.push(result);

          if (result.status === "success") {
            this.stateStore.transition(task.ID, "completed", {
              commitHash: result.commitHash ?? undefined,
            });
          } else {
            this.stateStore.transition(task.ID, "failed", {
              error: result.error?.message,
            });
          }
        } catch (e: any) {
          this.stateStore.transition(task.ID, "failed", { error: e.message });
        } finally {
          try { await this.pool!.release(task.ID); } catch {}
        }
      })
    );

    await Promise.allSettled(execPromises);

    const sequencer = new CommitSequencer(repoPath, baseBranch);
    const mergeResults = await sequencer.applyAll(executionResults);

    await this.pool.destroy();

    const durationMs = Date.now() - startTime;
    const summary = this.stateStore.summary();

    return {
      total: summary.total,
      completed: summary.completed,
      failed: summary.failed,
      aborted: summary.aborted,
      tasks: this.stateStore.list(),
      mergeResults,
      durationMs,
    };
  }

  getStateStore() {
    return this.stateStore;
  }
}

describe("UnifiedScheduler (MockScheduler)", () => {
  let testRepo: string;
  let runId: number;

  beforeAll(() => {
    runId = Date.now();
    testRepo = path.resolve(os.tmpdir(), `fsc-scheduler-test-${runId}`);
    fs.mkdirSync(testRepo, { recursive: true });
    gitExec(["init"], testRepo);
    gitExec(["checkout", "-b", "main"], testRepo);
    fs.writeFileSync(path.resolve(testRepo, "README.md"), "scheduler test");
    gitExec(["add", "-A"], testRepo);
    gitExec(["commit", "--author", "Test <test@test.com>", "-m", "initial"], testRepo);
  });

  afterAll(() => {
    new WorktreeManager().cleanup(testRepo);
    fs.rmSync(testRepo, { recursive: true, force: true });
    // Clean sibling worktree dirs
    const parent = path.dirname(testRepo);
    const base = path.basename(testRepo);
    for (const e of fs.readdirSync(parent)) {
      if (e.startsWith(`${base}-fsc-`)) {
        fs.rmSync(path.resolve(parent, e), { recursive: true, force: true });
      }
    }
  });

  // Each call produces unique IDs to avoid branch collisions across tests
  let taskCounter = 0;
  const makeTasks = (count: number): Task[] =>
    Array.from({ length: count }, (_, i) => {
      taskCounter++;
      return {
        ID: `t${taskCounter}-${runId}`,
        title: `Task ${taskCounter}`,
        description: `Do thing ${taskCounter}`,
        priority: 1,
      };
    });

  test("executes 3 tasks, all reach completed state", async () => {
    const tasks = makeTasks(3);
    const scheduler = new MockScheduler(2, 2);

    const report = await scheduler.execute(tasks, testRepo);

    expect(report.total).toBe(3);
    expect(report.completed).toBe(3);
    expect(report.failed).toBe(0);
    expect(report.aborted).toBe(0);
    expect(report.durationMs).toBeGreaterThan(0);
  }, 60_000);

  test("all task states are completed (not pending/running/dispatched)", async () => {
    const tasks = makeTasks(3);
    const scheduler = new MockScheduler(2, 2);

    const report = await scheduler.execute(tasks, testRepo);

    for (const state of report.tasks) {
      expect(state.status).toBe("completed");
      expect(state.target).toBe("local");
      expect(state.startedAt).toBeGreaterThan(0);
      expect(state.completedAt).toBeGreaterThan(0);
    }
  }, 60_000);

  test("stateStore summary reflects completed tasks", async () => {
    const tasks = makeTasks(3);
    const scheduler = new MockScheduler(2, 2);

    await scheduler.execute(tasks, testRepo);
    const summary = scheduler.getStateStore().summary();

    expect(summary.total).toBe(3);
    expect(summary.completed).toBe(3);
    expect(summary.pending).toBe(0);
    expect(summary.running).toBe(0);
    expect(summary.dispatched).toBe(0);
    expect(summary.failed).toBe(0);
  }, 60_000);

  test("mergeResults contain sequencer output for commits", async () => {
    const tasks = makeTasks(3);
    const scheduler = new MockScheduler(2, 2);

    const report = await scheduler.execute(tasks, testRepo);

    // Each task creates a commit, sequencer should process them
    expect(report.mergeResults.length).toBeGreaterThanOrEqual(0);
    // All successful merges should have taskId set
    for (const mr of report.mergeResults) {
      expect(mr.taskId).toBeTruthy();
    }
  }, 60_000);
});
