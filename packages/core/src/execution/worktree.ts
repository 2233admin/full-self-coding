// packages/core/src/execution/worktree.ts
import path from "path";
import { gitExec } from "./gitExec";
import type { WorktreeInfo } from "./types";

/**
 * Simple async mutex — serializes git worktree operations to avoid index.lock conflicts.
 */
class AsyncMutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(timeoutMs = 30_000): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.indexOf(onRelease);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new Error(`Worktree creation lock timeout (${timeoutMs}ms)`));
      }, timeoutMs);

      const onRelease = () => {
        clearTimeout(timer);
        resolve();
      };
      this.queue.push(onRelease);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

export class WorktreeManager {
  private mutex = new AsyncMutex();

  /**
   * Create a git worktree as a sibling directory.
   * Path: [parent]/[repoName]-fsc-[taskId]
   * Branch: fsc/[taskId]
   * SERIALIZED via mutex to avoid index.lock conflicts.
   */
  async create(repoPath: string, baseBranch: string, taskId: string): Promise<WorktreeInfo> {
    await this.mutex.acquire(30_000);
    try {
      const resolvedRepo = path.resolve(repoPath);
      const repoName = path.basename(resolvedRepo);
      const parentDir = path.dirname(resolvedRepo);
      const worktreePath = path.resolve(parentDir, `${repoName}-fsc-${taskId}`);
      const branch = `fsc/${taskId}`;

      const result = gitExec(
        ["worktree", "add", "-b", branch, worktreePath, baseBranch],
        resolvedRepo,
      );

      if (result.exitCode !== 0) {
        throw new Error(`git worktree add failed: ${result.stderr}`);
      }

      return { worktreePath, branch, taskId };
    } finally {
      this.mutex.release();
    }
  }

  /**
   * Remove a worktree and its branch.
   */
  async remove(worktreePath: string, repoPath: string): Promise<void> {
    await this.mutex.acquire(30_000);
    try {
      const resolvedWt = path.resolve(worktreePath);
      const resolvedRepo = path.resolve(repoPath);

      // Remove worktree
      gitExec(["worktree", "remove", "--force", resolvedWt], resolvedRepo);

      // Delete branch
      const branchName = this.getBranchFromPath(resolvedWt, resolvedRepo);
      if (branchName) {
        gitExec(["branch", "-D", branchName], resolvedRepo);
      }
    } finally {
      this.mutex.release();
    }
  }

  /**
   * List all FSC-managed worktrees (branches starting with fsc/).
   */
  list(repoPath: string): WorktreeInfo[] {
    const resolvedRepo = path.resolve(repoPath);
    const result = gitExec(["worktree", "list", "--porcelain"], resolvedRepo);
    if (result.exitCode !== 0) return [];

    const worktrees: WorktreeInfo[] = [];
    const blocks = result.stdout.split("\n\n").filter(Boolean);

    for (const block of blocks) {
      const lines = block.split("\n");
      const wtLine = lines.find(l => l.startsWith("worktree "));
      const branchLine = lines.find(l => l.startsWith("branch "));

      if (!wtLine || !branchLine) continue;
      const wtPath = wtLine.replace("worktree ", "").trim();
      const fullBranch = branchLine.replace("branch refs/heads/", "").trim();

      if (fullBranch.startsWith("fsc/")) {
        const taskId = fullBranch.replace("fsc/", "");
        worktrees.push({ worktreePath: wtPath, branch: fullBranch, taskId });
      }
    }

    return worktrees;
  }

  /**
   * Remove all FSC worktrees and branches.
   */
  cleanup(repoPath: string): void {
    const resolvedRepo = path.resolve(repoPath);
    const worktrees = this.list(resolvedRepo);

    for (const wt of worktrees) {
      gitExec(["worktree", "remove", "--force", wt.worktreePath], resolvedRepo);
      gitExec(["branch", "-D", wt.branch], resolvedRepo);
    }

    gitExec(["worktree", "prune"], resolvedRepo);
  }

  /**
   * Preflight checks: git version, agent CLI availability.
   */
  preflight(repoPath: string, agentCommands: string[]): string[] {
    const errors: string[] = [];
    const resolvedRepo = path.resolve(repoPath);

    const ver = gitExec(["--version"], resolvedRepo);
    if (ver.exitCode !== 0) {
      errors.push("git is not installed or not in PATH");
    }

    for (const cmd of agentCommands) {
      const which = Bun.spawnSync({
        cmd: process.platform === "win32" ? ["where", cmd] : ["which", cmd],
        cwd: resolvedRepo,
      });
      if (which.exitCode !== 0) {
        errors.push(`Agent CLI not found: ${cmd}`);
      }
    }

    return errors;
  }

  private getBranchFromPath(worktreePath: string, repoPath: string): string | null {
    const list = this.list(repoPath);
    const match = list.find(w => path.resolve(w.worktreePath) === path.resolve(worktreePath));
    return match?.branch ?? null;
  }
}
