import path from "path";
import { WorktreeManager } from "./worktree";
import { gitExec } from "./gitExec";
import type { WorktreeInfo } from "./types";

/**
 * WorktreePool — fixed-size pool of reusable git worktrees.
 *
 * Instead of creating 1000 worktrees, maintain 16-48 that get
 * leased to tasks and recycled after completion.
 */
export class WorktreePool {
  private manager: WorktreeManager;
  private available: WorktreeInfo[] = [];
  private leased: Map<string, WorktreeInfo> = new Map(); // taskId → worktree
  private poolSize: number;
  private repoPath: string;
  private baseBranch: string;
  private initialized = false;
  private waitQueue: Array<(wt: WorktreeInfo) => void> = [];

  constructor(repoPath: string, baseBranch: string, poolSize: number = 24) {
    this.manager = new WorktreeManager();
    this.repoPath = path.resolve(repoPath);
    this.baseBranch = baseBranch;
    this.poolSize = poolSize;
  }

  /** Initialize pool — create all worktrees upfront (serialized) */
  async init(): Promise<void> {
    if (this.initialized) return;
    console.log(`[WorktreePool] Initializing ${this.poolSize} worktrees...`);
    for (let i = 0; i < this.poolSize; i++) {
      const slotId = `pool-${String(i).padStart(3, "0")}`;
      const info = await this.manager.create(this.repoPath, this.baseBranch, slotId);
      this.available.push(info);
    }
    this.initialized = true;
    console.log(`[WorktreePool] Ready: ${this.poolSize} worktrees`);
  }

  /** Lease a worktree for a task. Blocks if none available. */
  async lease(taskId: string): Promise<WorktreeInfo> {
    // If available, take one
    if (this.available.length > 0) {
      const wt = this.available.pop()!;
      this.leased.set(taskId, wt);
      return wt;
    }
    // Otherwise wait for one to be released
    return new Promise<WorktreeInfo>((resolve) => {
      this.waitQueue.push((wt) => {
        this.leased.set(taskId, wt);
        resolve(wt);
      });
    });
  }

  /** Release a worktree back to pool after task completion. Resets to clean state. */
  async release(taskId: string): Promise<void> {
    const wt = this.leased.get(taskId);
    if (!wt) return;
    this.leased.delete(taskId);

    // Reset worktree to clean state
    gitExec(["checkout", this.baseBranch], wt.worktreePath);
    gitExec(["reset", "--hard", this.baseBranch], wt.worktreePath);
    gitExec(["clean", "-fd"], wt.worktreePath);

    // Delete the task branch if it exists
    const taskBranch = `fsc/${taskId}`;
    gitExec(["branch", "-D", taskBranch], this.repoPath);

    // Hand to waiting task or return to available
    const waiter = this.waitQueue.shift();
    if (waiter) {
      waiter(wt);
    } else {
      this.available.push(wt);
    }
  }

  /** Prepare a leased worktree for a specific task (create task branch) */
  async prepareForTask(taskId: string): Promise<string> {
    const wt = this.leased.get(taskId);
    if (!wt) throw new Error(`No leased worktree for task ${taskId}`);

    const branch = `fsc/${taskId}`;
    gitExec(["checkout", "-b", branch], wt.worktreePath);
    return branch;
  }

  /** Get pool stats */
  stats(): { total: number; available: number; leased: number; waiting: number } {
    return {
      total: this.poolSize,
      available: this.available.length,
      leased: this.leased.size,
      waiting: this.waitQueue.length,
    };
  }

  /** Destroy the entire pool — remove all worktrees */
  async destroy(): Promise<void> {
    // Release all leased first
    for (const [taskId] of this.leased) {
      await this.release(taskId);
    }
    // Remove all worktrees and their slot branches
    for (const wt of this.available) {
      gitExec(["worktree", "remove", "--force", wt.worktreePath], this.repoPath);
      gitExec(["branch", "-D", wt.branch], this.repoPath);
    }
    this.available = [];
    this.initialized = false;
    console.log("[WorktreePool] Destroyed");
  }
}
