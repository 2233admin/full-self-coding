import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { UnifiedScheduler } from "../../src/execution/scheduler";
import { gitExec } from "../../src/execution/gitExec";
import type { WorkUnit } from "../../src/execution/types";
import type { Task } from "../../src/task";
import fs from "fs";
import path from "path";
import os from "os";

// Two tasks rewrite the same line, so the second merge conflicts. The mock agent behaves like a
// sensible one: when its prompt carries the retry note it adds its own line instead of
// overwriting the line that is already there.
const SCRIPT = [
  'if printf %s "$PROMPT" | grep -q "Retry note"; then',
  '  printf "LINE=%s\\n" "$FSC_TASK_ID" >> shared.txt;',
  "else",
  '  printf "LINE=%s\\n" "$FSC_TASK_ID" > shared.txt;',
  "fi",
].join(" ");

function makeUnit(task: Task, repoPath: string): WorkUnit {
  return {
    id: task.ID,
    repoPath,
    baseBranch: "main",
    taskPrompt: task.title,
    agentConfig: {
      type: "custom",
      command: "bash",
      buildArgs: (prompt: string) => ["-c", `PROMPT=${JSON.stringify(prompt)}; ${SCRIPT}`],
      costTier: "free",
      memoryMB: 50,
    },
    constraints: { timeoutMs: 30_000 },
  };
}

const tasks: Task[] = [
  { ID: "a", title: "task a", description: "", priority: 1 },
  { ID: "b", title: "task b", description: "", priority: 1 },
];

describe("UnifiedScheduler conflict retry", () => {
  let repo: string;

  beforeEach(() => {
    repo = path.resolve(os.tmpdir(), `fsc-retry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(repo, { recursive: true });
    const g = (...a: string[]) => gitExec(a, repo);
    g("init");
    g("checkout", "-b", "main");
    g("config", "user.name", "t");
    g("config", "user.email", "t@t");
    fs.writeFileSync(path.join(repo, "shared.txt"), "LINE=base\n");
    g("add", "-A");
    g("commit", "-m", "base");
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    const parent = path.dirname(repo);
    for (const e of fs.readdirSync(parent)) {
      if (e.startsWith(`${path.basename(repo)}-fsc-`)) {
        fs.rmSync(path.join(parent, e), { recursive: true, force: true });
      }
    }
  });

  test("a conflicting task is re-run on top of the merge and then merges", async () => {
    const scheduler = new UnifiedScheduler({ maxConcurrency: 2, unitFactory: makeUnit });
    const report = await scheduler.execute(tasks, repo);

    expect(report.mergeResults.every(m => m.success)).toBe(true);
    expect(report.retries).toEqual({ b: 1 });
    // clean merge, but both tasks touched shared.txt: flagged so a human checks the outcome
    expect(report.retryOverlaps).toEqual({ b: [{ task: "a", files: ["shared.txt"] }] });
    const shared = fs.readFileSync(path.join(repo, "shared.txt"), "utf-8");
    expect(shared).toContain("LINE=a");
    expect(shared).toContain("LINE=b");
    // the superseded attempt branch is gone, nothing is left behind
    const branches = gitExec(["branch", "--list", "fsc/*"], repo).stdout.trim();
    expect(branches).toBe("");
    expect(gitExec(["status", "--porcelain", "--untracked-files=no"], repo).stdout.trim()).toBe("");
  }, 60_000);

  test("conflictRetries: 0 keeps the old behaviour (conflict reported, branch kept)", async () => {
    const scheduler = new UnifiedScheduler({ maxConcurrency: 2, conflictRetries: 0, unitFactory: makeUnit });
    const report = await scheduler.execute(tasks, repo);

    const failed = report.mergeResults.filter(m => !m.success);
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toContain("MERGE_CONFLICT");
    expect(report.retries).toEqual({});
    expect(gitExec(["branch", "--list", `fsc/${failed[0].taskId}`], repo).stdout.trim()).not.toBe("");
  }, 60_000);

  test("a retry that loses the race again is reported, with both attempts kept", async () => {
    // Three agents that always rewrite the same line. Round 0: a merges, b and c conflict.
    // Retry round: b and c both rewrite the new line; b merges first, c conflicts again.
    const three: Task[] = [...tasks, { ID: "c", title: "task c", description: "", priority: 1 }];
    const stubborn = (task: Task, repoPath: string): WorkUnit => {
      const u = makeUnit(task, repoPath);
      u.agentConfig.buildArgs = () => ["-c", 'printf "LINE=%s\n" "$FSC_TASK_ID" > shared.txt'];
      return u;
    };
    const scheduler = new UnifiedScheduler({ maxConcurrency: 3, conflictRetries: 1, unitFactory: stubborn });
    const report = await scheduler.execute(three, repo);

    const failed = report.mergeResults.filter(m => !m.success);
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toContain("MERGE_CONFLICT");
    expect(report.mergeResults.filter(m => m.success)).toHaveLength(2);
    expect(Object.values(report.retries ?? {})).toEqual([1, 1]);

    const id = failed[0].taskId;
    const kept = gitExec(["branch", "--list", `fsc/${id}*`], repo).stdout;
    expect(kept).toContain(`fsc/${id}-attempt1`);
    expect(kept).toContain(`fsc/${id} `.trimEnd());
  }, 90_000);
});
