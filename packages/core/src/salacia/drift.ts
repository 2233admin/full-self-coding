// packages/core/src/salacia/drift.ts
// Drift Detection — scope enforcement + SHA256 fingerprinting

import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import type { ExecutionContract } from "./contract";

export interface DriftReport {
  taskId: string;
  score: number;           // 0 = clean, higher = worse
  inScopeFiles: string[];
  softScopeFiles: string[];  // matched softAllowed — score 0, but tracked
  outOfScopeFiles: string[];
  protectedViolations: string[];
  excessFiles: number;     // files beyond maxFilesChanged
  fingerprints: Record<string, string>;  // file → SHA256
}

/**
 * Simple glob matching (supports * and ** patterns).
 * Not a full glob engine — handles the patterns we actually generate.
 */
function matchGlob(filePath: string, pattern: string): boolean {
  // Exact match
  if (filePath === pattern) return true;

  // ** matches any depth
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return filePath.startsWith(prefix + "/") || filePath === prefix;
  }

  // *.ext matches extension (leading wildcard)
  if (pattern.startsWith("*.")) {
    const ext = pattern.slice(1);
    return filePath.endsWith(ext);
  }

  // .env.* matches dotfile variants
  if (pattern.includes(".*")) {
    const base = pattern.replace(".*", "");
    return filePath === base || filePath.startsWith(base + ".");
  }

  // Direct prefix match for directory patterns
  if (pattern.endsWith("/")) {
    return filePath.startsWith(pattern);
  }

  // Mid-pattern wildcard: "dir/prefix*.ts" or "prefix*.ts"
  // Convert simple * glob to regex (only handles single * in filename part)
  if (pattern.includes("*") && !pattern.includes("**")) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(filePath);
  }

  return false;
}

function matchesAny(filePath: string, patterns: string[]): boolean {
  return patterns.some(p => matchGlob(filePath, p));
}

/**
 * Compute SHA256 of a file. Returns empty string if file doesn't exist.
 */
function sha256File(fullPath: string): string {
  try {
    const content = fs.readFileSync(fullPath);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return "";
  }
}

/**
 * Detect scope drift: classify each changed file as in-scope, out-of-scope, or protected violation.
 *
 * Scoring formula (from Salacia, proven on SWE-bench):
 *   inScope file:      0 points
 *   outOfScope file:  +5 points
 *   protectedPath:   +40 points
 *   excess files:     +2 per file beyond maxFilesChanged
 */
export function detectDrift(
  contract: ExecutionContract,
  filesChanged: string[],
  worktreePath: string,
): DriftReport {
  const inScopeFiles: string[] = [];
  const softScopeFiles: string[] = [];
  const outOfScopeFiles: string[] = [];
  const protectedViolations: string[] = [];
  const fingerprints: Record<string, string> = {};

  const softAllowed = contract.softAllowedPaths ?? [];

  for (const file of filesChanged) {
    // Fingerprint every changed file
    const fullPath = path.resolve(worktreePath, file);
    fingerprints[file] = sha256File(fullPath);

    // Check protected first (highest priority)
    if (matchesAny(file, contract.protectedPaths)) {
      protectedViolations.push(file);
      continue;
    }

    // Check excluded
    if (matchesAny(file, contract.excludedPaths)) {
      outOfScopeFiles.push(file);
      continue;
    }

    // Check allowed (hard scope)
    if (contract.allowedPaths.length === 0 || matchesAny(file, contract.allowedPaths)) {
      inScopeFiles.push(file);
    } else if (softAllowed.length > 0 && matchesAny(file, softAllowed)) {
      // Soft scope: no penalty, but tracked
      softScopeFiles.push(file);
    } else {
      outOfScopeFiles.push(file);
    }
  }

  const excessFiles = Math.max(0, filesChanged.length - contract.maxFilesChanged);

  // Scoring
  const score =
    outOfScopeFiles.length * 5 +
    protectedViolations.length * 40 +
    excessFiles * 2;

  return {
    taskId: contract.taskId,
    score,
    inScopeFiles,
    softScopeFiles,
    outOfScopeFiles,
    protectedViolations,
    excessFiles,
    fingerprints,
  };
}

/**
 * Check if drift is fatal (protected path violated).
 */
export function isFatalDrift(report: DriftReport): boolean {
  return report.protectedViolations.length > 0;
}

/**
 * Check if drift exceeds threshold.
 */
export function exceedsThreshold(report: DriftReport, threshold: number = 30): boolean {
  return report.score >= threshold;
}
