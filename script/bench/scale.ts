// Scale benchmark for the native pipeline: UnifiedScheduler -> LocalExecution (worktree per task)
// -> CommitSequencer, with a mock agent that makes no model calls.
//
//   bun script/bench/scale.ts --n 50 --concurrency 5 --overlap none
//
// Flags
//   --n <int>            number of tasks (default 10)
//   --concurrency <int>  agents running at once (default 5)
//   --overlap <mode>     none: every task writes its own file.
//                        same-line: every task rewrites the same line of shared.txt.
//   --agent-ms <int>     simulated agent work per task, via sleep (default 0)
//   --files <int>        extra seed files in the repository (default 200)
//   --root <dir>         scratch directory (default D:/tmp/fsc-bench on this host, else the OS temp dir)
//   --keep               do not delete the scratch repository
//
// Prints one JSON object. This measures git, scheduling and merging, not model latency or cost.

import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { UnifiedScheduler } from "../../packages/core/src/execution/scheduler";
import { gitExec } from "../../packages/core/src/execution/gitExec";
import type { WorkUnit } from "../../packages/core/src/execution/types";
import type { Task } from "../../packages/core/src/task";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const N = parseInt(arg("n", "10"));
const CONC = parseInt(arg("concurrency", "5"));
const OVERLAP = arg("overlap", "none");
const AGENT_MS = parseInt(arg("agent-ms", "0"));
const FILES = parseInt(arg("files", "200"));
const KEEP = process.argv.includes("--keep");
const ROOT = arg("root", existsSync("D:/tmp") ? "D:/tmp/fsc-bench" : join(tmpdir(), "fsc-bench"));

if (!["none", "same-line"].includes(OVERLAP)) throw new Error(`--overlap must be none or same-line`);

const dir = join(ROOT, `n${N}-c${CONC}-${OVERLAP}-${Date.now()}`);
const repo = join(dir, "repo");
mkdirSync(repo, { recursive: true });
const git = (...a: string[]) => {
  const r = gitExec(a, repo);
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

git("init", "-q", "-b", "main");
git("config", "user.name", "bench");
git("config", "user.email", "bench@local");
git("config", "core.autocrlf", "false");
writeFileSync(join(repo, "shared.txt"), "VALUE=base\n");
mkdirSync(join(repo, "seed"), { recursive: true });
for (let i = 0; i < FILES; i++) writeFileSync(join(repo, "seed", `f${i}.txt`), `seed file ${i}\n`.repeat(20));
git("add", "-A");
git("commit", "-q", "-m", "seed");

const sleep = AGENT_MS > 0 ? `sleep ${(AGENT_MS / 1000).toFixed(3)}; ` : "";
const script =
  OVERLAP === "none"
    ? `${sleep}echo "$FSC_TASK_ID" > "out_$FSC_TASK_ID.txt"`
    : `${sleep}printf 'VALUE=%s\\n' "$FSC_TASK_ID" > shared.txt`;

const tasks: Task[] = Array.from({ length: N }, (_, i) => ({
  ID: `t${String(i).padStart(4, "0")}`,
  title: `task ${i}`,
  description: "mock",
  priority: 1,
}));

const unitFactory = (task: Task, repoPath: string): WorkUnit => ({
  id: task.ID,
  repoPath,
  baseBranch: "main",
  taskPrompt: task.title,
  agentConfig: {
    type: "custom",
    command: "bash",
    buildArgs: () => ["-c", script],
    costTier: "free",
    memoryMB: 50,
  },
  constraints: { timeoutMs: 120_000 },
});

const realLog = console.log;
console.log = () => {}; // silence per-task chatter; the result is printed below
const t0 = Date.now();
const scheduler = new UnifiedScheduler({ localPoolSize: CONC, maxConcurrency: CONC, unitFactory });
const report = await scheduler.execute(tasks, repo);
const totalMs = Date.now() - t0;
console.log = realLog;

const merged = report.mergeResults.filter((m) => m.success && m.resolvedTier).length;
const conflicts = report.mergeResults.filter((m) => !m.success && (m.error ?? "").includes("MERGE_CONFLICT")).length;
const otherMergeFailures = report.mergeResults.filter((m) => !m.success && !(m.error ?? "").includes("MERGE_CONFLICT")).length;
const rss = (process.resourceUsage() as { maxRSS?: number }).maxRSS;
const leftoverWorktrees = git("worktree", "list").trim().split("\n").length - 1;
const leftoverBranches = git("branch", "--list", "fsc/*").trim().split("\n").filter(Boolean).length;

console.log(
  JSON.stringify(
    {
      n: N,
      concurrency: CONC,
      overlap: OVERLAP,
      agentMs: AGENT_MS,
      seedFiles: FILES,
      totalMs,
      execMs: report.execMs,
      mergeMs: report.mergeMs,
      cleanupMs: report.cleanupMs,
      executed: report.completed,
      executionFailed: report.failed,
      merged,
      conflicts,
      otherMergeFailures,
      msPerMerge: merged > 0 && report.mergeMs ? Math.round(report.mergeMs / merged) : null,
      tasksPerMinute: Math.round((N / totalMs) * 60_000),
      schedulerMaxRssMB: rss ? Math.round(rss / 1024) : null,
      leftoverWorktrees,
      leftoverBranches,
    },
    null,
    2,
  ),
);

if (!KEEP) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
