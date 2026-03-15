// packages/core/src/execution/collector.ts
import { readFileSync } from "fs";
import path from "path";
import type { Task, TaskResult } from "../task";
import { validateResult, toTaskResult } from "./mapping";
import { WorktreeManager } from "./worktree";

const RESULT_FILE = ".fsc/result.json";

export class WorktreeCollector {
  private manager: WorktreeManager;

  constructor(manager?: WorktreeManager) {
    this.manager = manager ?? new WorktreeManager();
  }

  /**
   * Collect results from all FSC-managed worktrees.
   * Reads .fsc/result.json from each worktree, validates, and maps to TaskResult.
   * Worktrees without a result file are silently skipped.
   */
  collectAll(repoPath: string, tasks: Task[]): TaskResult[] {
    const worktrees = this.manager.list(repoPath);
    const taskMap = new Map(tasks.map(t => [t.ID, t]));
    const results: TaskResult[] = [];

    for (const wt of worktrees) {
      const resultPath = path.join(wt.worktreePath, RESULT_FILE);
      const raw = readJsonFile(resultPath);
      if (raw === null) continue;

      let er;
      try {
        er = validateResult(raw);
      } catch {
        continue;
      }

      const task = taskMap.get(wt.taskId);
      if (!task) continue;

      results.push(toTaskResult(er, task));
    }

    return results;
  }

  /**
   * Collect results and print formatted output with diff stats to stdout.
   */
  collectInteractive(repoPath: string, tasks: Task[]): TaskResult[] {
    const worktrees = this.manager.list(repoPath);
    const taskMap = new Map(tasks.map(t => [t.ID, t]));
    const results: TaskResult[] = [];

    console.log(`\nCollecting results from ${worktrees.length} worktree(s)...\n`);

    for (const wt of worktrees) {
      const resultPath = path.join(wt.worktreePath, RESULT_FILE);
      const raw = readJsonFile(resultPath);

      if (raw === null) {
        console.log(`  [SKIP] ${wt.branch} — no result file`);
        continue;
      }

      let er;
      try {
        er = validateResult(raw);
      } catch (e) {
        console.log(`  [INVALID] ${wt.branch} — ${(e as Error).message}`);
        continue;
      }

      const task = taskMap.get(wt.taskId);
      if (!task) {
        console.log(`  [ORPHAN] ${wt.branch} — no matching task`);
        continue;
      }

      const tr = toTaskResult(er, task);
      results.push(tr);

      const filesChanged = er.filesChanged?.length ?? 0;
      const commitInfo = er.commitHash ? `commit ${er.commitHash.slice(0, 8)}` : "no commit";
      console.log(`  [${er.status.toUpperCase()}] ${wt.branch} — ${filesChanged} file(s) changed, ${commitInfo}`);
    }

    console.log(`\nCollected ${results.length} result(s).\n`);
    return results;
  }
}

function readJsonFile(filePath: string): unknown {
  try {
    const content = readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}
