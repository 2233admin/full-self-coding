// packages/core/src/execution/local.ts
import { spawn, type Subprocess } from "bun";
import path from "path";
import fs from "fs";
import { gitExec } from "./gitExec";
import { WorktreeManager } from "./worktree";
import type { ExecutionStrategy } from "./strategy";
import type { WorkUnit, ExecutionResult, ExecutionStatus } from "./types";

const FSC_AUTHOR = "FSC Worker <fsc@full-self-coding>";

export class LocalExecution implements ExecutionStrategy {
  private worktreeManager: WorktreeManager;
  private running: Map<string, Subprocess> = new Map();
  private statuses: Map<string, ExecutionStatus> = new Map();

  constructor(worktreeManager: WorktreeManager) {
    this.worktreeManager = worktreeManager;
  }

  async execute(unit: WorkUnit): Promise<ExecutionResult> {
    const startedAt = Date.now();
    this.statuses.set(unit.id, "running");

    // 1. Create worktree (serialized via mutex inside WorktreeManager)
    const { worktreePath, branch } = await this.worktreeManager.create(
      unit.repoPath, unit.baseBranch, unit.id,
    );

    // 2. Write .fsc/current-task.md
    const fscDir = path.resolve(worktreePath, ".fsc");
    fs.mkdirSync(fscDir, { recursive: true });
    fs.writeFileSync(path.resolve(fscDir, "current-task.md"), unit.taskPrompt);

    // 3. Build command
    const args = unit.agentConfig.buildArgs(unit.taskPrompt, worktreePath);
    const cmd = [unit.agentConfig.command, ...args];

    // 4. Spawn agent process
    let timedOut = false;
    let exitCode: number | null = null;
    let stdoutChunks: string[] = [];
    let stderrChunks: string[] = [];

    try {
      const proc = spawn({
        cmd,
        cwd: worktreePath,
        env: {
          ...process.env,
          ...unit.agentConfig.env,
          FSC_TASK_ID: unit.id,
          FSC_WORKTREE: worktreePath,
          ...(unit.context?.memorixUri ? { MEMORIX_URL: unit.context.memorixUri } : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      this.running.set(unit.id, proc);

      // Race process completion against timeout
      const timeoutPromise = new Promise<void>(resolve => {
        setTimeout(() => {
          timedOut = true;
          try { proc.kill(); } catch {}
          resolve();
        }, unit.constraints.timeoutMs);
      });

      const processPromise = (async () => {
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        stdoutChunks = stdout.split("\n");
        stderrChunks = stderr.split("\n");
        await proc.exited;
        exitCode = proc.exitCode;
      })();

      await Promise.race([processPromise, timeoutPromise]);

      // If timed out, give the process a moment then move on
      if (timedOut) {
        // Allow a short grace period for kill to take effect
        await new Promise(r => setTimeout(r, 200));
      }
    } catch (e: any) {
      if (!timedOut) {
        stderrChunks.push(e?.message || String(e));
      }
    } finally {
      this.running.delete(unit.id);
    }

    // 5. Auto-commit if agent left uncommitted changes (exclude .fsc/ dir)
    const commitHash = this.autoCommitIfNeeded(worktreePath, unit.id, unit.baseBranch);

    // 6. Collect files changed
    const filesChanged = this.getFilesChanged(worktreePath, unit.baseBranch);

    // 7. Build result
    const completedAt = Date.now();
    const logs = [...stdoutChunks, ...stderrChunks]
      .filter(Boolean)
      .slice(-100);  // Cap at 100 lines

    const status = timedOut
      ? "timeout" as const
      : (exitCode === 0 ? "success" as const : "failure" as const);

    const result: ExecutionResult = {
      workUnitId: unit.id,
      status,
      commitHash,
      branch,
      worktreePath,
      startedAt,
      completedAt,
      agent: { type: unit.agentConfig.type },
      filesChanged,
      logs,
      error: status !== "success" ? {
        message: timedOut
          ? `Timeout after ${unit.constraints.timeoutMs}ms`
          : `Exit code ${exitCode}`,
        category: timedOut ? "TRANSIENT" : "UNKNOWN",
      } : undefined,
    };

    // 8. Write .fsc/result.json
    fs.writeFileSync(
      path.resolve(fscDir, "result.json"),
      JSON.stringify(result, null, 2),
    );

    this.statuses.set(unit.id, status === "success" ? "completed" : "failed");
    return result;
  }

  async abort(unitId: string): Promise<void> {
    const proc = this.running.get(unitId);
    if (proc) {
      proc.kill("SIGTERM");
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
      }, 5000);
    }
    this.statuses.set(unitId, "aborted");
  }

  getStatus(unitId: string): ExecutionStatus {
    return this.statuses.get(unitId) ?? "pending";
  }

  /** Get running processes map (for signal handler cleanup) */
  getRunning(): Map<string, Subprocess> {
    return this.running;
  }

  private autoCommitIfNeeded(
    worktreePath: string,
    taskId: string,
    baseBranch: string,
  ): string | null {
    // Check for uncommitted changes (exclude .fsc/ which is FSC internal)
    const status = gitExec(["status", "--porcelain", "--", ":(exclude).fsc"], worktreePath);
    if (status.stdout.trim()) {
      // Auto-commit (add everything except .fsc/)
      gitExec(["add", "-A", "--", ":(exclude).fsc"], worktreePath);
      const commitResult = gitExec(
        ["commit", "--author", FSC_AUTHOR, "-m", `auto: ${taskId} completion`],
        worktreePath,
      );
      if (commitResult.exitCode !== 0) {
        return null;  // commit failed
      }
    }

    // Check if there are any new commits vs base
    const diff = gitExec(
      ["log", "--oneline", `${baseBranch}..HEAD`],
      worktreePath,
    );
    if (!diff.stdout.trim()) {
      return null;  // No new commits
    }

    // Get HEAD commit hash
    const head = gitExec(["rev-parse", "HEAD"], worktreePath);
    return head.stdout.trim() || null;
  }

  private getFilesChanged(worktreePath: string, baseBranch: string): string[] {
    const diff = gitExec(
      ["diff", "--name-only", `${baseBranch}...HEAD`],
      worktreePath,
    );
    return diff.stdout.trim().split("\n").filter(Boolean);
  }
}
