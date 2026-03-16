import { describe, test, expect } from "bun:test";
import { gitExec } from "../../src/execution/gitExec";
import { generateContract } from "../../src/salacia/contract";
import { detectDrift, isFatalDrift, exceedsThreshold } from "../../src/salacia/drift";
import type { Task } from "../../src/task";

const REPO = "D:/projects/full-self-coding";

function getRecentCommits(n: number): Array<{ hash: string; message: string; files: string[] }> {
  const log = gitExec(["log", "--oneline", `-${n}`], REPO);
  return log.stdout.trim().split("\n").map(line => {
    const hash = line.slice(0, 7);
    const message = line.slice(8);
    let files: string[] = [];
    const diff = gitExec(["diff-tree", "--no-commit-id", "--name-only", "-r", hash], REPO);
    if (diff.exitCode === 0) {
      files = diff.stdout.trim().split("\n").filter(Boolean);
    }
    return { hash, message, files };
  }).filter(c => c.files.length > 0);
}

function commitToTask(commit: { hash: string; message: string; files: string[] }): Task {
  return {
    ID: commit.hash,
    title: commit.message,
    description: commit.message,
    priority: commit.message.startsWith("fix") ? 4 : 2,
    riskLevel: commit.message.includes("API key") || commit.message.includes("security")
      ? "critical"
      : commit.files.length > 10 ? "high" : "medium",
  };
}

describe("Salacia Replay v2 — co-change coupling + soft scope", () => {
  const commits = getRecentCommits(15);

  test(`replay ${commits.length} real commits (v2: with coupling)`, () => {
    console.log("\n┌───────────────────────────────────────────────────────────────┐");
    console.log("│       SALACIA v2 REPLAY: CO-CHANGE COUPLING + SOFT SCOPE     │");
    console.log("├───────────────────────────────────────────────────────────────┤");

    let totalBlocked = 0;
    let totalDrift = 0;
    let totalClean = 0;
    let totalSoftHits = 0;

    for (const commit of commits) {
      const task = commitToTask(commit);
      const contract = generateContract(task, { repoPath: REPO, couplingDays: 180 });
      const report = detectDrift(contract, commit.files, REPO);

      const fatal = isFatalDrift(report);
      const warning = exceedsThreshold(report, 30);

      let status: string;
      if (fatal) {
        status = "🚫 BLOCK";
        totalBlocked++;
      } else if (warning || report.score > 0) {
        status = report.score >= 30 ? "⚠️  WARN " : "🔶 DRIFT";
        totalDrift++;
      } else {
        status = "✅ CLEAN";
        totalClean++;
      }

      totalSoftHits += report.softScopeFiles.length;

      const shortMsg = commit.message.length > 40 ? commit.message.slice(0, 40) + "…" : commit.message;
      console.log(`│ ${commit.hash} ${status} d=${String(report.score).padStart(3)} f=${String(commit.files.length).padStart(2)} soft=${report.softScopeFiles.length} │ ${shortMsg}`);

      if (report.protectedViolations.length > 0) {
        console.log(`│         🔴 protected: ${report.protectedViolations.join(", ")}`);
      }
      if (report.softScopeFiles.length > 0) {
        console.log(`│         🔵 soft-scope: ${report.softScopeFiles.join(", ")}`);
      }
      if (report.outOfScopeFiles.length > 0) {
        const shown = report.outOfScopeFiles.slice(0, 3).join(", ");
        const extra = report.outOfScopeFiles.length > 3 ? ` (+${report.outOfScopeFiles.length - 3})` : "";
        console.log(`│         🟡 out-of-scope: ${shown}${extra}`);
      }
    }

    const flagRate = ((totalDrift + totalBlocked) / commits.length) * 100;
    const cleanRate = (totalClean / commits.length) * 100;

    console.log("├───────────────────────────────────────────────────────────────┤");
    console.log(`│ ✅ Clean: ${totalClean}  🔶⚠️ Drift: ${totalDrift}  🚫 Blocked: ${totalBlocked}  Total: ${commits.length}`);
    console.log(`│ 🔵 Soft-scope hits: ${totalSoftHits} (files saved from false-positive)`);
    console.log(`│ Clean rate: ${cleanRate.toFixed(0)}%  Flag rate: ${flagRate.toFixed(0)}%`);
    console.log("└───────────────────────────────────────────────────────────────┘\n");

    expect(commits.length).toBeGreaterThan(0);
    expect(totalClean + totalDrift + totalBlocked).toBe(commits.length);
  });
});
