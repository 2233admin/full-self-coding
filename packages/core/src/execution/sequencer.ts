import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { gitExec } from "./gitExec";
import type { ExecutionResult } from "./types";
import { parseConflictMarkers, hasContentfulCanonical, resolveKeepIncoming } from "../utils/conflictParser";
import { looksLikeProse } from "../utils/proseDetector";

export interface SequencerResult {
  taskId: string;
  success: boolean;
  commitHash?: string;
  error?: string;
  /** Which merge tier resolved this (1-4), undefined if no conflict */
  resolvedTier?: number;
}

interface MergeHistoryEntry {
  tier: number;
  success: boolean;
  timestamp: number;
}

type MergeHistory = Record<string, MergeHistoryEntry[]>;

/**
 * CommitSequencer — serialized commit merging with 4-tier conflict resolution.
 *
 * Workers produce commits on task branches. The sequencer cherry-picks
 * them one-by-one onto the target branch. On conflict, it escalates
 * through 4 tiers instead of aborting:
 *
 *   Tier 1: Clean cherry-pick (no conflict)
 *   Tier 2: Keep-incoming with contentful-canonical guard
 *   Tier 3: AI resolve via modelRouter (not yet wired — placeholder)
 *   Tier 4: Reimagine — abort + AI rewrite per file (not yet wired)
 */
export class CommitSequencer {
  private repoPath: string;
  private targetBranch: string;
  private results: SequencerResult[] = [];
  private historyPath: string;

  constructor(repoPath: string, targetBranch: string) {
    this.repoPath = repoPath;
    this.targetBranch = targetBranch;
    this.historyPath = join(repoPath, ".fsc", "merge-history.json");
  }

  /**
   * Cherry-pick a single task's commit onto target branch.
   * On conflict, escalates through 4 tiers of resolution.
   */
  async apply(execResult: ExecutionResult): Promise<SequencerResult> {
    const { workUnitId, commitHash, branch } = execResult;

    if (!commitHash) {
      const r: SequencerResult = { taskId: workUnitId, success: true, error: "no changes" };
      this.results.push(r);
      return r;
    }

    const checkError = this.preMergeChecks(commitHash);
    if (checkError) {
      if (checkError.includes("already in history")) {
        const r: SequencerResult = { taskId: workUnitId, success: true, commitHash, error: "already merged" };
        this.results.push(r);
        return r;
      }
      const r: SequencerResult = { taskId: workUnitId, success: false, error: checkError };
      this.results.push(r);
      return r;
    }

    gitExec(["checkout", this.targetBranch], this.repoPath);

    // Tier 1: Clean cherry-pick
    const pick = gitExec(["cherry-pick", commitHash], this.repoPath);
    if (pick.exitCode === 0) {
      const newHash = gitExec(["rev-parse", "HEAD"], this.repoPath).stdout.trim();
      const r: SequencerResult = { taskId: workUnitId, success: true, commitHash: newHash, resolvedTier: 1 };
      this.results.push(r);
      return r;
    }

    // Conflict detected — get conflicted files
    const conflictFiles = this.getConflictedFiles();
    if (conflictFiles.length === 0) {
      // Non-conflict failure (e.g., empty commit)
      gitExec(["cherry-pick", "--abort"], this.repoPath);
      const r: SequencerResult = {
        taskId: workUnitId, success: false, commitHash,
        error: `cherry-pick failed (not a conflict): ${pick.stderr.slice(0, 200)}`,
      };
      this.results.push(r);
      return r;
    }

    // Tier 2: Keep-incoming with contentful-canonical guard
    const tier2Result = this.tier2KeepIncoming(conflictFiles);
    if (tier2Result.success) {
      gitExec(["add", "-A"], this.repoPath);
      gitExec(["cherry-pick", "--continue", "--no-edit"], this.repoPath);
      const newHash = gitExec(["rev-parse", "HEAD"], this.repoPath).stdout.trim();
      this.recordHistory(conflictFiles, 2, true);
      const r: SequencerResult = { taskId: workUnitId, success: true, commitHash: newHash, resolvedTier: 2 };
      this.results.push(r);
      console.log(`  [Tier 2] Resolved ${conflictFiles.length} conflicts via keep-incoming`);
      return r;
    }

    // Tier 2 failed (contentful canonical detected) — need Tier 3/4
    // For now, abort and report. Tier 3 (AI resolve) and Tier 4 (reimagine)
    // require modelRouter integration — wired separately.
    this.recordHistory(conflictFiles, 2, false);
    gitExec(["cherry-pick", "--abort"], this.repoPath);

    const guide = this.conflictGuide(workUnitId, commitHash, branch);
    console.log(guide);
    console.log(`  [Tier 2] Failed: ${tier2Result.blockers.length} files have contentful canonical side`);

    const r: SequencerResult = {
      taskId: workUnitId, success: false, commitHash,
      error: `MERGE_CONFLICT (tier2 blocked): ${tier2Result.blockers.join(", ")}`,
    };
    this.results.push(r);
    return r;
  }

  /**
   * Apply multiple results sequentially. Order matters for conflict avoidance.
   */
  async applyAll(results: ExecutionResult[]): Promise<SequencerResult[]> {
    const sorted = [...results]
      .filter(r => r.commitHash)
      .sort((a, b) => a.workUnitId.localeCompare(b.workUnitId));

    console.log(`[Sequencer] Applying ${sorted.length} commits to ${this.targetBranch}...`);

    const sequencerResults: SequencerResult[] = [];
    for (const result of sorted) {
      const sr = await this.apply(result);
      sequencerResults.push(sr);
      const icon = sr.success ? "✅" : "❌";
      const tier = sr.resolvedTier ? ` (tier ${sr.resolvedTier})` : "";
      console.log(`  ${icon} ${sr.taskId}${tier}: ${sr.error ?? sr.commitHash}`);
    }

    const succeeded = sequencerResults.filter(r => r.success).length;
    const failed = sequencerResults.filter(r => !r.success).length;
    console.log(`[Sequencer] Done: ${succeeded} merged, ${failed} failed`);

    return sequencerResults;
  }

  // ── Tier 2: Keep-Incoming ──────────────────────────────────────

  private tier2KeepIncoming(conflictFiles: string[]): { success: boolean; blockers: string[] } {
    const blockers: string[] = [];

    for (const file of conflictFiles) {
      const filePath = join(this.repoPath, file);
      if (!existsSync(filePath)) continue;

      const content = readFileSync(filePath, "utf-8");
      const chunks = parseConflictMarkers(content);

      // If any chunk has contentful canonical, this file blocks Tier 2
      const hasContentful = chunks.some(c => hasContentfulCanonical(c));
      if (hasContentful) {
        blockers.push(file);
        continue;
      }

      // Safe to keep incoming
      const resolved = resolveKeepIncoming(content);
      writeFileSync(filePath, resolved, "utf-8");
    }

    return { success: blockers.length === 0, blockers };
  }

  // ── Conflict Detection ─────────────────────────────────────────

  private getConflictedFiles(): string[] {
    const status = gitExec(["diff", "--name-only", "--diff-filter=U"], this.repoPath);
    return status.stdout.trim().split("\n").filter(Boolean);
  }

  // ── Merge History ──────────────────────────────────────────────

  private recordHistory(files: string[], tier: number, success: boolean): void {
    const history = this.loadHistory();
    const entry: MergeHistoryEntry = { tier, success, timestamp: Date.now() };

    for (const file of files) {
      if (!history[file]) history[file] = [];
      history[file].push(entry);
      // Keep last 20 entries per file
      if (history[file].length > 20) history[file] = history[file].slice(-20);
    }

    this.saveHistory(history);
  }

  /**
   * Determine which tier to start from based on history.
   * Skip tiers that have failed ≥2 times with zero successes.
   */
  getEffectiveStartTier(filePath: string): number {
    const history = this.loadHistory();
    const entries = history[filePath];
    if (!entries?.length) return 1;

    for (let tier = 1; tier <= 4; tier++) {
      const tierEntries = entries.filter(e => e.tier === tier);
      const successes = tierEntries.filter(e => e.success).length;
      const failures = tierEntries.filter(e => !e.success).length;
      if (failures >= 2 && successes === 0) continue; // skip this tier
      return tier;
    }
    return 4; // fallback to last resort
  }

  private loadHistory(): MergeHistory {
    if (!existsSync(this.historyPath)) return {};
    try {
      return JSON.parse(readFileSync(this.historyPath, "utf-8"));
    } catch {
      return {};
    }
  }

  private saveHistory(history: MergeHistory): void {
    const dir = dirname(this.historyPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.historyPath, JSON.stringify(history, null, 2), "utf-8");
  }

  // ── Safety Checks ──────────────────────────────────────────────

  private preMergeChecks(commitHash: string): string | null {
    const status = gitExec(["status", "--porcelain"], this.repoPath);
    if (status.stdout.trim()) return "working tree is dirty";

    const exists = gitExec(["cat-file", "-t", commitHash], this.repoPath);
    if (exists.exitCode !== 0) return `commit ${commitHash} does not exist`;

    const ancestor = gitExec(["merge-base", "--is-ancestor", commitHash, "HEAD"], this.repoPath);
    if (ancestor.exitCode === 0) return `${commitHash} already in history`;

    return null;
  }

  private conflictGuide(taskId: string, commitHash: string, branch: string): string {
    return [
      "",
      "╔═══════════════════════════════════════════════════╗",
      `║  MERGE CONFLICT: ${taskId.padEnd(33)}║`,
      "╠═══════════════════════════════════════════════════╣",
      "║  To resolve:                                      ║",
      `║    cd ${this.repoPath}`,
      `║    git cherry-pick ${commitHash}`,
      "║    # fix conflicts                                ║",
      "║    git add -A && git cherry-pick --continue       ║",
      "║                                                   ║",
      "║  To skip:                                         ║",
      "║    git cherry-pick --abort                        ║",
      "║                                                   ║",
      "║  To review:                                       ║",
      `║    git diff ${this.targetBranch}...${branch}`,
      "╚═══════════════════════════════════════════════════╝",
      "",
    ].join("\n");
  }

  getResults(): SequencerResult[] {
    return [...this.results];
  }
}
