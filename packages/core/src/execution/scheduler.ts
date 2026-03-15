import { TaskStateStore, type TaskState, type TaskStateSummary, type SchedulerTaskStatus } from "./state";
import { WorktreePool } from "./pool";
import { ConcurrencyPool } from "./concurrency";
import { LocalExecution } from "./local";
import { WorktreeManager } from "./worktree";
import { CommitSequencer, type SequencerResult } from "./sequencer";
import { toWorkUnitByTier, toTaskResult } from "./mapping";
import { gitExec } from "./gitExec";
import type { Task, TaskResult } from "../task";
import type { CostTierStrategy } from "../modelRouter";
import type { ExecutionResult } from "./types";

export interface SchedulerConfig {
  localPoolSize: number;       // default 24
  maxConcurrency: number;      // default 5
  costStrategy: CostTierStrategy;  // default "minimize-cost"
  freeclawBase?: string;
}

export interface SchedulerReport {
  total: number;
  completed: number;
  failed: number;
  aborted: number;
  tasks: TaskState[];
  mergeResults: SequencerResult[];
  durationMs: number;
}

// FSC Runner API types (for claw-grid integration, Phase 2)
export interface RunnerAPI {
  submit(tasks: Task[], repoPath: string): Promise<string>;
  status(batchId: string): SchedulerReport;
  abort(batchId: string): Promise<void>;
}

const DEFAULT_CONFIG: SchedulerConfig = {
  localPoolSize: 24,
  maxConcurrency: 5,
  costStrategy: "minimize-cost",
};

export class UnifiedScheduler {
  private config: SchedulerConfig;
  private stateStore: TaskStateStore;
  private pool: WorktreePool | null = null;
  private concurrency: ConcurrencyPool;
  private execution: LocalExecution;
  private repoPath: string = "";
  private baseBranch: string = "main";

  constructor(config: Partial<SchedulerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.stateStore = new TaskStateStore();
    this.concurrency = new ConcurrencyPool(this.config.maxConcurrency);
    this.execution = new LocalExecution(new WorktreeManager());
  }

  async execute(tasks: Task[], repoPath: string): Promise<SchedulerReport> {
    const startTime = Date.now();
    this.repoPath = repoPath;
    this.baseBranch = gitExec(["rev-parse", "--abbrev-ref", "HEAD"], repoPath).stdout.trim() || "main";

    // 1. Initialize pool
    this.pool = new WorktreePool(repoPath, this.baseBranch, this.config.localPoolSize);
    await this.pool.init();

    // 2. Register all tasks as pending
    for (const task of tasks) {
      this.stateStore.create(task.ID, "local");
    }

    // 3. Execute with concurrency control
    const executionResults: ExecutionResult[] = [];

    const execPromises = tasks.map((task) =>
      this.concurrency.run(async () => {
        try {
          // Dispatch: lease worktree
          this.stateStore.transition(task.ID, "dispatched");
          const wt = await this.pool!.lease(task.ID);
          this.stateStore.transition(task.ID, "dispatched", { worktreePath: wt.worktreePath });

          // Prepare task branch
          await this.pool!.prepareForTask(task.ID);

          // Build work unit
          const unit = toWorkUnitByTier(
            task, repoPath, this.config.costStrategy, this.config.freeclawBase
          );
          // Override worktree path from pool
          unit.repoPath = repoPath;

          // Running
          this.stateStore.transition(task.ID, "running", { agentType: unit.agentConfig.type });

          // Execute — use the pool's worktree, not create a new one
          // We need to run the agent in the leased worktree
          const result = await this.execution.execute({
            ...unit,
            id: task.ID,
            repoPath,  // execution will create its own worktree via WorktreeManager
          });

          executionResults.push(result);

          // Update state
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
          // Release worktree back to pool
          try { await this.pool!.release(task.ID); } catch {}
        }
      })
    );

    await Promise.allSettled(execPromises);

    // 4. Merge via sequencer
    const sequencer = new CommitSequencer(repoPath, this.baseBranch);
    const mergeResults = await sequencer.applyAll(executionResults);

    // 5. Cleanup pool
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

  /** Abort a specific task */
  async abort(taskId: string): Promise<void> {
    const state = this.stateStore.get(taskId);
    if (!state) return;
    if (state.status === "running") {
      await this.execution.abort(taskId);
    }
    this.stateStore.markAborted(taskId);
  }

  /** Retry all failed tasks */
  async retryFailed(repoPath?: string): Promise<SchedulerReport> {
    const failed = this.stateStore.getFailedTasks();
    for (const f of failed) {
      this.stateStore.markForRetry(f.taskId);
    }
    // Re-execute would need original Task objects — return current state for now
    return {
      total: this.stateStore.summary().total,
      completed: this.stateStore.summary().completed,
      failed: this.stateStore.summary().failed,
      aborted: this.stateStore.summary().aborted,
      tasks: this.stateStore.list(),
      mergeResults: [],
      durationMs: 0,
    };
  }

  /** Clean up worktree pool */
  async cleanup(): Promise<void> {
    if (this.pool) {
      await this.pool.destroy();
      this.pool = null;
    }
  }

  /** Get current state store */
  getStateStore(): TaskStateStore {
    return this.stateStore;
  }

  /** Get stats */
  stats(): TaskStateSummary {
    return this.stateStore.summary();
  }
}
