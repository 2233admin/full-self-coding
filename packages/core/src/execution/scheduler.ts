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
import { SalaciaPlugin, type SalaciaConfig } from "../salacia/plugin";
import { ABExperiment, type ExperimentMetrics } from "../salacia/experiment";

export interface SchedulerConfig {
  localPoolSize: number;       // default 24
  maxConcurrency: number;      // default 5
  costStrategy: CostTierStrategy;  // default "minimize-cost"
  freeclawBase?: string;
  salacia?: SalaciaConfig & {
    experiment?: { enabled: boolean; splitRatio: number };
    postMergeTest?: boolean;  // run `bun test` after each merge
  };
}

export interface SchedulerReport {
  total: number;
  completed: number;
  failed: number;
  aborted: number;
  tasks: TaskState[];
  mergeResults: SequencerResult[];
  durationMs: number;
  zeroRegressionRate?: number;  // SWE-CI inspired: fraction of merges where ALL pre-existing tests still pass
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

    // 2. Salacia A/B experiment setup
    const salaciaConfig = this.config.salacia;
    const experiment = salaciaConfig?.experiment?.enabled
      ? new ABExperiment(salaciaConfig.experiment.splitRatio)
      : null;

    // 3. Register all tasks as pending
    for (const task of tasks) {
      this.stateStore.create(task.ID, "local");
    }

    // 4. Execute with concurrency control
    const executionResults: ExecutionResult[] = [];

    const execPromises = tasks.map((task) =>
      this.concurrency.run(async () => {
        try {
          // A/B: determine if this task gets salacia
          const group = experiment?.assignGroup(task.ID) ?? "control";
          const pluginEnabled = salaciaConfig?.enabled && (!experiment || group === "salacia");
          const plugin = new SalaciaPlugin({
            ...salaciaConfig,
            enabled: !!pluginEnabled,
            journalPath: `${repoPath}/.fsc/journal`,
          });

          // Dispatch: lease worktree
          this.stateStore.transition(task.ID, "dispatched");
          const wt = await this.pool!.lease(task.ID);
          this.stateStore.transition(task.ID, "dispatched", { worktreePath: wt.worktreePath });

          // Prepare task branch
          await this.pool!.prepareForTask(task.ID);

          // Build work unit (with optional salacia enrichment)
          const unit = toWorkUnitByTier(
            task, repoPath, this.config.costStrategy, this.config.freeclawBase, plugin
          );
          // Override worktree path from pool
          unit.repoPath = repoPath;

          // Running — inject salacia plugin into execution
          this.stateStore.transition(task.ID, "running", { agentType: unit.agentConfig.type });
          this.execution.salaciaPlugin = plugin.enabled ? plugin : undefined;

          // Execute — use the pool's worktree, not create a new one
          const result = await this.execution.execute({
            ...unit,
            id: task.ID,
            repoPath,
          });

          executionResults.push(result);

          // Record A/B metrics
          if (experiment) {
            const contract = plugin.getContract(task.ID);
            experiment.record({
              taskId: task.ID,
              group,
              filesChanged: result.filesChanged.length,
              outOfScopeFiles: 0, // drift report not easily available here; journal has it
              qualityScore: result.status === "success" ? 100 : 0,
              driftScore: 0,
              success: result.status === "success",
              durationMs: result.completedAt - result.startedAt,
            });
          }

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

    // Post-merge regression test (SWE-CI Zero-Regression Rate)
    let zeroRegressionCount = 0;
    let mergedCount = 0;
    if (salaciaConfig?.postMergeTest) {
      for (const mr of mergeResults) {
        if (mr.status === "merged") {
          mergedCount++;
          const testResult = Bun.spawnSync({ cmd: ["bun", "test"], cwd: repoPath, timeout: 120_000 });
          const pass = testResult.exitCode === 0;
          if (pass) zeroRegressionCount++;
          if (experiment) {
            const existing = experiment["metrics"]?.find((m: any) => m.taskId === mr.taskId);
            if (existing) existing.postMergeTestPass = pass;
          }
          if (!pass) {
            console.log(`[ZeroRegression] FAIL after merge of task ${mr.taskId} — tests broke`);
          }
        }
      }
    }

    // MEMO-inspired: inverse-frequency replay log for regression failures
    // Failed merges get recorded so retryFailed() can prioritize rare/hard failures
    if (salaciaConfig?.postMergeTest && mergedCount > 0) {
      const replayPath = `${repoPath}/.fsc/regression-replay.json`;
      let replay: Record<string, number> = {};
      try { replay = JSON.parse(require("fs").readFileSync(replayPath, "utf-8")); } catch {}
      for (const mr of mergeResults) {
        if (mr.status === "merged") {
          const existing = experiment?.["metrics"]?.find((m: any) => m.taskId === mr.taskId);
          if (existing && !existing.postMergeTestPass) {
            replay[mr.taskId] = (replay[mr.taskId] || 0) + 1;
          }
        }
      }
      if (Object.keys(replay).length > 0) {
        require("fs").mkdirSync(`${repoPath}/.fsc`, { recursive: true });
        require("fs").writeFileSync(replayPath, JSON.stringify(replay, null, 2));
        console.log(`[ReplayLog] ${Object.keys(replay).length} tasks in regression replay buffer`);
      }
    }

    // Save A/B experiment results if running
    if (experiment) {
      experiment.save(`${repoPath}/.fsc`);
    }

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
      zeroRegressionRate: mergedCount > 0 ? zeroRegressionCount / mergedCount : undefined,
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

  /** Retry all failed tasks, prioritized by inverse-frequency replay (MEMO-inspired) */
  async retryFailed(repoPath?: string): Promise<SchedulerReport> {
    const failed = this.stateStore.getFailedTasks();

    // Sort by regression replay count (most failures first = highest priority)
    let replay: Record<string, number> = {};
    if (repoPath) {
      try { replay = JSON.parse(require("fs").readFileSync(`${repoPath}/.fsc/regression-replay.json`, "utf-8")); } catch {}
    }
    const sorted = [...failed].sort((a, b) => (replay[b.taskId] || 0) - (replay[a.taskId] || 0));

    for (const f of sorted) {
      this.stateStore.markForRetry(f.taskId);
    }
    if (Object.keys(replay).length > 0) {
      console.log(`[RetryFailed] Prioritized by replay count: ${sorted.slice(0, 3).map(f => `${f.taskId}(${replay[f.taskId] || 0})`).join(', ')}`);
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
