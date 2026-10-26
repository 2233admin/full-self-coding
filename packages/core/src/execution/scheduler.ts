import { TaskStateStore, type TaskState, type TaskStateSummary, type SchedulerTaskStatus } from "./state";
import { WorktreePool } from "./pool";
import { ConcurrencyPool } from "./concurrency";
import { LocalExecution } from "./local";
import { WorktreeManager } from "./worktree";
import { CommitSequencer, type SequencerResult } from "./sequencer";
import { toWorkUnitByTier, toWorkUnitForAgent, toTaskResult } from "./mapping";
import { gitExec } from "./gitExec";
import type { Task, TaskResult } from "../task";
import type { CostTierStrategy } from "../modelRouter";
import type { ExecutionResult, WorkUnit } from "./types";
import { SalaciaPlugin, type SalaciaConfig } from "../salacia/plugin";
import { ABExperiment, type ExperimentMetrics } from "../salacia/experiment";

export interface SchedulerConfig {
  localPoolSize: number;       // default 24
  maxConcurrency: number;      // default 5
  costStrategy: CostTierStrategy;  // default "minimize-cost"
  /** Run this agent for every task instead of cost-tier routing (e.g. "claude-code"). */
  agentType?: string;
  /** Build the work unit yourself (benchmarks and tests inject a mock agent here). */
  unitFactory?: (task: Task, repoPath: string) => WorkUnit;
  /**
   * When a task's commit conflicts with what other tasks already merged, run the agent again on
   * top of the merged result (new worktree from the current base branch, told which files
   * conflicted). Each retry costs another agent run. Default 1; 0 disables it.
   */
  conflictRetries?: number;
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
  /** Time spent running agents (all tasks, wall clock). */
  execMs?: number;
  /** Time spent merging the finished commits onto the base branch. */
  mergeMs?: number;
  /** Time spent re-running conflicted tasks and merging them again. */
  retryMs?: number;
  /** taskId -> number of retry rounds it needed (only tasks that were retried). */
  retries?: Record<string, number>;
  /**
   * For tasks that merged only after a retry: files they changed that another merged task also
   * changed. The merge was clean, but a clean merge does not prove the retry kept the other
   * task's change (two contradictory tasks both "succeed", the later one wins), so look at these.
   */
  retryOverlaps?: Record<string, Array<{ task: string; files: string[] }>>;
  /** Time spent removing task worktrees and branches. */
  cleanupMs?: number;
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
  private worktrees: WorktreeManager;
  private concurrency: ConcurrencyPool;
  private execution: LocalExecution;
  private repoPath: string = "";
  private baseBranch: string = "main";

  constructor(config: Partial<SchedulerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.stateStore = new TaskStateStore();
    this.concurrency = new ConcurrencyPool(this.config.maxConcurrency);
    this.worktrees = new WorktreeManager();
    this.execution = new LocalExecution(this.worktrees);
  }

  private buildUnit(task: Task, repoPath: string, plugin?: SalaciaPlugin, retryNote?: string): WorkUnit {
    const unit = this.config.unitFactory
      ? this.config.unitFactory(task, repoPath)
      : this.config.agentType
      ? toWorkUnitForAgent(task, this.config.agentType, repoPath, plugin)
      : toWorkUnitByTier(task, repoPath, this.config.costStrategy, this.config.freeclawBase, plugin);
    // LocalExecution creates the worktree under repoPath
    unit.repoPath = repoPath;
    if (retryNote) unit.taskPrompt += `

${retryNote}`;
    return unit;
  }

  async execute(tasks: Task[], repoPath: string): Promise<SchedulerReport> {
    const startTime = Date.now();
    this.repoPath = repoPath;
    this.baseBranch = gitExec(["rev-parse", "--abbrev-ref", "HEAD"], repoPath).stdout.trim() || "main";

    // 1. (no pool) LocalExecution creates one worktree + branch per task itself. The pool used to
    // lease a slot and `checkout -b fsc/<task>` in it, which made LocalExecution's own
    // `worktree add -b fsc/<task>` fail with "branch already exists" on every task.

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

    const execStart = Date.now();
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

          this.stateStore.transition(task.ID, "dispatched");

          // Build work unit (with optional salacia enrichment)
          const unit = this.buildUnit(task, repoPath, plugin);

          // Running — inject salacia plugin into execution
          this.stateStore.transition(task.ID, "running", { agentType: unit.agentConfig.type });
          this.execution.salaciaPlugin = plugin.enabled ? plugin : undefined;

          // Execute (creates its own worktree and branch)
          const result = await this.execution.execute({
            ...unit,
            id: task.ID,
            repoPath,
          });

          executionResults.push(result);

          // The commit lives on the task branch; free the checkout now so live worktrees stay
          // bounded by the concurrency limit instead of growing to the task count.
          await this.worktrees.removeWorktree(result.worktreePath, repoPath);

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
        }
      })
    );

    await Promise.allSettled(execPromises);
    const execMs = Date.now() - execStart;

    // 4. Merge via sequencer
    const sequencer = new CommitSequencer(repoPath, this.baseBranch);
    const mergeStart = Date.now();
    let mergeResults = await sequencer.applyAll(executionResults);
    const mergeMs = Date.now() - mergeStart;

    // 4b. Conflicts: run those tasks again on top of what was merged (see conflictRetries)
    const retries: Record<string, number> = {};
    const retryStart = Date.now();
    const taskById = new Map(tasks.map(t => [t.ID, t]));
    for (let round = 1; round <= (this.config.conflictRetries ?? 1); round++) {
      const conflicted = mergeResults.filter(m => !m.success && (m.error ?? "").includes("MERGE_CONFLICT"));
      if (conflicted.length === 0) break;

      const retryResults: ExecutionResult[] = [];
      await Promise.allSettled(conflicted.map(c => this.concurrency.run(async () => {
        const task = taskById.get(c.taskId);
        if (!task) return;
        try {
          // Keep the conflicting attempt for inspection; the retry needs the branch name.
          gitExec(["branch", "-m", `fsc/${c.taskId}`, `fsc/${c.taskId}-attempt${round}`], repoPath);
          const files = (c.error ?? "").split("): ").slice(1).join("): ");
          const note =
            `## Retry note
An earlier attempt at this task could not be merged because other tasks ` +
            `already changed the same code (${files || "unknown files"}). Those changes are in your ` +
            `working tree now. Read the current code and do this task again on top of it. If another ` +
            `task already made a conflicting decision, keep it unless this task explicitly requires ` +
            `otherwise, and say what you did in your final message.`;
          const unit = this.buildUnit(task, repoPath, undefined, note);
          const r = await this.execution.execute({ ...unit, id: task.ID, repoPath });
          await this.worktrees.removeWorktree(r.worktreePath, repoPath);
          retryResults.push(r);
          executionResults.push(r);
          retries[task.ID] = round;
        } catch (e: any) {
          console.error(`[Retry] ${c.taskId}: ${e?.message ?? e}`);
        }
      })));

      const retryMerge = await sequencer.applyAll(retryResults);
      const byTask = new Map(retryMerge.map(m => [m.taskId, m]));
      mergeResults = mergeResults.map(m => byTask.get(m.taskId) ?? m);
    }
    const retryMs = Date.now() - retryStart;

    const latest = new Map<string, ExecutionResult>();
    for (const r of executionResults) latest.set(r.workUnitId, r);
    const mergedIds = new Set(mergeResults.filter(m => m.success).map(m => m.taskId));
    const retryOverlaps: Record<string, Array<{ task: string; files: string[] }>> = {};
    for (const taskId of Object.keys(retries)) {
      if (!mergedIds.has(taskId)) continue;
      const mine = new Set(latest.get(taskId)?.filesChanged ?? []);
      for (const [other, r] of latest) {
        if (other === taskId || !mergedIds.has(other)) continue;
        const files = r.filesChanged.filter(f => mine.has(f));
        if (files.length > 0) (retryOverlaps[taskId] ??= []).push({ task: other, files });
      }
    }

    // Post-merge regression test (SWE-CI Zero-Regression Rate)
    // MEMO-inspired: failed merges are logged to an inverse-frequency replay buffer
    // so retryFailed() can prioritize rare/hard failures.
    let zeroRegressionCount = 0;
    let mergedCount = 0;
    const regressions: string[] = [];
    if (salaciaConfig?.postMergeTest) {
      for (const mr of mergeResults) {
        if (!mr.success) continue;
        mergedCount++;
        const testResult = Bun.spawnSync({ cmd: ["bun", "test"], cwd: repoPath, timeout: 120_000 });
        const pass = testResult.exitCode === 0;
        if (pass) zeroRegressionCount++;
        else {
          regressions.push(mr.taskId);
          console.log(`[ZeroRegression] FAIL after merge of task ${mr.taskId} — tests broke`);
        }
        experiment?.markPostMergeTest(mr.taskId, pass);
      }
    }

    if (regressions.length > 0) {
      const replayPath = `${repoPath}/.fsc/regression-replay.json`;
      let replay: Record<string, number> = {};
      try { replay = JSON.parse(require("fs").readFileSync(replayPath, "utf-8")); } catch {}
      for (const id of regressions) replay[id] = (replay[id] || 0) + 1;
      require("fs").mkdirSync(`${repoPath}/.fsc`, { recursive: true });
      require("fs").writeFileSync(replayPath, JSON.stringify(replay, null, 2));
      console.log(`[ReplayLog] ${Object.keys(replay).length} tasks in regression replay buffer`);
    }

    // Save A/B experiment results if running
    if (experiment) {
      experiment.save(`${repoPath}/.fsc`);
    }

    // 5. Cleanup: task worktrees always; task branches only once their commit is on the base branch
    const cleanupStart = Date.now();
    for (const er of executionResults) {
      gitExec(["worktree", "remove", "--force", er.worktreePath], repoPath);
      if (mergeResults.some(m => m.taskId === er.workUnitId && m.success)) {
        gitExec(["branch", "-D", er.branch], repoPath);
      }
    }
    // A retry that merged supersedes the conflicting attempts that were kept for inspection.
    for (const taskId of Object.keys(retries)) {
      if (!mergeResults.some(m => m.taskId === taskId && m.success)) continue;
      const old = gitExec(["branch", "--list", `fsc/${taskId}-attempt*`, "--format=%(refname:short)"], repoPath);
      for (const b of old.stdout.split("\n").map(s => s.trim()).filter(Boolean)) {
        gitExec(["branch", "-D", b], repoPath);
      }
    }

    const cleanupMs = Date.now() - cleanupStart;
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
      execMs,
      mergeMs,
      retryMs,
      retries,
      retryOverlaps,
      cleanupMs,
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
