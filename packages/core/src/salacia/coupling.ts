// packages/core/src/salacia/coupling.ts
// Co-change coupling mining from git log (ported from commit-prophet + Axon)

import { gitExec } from "../execution/gitExec";

export interface CoChangeEntry {
  file: string;
  coupling: number;   // 0..1, higher = stronger coupling
  coChanges: number;   // absolute co-occurrence count
}

/**
 * Mine co-changed files from git history.
 *
 * Algorithm (commit-prophet):
 *   1. Find all commits touching `filePath` within `days`
 *   2. Count how often each other file appears in those commits
 *   3. coupling(A,B) = co_changes(A,B) / max(changes(A), changes(B))
 *   4. Filter: coupling >= minCoupling AND coChanges >= minCoChanges
 */
export function getCoChangedFiles(
  filePath: string,
  repoPath: string,
  days: number = 90,
  minCoupling: number = 0.3,
  minCoChanges: number = 3,
): CoChangeEntry[] {
  // Step 1: get commit hashes touching filePath
  const hashResult = gitExec(
    ["log", "--format=%H", `--since=${days}.days.ago`, "--", filePath],
    repoPath,
  );
  if (hashResult.exitCode !== 0 || !hashResult.stdout.trim()) return [];

  const hashes = hashResult.stdout.trim().split("\n").filter(Boolean);
  const totalCommitsA = hashes.length;
  if (totalCommitsA === 0) return [];

  // Step 2: for each commit, get ALL files changed (not just filePath)
  const coCount: Record<string, number> = {};
  for (const hash of hashes) {
    const diffTree = gitExec(
      ["diff-tree", "--no-commit-id", "--name-only", "-r", hash],
      repoPath,
    );
    if (diffTree.exitCode !== 0) continue;
    const files = diffTree.stdout.trim().split("\n").filter(f => f && f !== filePath);
    for (const f of files) {
      coCount[f] = (coCount[f] || 0) + 1;
    }
  }

  // Step 3: for each co-changed file, get its total change count
  const results: CoChangeEntry[] = [];
  for (const [file, coChanges] of Object.entries(coCount)) {
    if (coChanges < minCoChanges) continue;

    const fileLog = gitExec(
      ["rev-list", "--count", `--since=${days}.days.ago`, "HEAD", "--", file],
      repoPath,
    );
    const totalCommitsB = parseInt(fileLog.stdout.trim(), 10) || 1;
    const coupling = coChanges / Math.max(totalCommitsA, totalCommitsB);

    if (coupling >= minCoupling) {
      results.push({ file, coupling: Math.round(coupling * 1000) / 1000, coChanges });
    }
  }

  return results.sort((a, b) => b.coupling - a.coupling);
}

/**
 * Expand a set of core files with their co-changed companions.
 * Returns glob patterns suitable for allowedPaths / softAllowedPaths.
 */
export function expandWithCoupling(
  coreFiles: string[],
  repoPath: string,
  days?: number,
): string[] {
  const seen = new Set(coreFiles);
  const expanded: string[] = [];

  for (const file of coreFiles) {
    const companions = getCoChangedFiles(file, repoPath, days);
    for (const c of companions) {
      if (!seen.has(c.file)) {
        seen.add(c.file);
        expanded.push(c.file);
      }
    }
  }

  return expanded;
}
