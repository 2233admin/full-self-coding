import { gitExec } from "./gitExec";
import type { ExecutionResult } from "./types";

export interface SequencerResult {
  taskId: string;
  success: boolean;
  commitHash?: string;
  error?: string;
}

/**
 * CommitSequencer — serialized commit merging.
 *
 * Workers produce commits on task branches. The sequencer cherry-picks
 * them one-by-one onto the target branch, handling conflicts gracefully.
 * This prevents concurrent git operations on the main branch.
 */
export class CommitSequencer {
  private repoPath: string;
  private targetBranch: string;
  private results: SequencerResult[] = [];

  constructor(repoPath: string, targetBranch: string) {
    this.repoPath = repoPath;
    this.targetBranch = targetBranch;
  }

  /**
   * Cherry-pick a single task's commit onto target branch.
   * Returns success/failure with details.
   */
  async apply(execResult: ExecutionResult): Promise<SequencerResult> {
    const { workUnitId, commitHash, branch } = execResult;

    if (!commitHash) {
      const r: SequencerResult = { taskId: workUnitId, success: true, error: "no changes" };
      this.results.push(r);
      return r;
    }

    // Safety checks
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

    // Ensure we're on target branch
    gitExec(["checkout", this.targetBranch], this.repoPath);

    // Cherry-pick
    const pick = gitExec(["cherry-pick", commitHash], this.repoPath);
    if (pick.exitCode !== 0) {
      // Abort failed cherry-pick
      gitExec(["cherry-pick", "--abort"], this.repoPath);

      const guide = this.conflictGuide(workUnitId, commitHash, branch);
      console.log(guide);

      const r: SequencerResult = {
        taskId: workUnitId,
        success: false,
        commitHash,
        error: `MERGE_CONFLICT: ${pick.stderr.slice(0, 200)}`,
      };
      this.results.push(r);
      return r;
    }

    // Get the new commit hash on target branch
    const newHash = gitExec(["rev-parse", "HEAD"], this.repoPath).stdout.trim();
    const r: SequencerResult = { taskId: workUnitId, success: true, commitHash: newHash };
    this.results.push(r);
    return r;
  }

  /**
   * Apply multiple results sequentially. Order matters for conflict avoidance.
   */
  async applyAll(results: ExecutionResult[]): Promise<SequencerResult[]> {
    // Sort: successful first, then by task id for deterministic order
    const sorted = [...results]
      .filter(r => r.commitHash)
      .sort((a, b) => a.workUnitId.localeCompare(b.workUnitId));

    console.log(`[Sequencer] Applying ${sorted.length} commits to ${this.targetBranch}...`);

    const sequencerResults: SequencerResult[] = [];
    for (const result of sorted) {
      const sr = await this.apply(result);
      sequencerResults.push(sr);
      const icon = sr.success ? "✅" : "❌";
      console.log(`  ${icon} ${sr.taskId}: ${sr.error ?? sr.commitHash}`);
    }

    const succeeded = sequencerResults.filter(r => r.success).length;
    const failed = sequencerResults.filter(r => !r.success).length;
    console.log(`[Sequencer] Done: ${succeeded} merged, ${failed} failed`);

    return sequencerResults;
  }

  /** Pre-merge safety checks */
  private preMergeChecks(commitHash: string): string | null {
    // 1. Working tree clean
    const status = gitExec(["status", "--porcelain"], this.repoPath);
    if (status.stdout.trim()) return "working tree is dirty";

    // 2. Commit exists
    const exists = gitExec(["cat-file", "-t", commitHash], this.repoPath);
    if (exists.exitCode !== 0) return `commit ${commitHash} does not exist`;

    // 3. Not already picked
    const ancestor = gitExec(["merge-base", "--is-ancestor", commitHash, "HEAD"], this.repoPath);
    if (ancestor.exitCode === 0) return `${commitHash} already in history`;

    return null;
  }

  /** Generate copy-paste conflict resolution guide */
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

  /** Get all results */
  getResults(): SequencerResult[] {
    return [...this.results];
  }
}
