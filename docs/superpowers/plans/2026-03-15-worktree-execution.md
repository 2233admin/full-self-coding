# FSC Worktree Execution Mode — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add worktree-based parallel execution mode to FSC that creates git worktrees, dispatches CLI agents (claude/codex/gemini), collects results, and merges via cherry-pick.

**Architecture:** New `execution/` module with `ExecutionStrategy` interface, `LocalExecution` impl, `WorktreeManager` for git worktree lifecycle, `WorktreeCollector` for result gathering. Integrates into existing `TaskSolverManager` as a third execution mode alongside Docker/bare. `CodeCommitter` gets a cherry-pick path.

**Tech Stack:** Bun runtime, TypeScript strict, `git worktree` CLI, `Bun.spawn`/`Bun.spawnSync`

**Spec:** `docs/superpowers/specs/2026-03-15-worktree-execution-design.md` (v3)

**Test:** `bun test` from `packages/core/`

**Build:** No build step — Bun runs TS directly

---

## File Map

```
packages/core/src/
├── execution/
│   ├── index.ts          — re-exports (CREATE)
│   ├── types.ts          — WorkUnit, ExecutionResult, AgentConfig, etc. (CREATE)
│   ├── strategy.ts       — ExecutionStrategy interface (CREATE)
│   ├── gitExec.ts        — git command wrapper with timeout (CREATE)
│   ├── concurrency.ts    — ConcurrencyPool (CREATE)
│   ├── worktree.ts       — WorktreeManager with async mutex (CREATE)
│   ├── local.ts          — LocalExecution implements ExecutionStrategy (CREATE)
│   ├── remote.ts         — RemoteExecution stub (CREATE)
│   ├── collector.ts      — WorktreeCollector (CREATE)
│   └── mapping.ts        — toWorkUnit(), toTaskResult(), buildTaskPrompt() (CREATE)
├── task.ts                — add commitHash?, worktreeBranch? (MODIFY)
├── taskExecutor.ts        — rename WorktreeExecutor → BareWorkspaceExecutor (MODIFY)
├── taskSolverManager.ts   — add worktree mode (MODIFY)
├── codeCommitter.ts       — add cherry-pick path (MODIFY)
└── index.ts               — add new exports (MODIFY)

packages/core/test/
├── execution/
│   ├── gitExec.test.ts           (CREATE)
│   ├── concurrency.test.ts       (CREATE)
│   ├── worktree.test.ts          (CREATE)
│   ├── local.test.ts             (CREATE)
│   ├── collector.test.ts         (CREATE)
│   ├── mapping.test.ts           (CREATE)
│   └── resultValidator.test.ts   (CREATE)
├── taskExecutor.test.ts          — update for rename (MODIFY if exists)
└── codeCommitter.test.ts         — add cherry-pick tests (MODIFY)
```

---

## Task 1: Types & Interfaces (Foundation)

**Files:**
- Create: `packages/core/src/execution/types.ts`
- Create: `packages/core/src/execution/strategy.ts`
- Create: `packages/core/src/execution/index.ts`
- Modify: `packages/core/src/task.ts` — add `commitHash?`, `worktreeBranch?`
- Modify: `packages/core/src/index.ts` — add exports

- [ ] **Step 1: Extend TaskResult in task.ts**

Add two optional fields after `gitDiff?`:

```typescript
// In TaskResult interface, after gitDiff
/** Commit hash produced by worktree execution (for cherry-pick) */
commitHash?: string;
/** Worktree branch name (for debugging/tracing) */
worktreeBranch?: string;
```

- [ ] **Step 2: Create execution/types.ts**

```typescript
// packages/core/src/execution/types.ts

export interface AgentConfig {
  type: "claude" | "codex" | "gemini" | "custom";
  command: string;
  buildArgs(prompt: string, cwd: string): string[];
  env?: Record<string, string>;
}

export interface WorkUnit {
  id: string;
  repoPath: string;
  baseBranch: string;
  taskPrompt: string;
  agentConfig: AgentConfig;
  constraints: {
    timeoutMs: number;
    maxTokens?: number;
    allowedPaths?: string[];
  };
  context?: {
    memorixUri?: string;
    codeRAGContext?: string;
    taskDeps?: string[];
  };
}

export interface ExecutionResult {
  workUnitId: string;
  status: "success" | "failure" | "timeout" | "error";
  commitHash: string | null;
  branch: string;
  worktreePath: string;
  startedAt: number;
  completedAt: number;
  agent: { type: string; version?: string };
  filesChanged: string[];
  logs: string[];
  error?: {
    message: string;
    category: "RESOURCE" | "TRANSIENT" | "PERMANENT" | "QUALITY" | "MERGE_CONFLICT" | "UNKNOWN";
  };
}

export type ExecutionStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
  taskId: string;
}

// Pre-built agent arg builders
export const AGENT_BUILDERS = {
  claude: (prompt: string, cwd: string) =>
    ["-p", prompt, "--cwd", cwd, "--allowedTools", "Edit,Write,Bash,Read,Glob,Grep"],
  codex: (prompt: string, cwd: string) =>
    ["exec", "--approval-mode", "full-auto", "-w", cwd, prompt],
  gemini: (prompt: string, cwd: string) =>
    ["-p", prompt, "--cwd", cwd],
} satisfies Record<string, AgentConfig["buildArgs"]>;
```

- [ ] **Step 3: Create execution/strategy.ts**

```typescript
// packages/core/src/execution/strategy.ts
import type { WorkUnit, ExecutionResult, ExecutionStatus } from "./types";

export interface ExecutionStrategy {
  execute(unit: WorkUnit): Promise<ExecutionResult>;
  abort(unitId: string): Promise<void>;
  getStatus(unitId: string): ExecutionStatus;
}
```

- [ ] **Step 4: Create execution/index.ts**

```typescript
// packages/core/src/execution/index.ts
export * from "./types";
export * from "./strategy";
export * from "./gitExec";
export * from "./concurrency";
export * from "./worktree";
export * from "./local";
export * from "./remote";
export * from "./collector";
export * from "./mapping";
```

- [ ] **Step 5: Add exports to packages/core/src/index.ts**

Append after existing exports:

```typescript
// Worktree Execution (v3)
export * from './execution';
```

- [ ] **Step 6: Run type check**

Run: `cd packages/core && bunx tsc --noEmit`
Expected: PASS (no type errors)

- [ ] **Step 7: Commit**

```bash
cd D:/projects/full-self-coding
git add packages/core/src/task.ts packages/core/src/execution/ packages/core/src/index.ts
git commit -m "feat(execution): add types, interfaces, and strategy for worktree mode"
```

---

## Task 2: Git Exec Wrapper & Concurrency Pool

**Files:**
- Create: `packages/core/src/execution/gitExec.ts`
- Create: `packages/core/src/execution/concurrency.ts`
- Create: `packages/core/test/execution/gitExec.test.ts`
- Create: `packages/core/test/execution/concurrency.test.ts`

- [ ] **Step 1: Write gitExec tests**

```typescript
// packages/core/test/execution/gitExec.test.ts
import { describe, test, expect } from "bun:test";
import { gitExec } from "../../src/execution/gitExec";

describe("gitExec", () => {
  test("runs git command and returns stdout", () => {
    const result = gitExec(["--version"], ".");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("git version");
  });

  test("returns non-zero exit code for invalid command", () => {
    const result = gitExec(["invalid-command-xyz"], ".");
    expect(result.exitCode).not.toBe(0);
  });

  test("returns stderr on error", () => {
    const result = gitExec(["log", "--invalidflag"], ".");
    expect(result.exitCode).not.toBe(0);
    // stderr should contain something
  });

  test("respects custom timeout", () => {
    // git --version should complete well within 1s
    const result = gitExec(["--version"], ".", 1000);
    expect(result.exitCode).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test test/execution/gitExec.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement gitExec.ts**

```typescript
// packages/core/src/execution/gitExec.ts
import { spawnSync } from "bun";

const GIT_TIMEOUT_MS = 30_000;

export interface GitExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function gitExec(
  args: string[],
  cwd: string,
  timeoutMs: number = GIT_TIMEOUT_MS,
): GitExecResult {
  const result = spawnSync({
    cmd: ["git", ...args],
    cwd,
    timeout: timeoutMs,
  });

  return {
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    exitCode: result.exitCode ?? 1,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && bun test test/execution/gitExec.test.ts`
Expected: PASS

- [ ] **Step 5: Write concurrency pool tests**

```typescript
// packages/core/test/execution/concurrency.test.ts
import { describe, test, expect } from "bun:test";
import { ConcurrencyPool } from "../../src/execution/concurrency";

describe("ConcurrencyPool", () => {
  test("limits concurrent execution", async () => {
    const pool = new ConcurrencyPool(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 50));
      concurrent--;
    };

    await Promise.all(
      Array.from({ length: 6 }, () => pool.run(task))
    );

    expect(maxConcurrent).toBe(2);
  });

  test("returns task results", async () => {
    const pool = new ConcurrencyPool(3);
    const results = await Promise.all([
      pool.run(async () => "a"),
      pool.run(async () => "b"),
      pool.run(async () => "c"),
    ]);
    expect(results).toEqual(["a", "b", "c"]);
  });

  test("propagates errors without blocking pool", async () => {
    const pool = new ConcurrencyPool(2);
    const results = await Promise.allSettled([
      pool.run(async () => { throw new Error("fail"); }),
      pool.run(async () => "ok"),
    ]);
    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("fulfilled");
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd packages/core && bun test test/execution/concurrency.test.ts`
Expected: FAIL

- [ ] **Step 7: Implement concurrency.ts**

```typescript
// packages/core/src/execution/concurrency.ts

export class ConcurrencyPool {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running >= this.max) {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd packages/core && bun test test/execution/concurrency.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
cd D:/projects/full-self-coding
git add packages/core/src/execution/gitExec.ts packages/core/src/execution/concurrency.ts packages/core/test/execution/
git commit -m "feat(execution): add gitExec wrapper with timeout + ConcurrencyPool"
```

---

## Task 3: WorktreeManager

**Files:**
- Create: `packages/core/src/execution/worktree.ts`
- Create: `packages/core/test/execution/worktree.test.ts`

- [ ] **Step 1: Write WorktreeManager tests**

```typescript
// packages/core/test/execution/worktree.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { WorktreeManager } from "../../src/execution/worktree";
import { gitExec } from "../../src/execution/gitExec";
import fs from "fs";
import path from "path";
import os from "os";

describe("WorktreeManager", () => {
  let testRepo: string;
  let manager: WorktreeManager;

  beforeAll(() => {
    // Create a temp git repo for testing
    testRepo = path.resolve(os.tmpdir(), `fsc-wt-test-${Date.now()}`);
    fs.mkdirSync(testRepo, { recursive: true });
    gitExec(["init"], testRepo);
    gitExec(["checkout", "-b", "main"], testRepo);
    fs.writeFileSync(path.resolve(testRepo, "README.md"), "test repo");
    gitExec(["add", "-A"], testRepo);
    gitExec(["commit", "-m", "initial"], testRepo);
    manager = new WorktreeManager();
  });

  afterAll(() => {
    // Cleanup: remove worktrees then repo
    try { manager.cleanup(testRepo); } catch {}
    fs.rmSync(testRepo, { recursive: true, force: true });
    // Also clean sibling dirs
    const parent = path.dirname(testRepo);
    const base = path.basename(testRepo);
    for (const entry of fs.readdirSync(parent)) {
      if (entry.startsWith(`${base}-fsc-`)) {
        gitExec(["worktree", "remove", "--force", path.resolve(parent, entry)], testRepo);
        fs.rmSync(path.resolve(parent, entry), { recursive: true, force: true });
      }
    }
  });

  test("create() creates a git worktree as sibling dir", async () => {
    const info = await manager.create(testRepo, "main", "task-1");
    expect(info.branch).toBe("fsc/task-1");
    expect(fs.existsSync(info.worktreePath)).toBe(true);
    // Should be a sibling, not inside repo
    expect(path.dirname(info.worktreePath)).toBe(path.dirname(testRepo));
    // Cleanup
    await manager.remove(info.worktreePath, testRepo);
  });

  test("create() serializes concurrent calls (no index.lock conflict)", async () => {
    // Create 3 worktrees concurrently — should not crash
    const results = await Promise.all([
      manager.create(testRepo, "main", "concurrent-1"),
      manager.create(testRepo, "main", "concurrent-2"),
      manager.create(testRepo, "main", "concurrent-3"),
    ]);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(fs.existsSync(r.worktreePath)).toBe(true);
      await manager.remove(r.worktreePath, testRepo);
    }
  });

  test("list() returns FSC-managed worktrees", async () => {
    const info = await manager.create(testRepo, "main", "list-test");
    const list = manager.list(testRepo);
    expect(list.some(w => w.taskId === "list-test")).toBe(true);
    await manager.remove(info.worktreePath, testRepo);
  });

  test("remove() cleans up worktree and branch", async () => {
    const info = await manager.create(testRepo, "main", "remove-test");
    await manager.remove(info.worktreePath, testRepo);
    expect(fs.existsSync(info.worktreePath)).toBe(false);
  });

  test("cleanup() removes all FSC worktrees", async () => {
    await manager.create(testRepo, "main", "clean-1");
    await manager.create(testRepo, "main", "clean-2");
    manager.cleanup(testRepo);
    const list = manager.list(testRepo);
    expect(list).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test test/execution/worktree.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement worktree.ts**

```typescript
// packages/core/src/execution/worktree.ts
import path from "path";
import fs from "fs";
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
   * Preflight checks: git version, disk space hint.
   */
  preflight(repoPath: string, agentCommands: string[]): string[] {
    const errors: string[] = [];
    const resolvedRepo = path.resolve(repoPath);

    // Check git version
    const ver = gitExec(["--version"], resolvedRepo);
    if (ver.exitCode !== 0) {
      errors.push("git is not installed or not in PATH");
    }

    // Check agent CLIs
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && bun test test/execution/worktree.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd D:/projects/full-self-coding
git add packages/core/src/execution/worktree.ts packages/core/test/execution/worktree.test.ts
git commit -m "feat(execution): add WorktreeManager with serialized creation + cleanup"
```

---

## Task 4: Mapping Functions + Result Validator

**Files:**
- Create: `packages/core/src/execution/mapping.ts`
- Create: `packages/core/test/execution/mapping.test.ts`
- Create: `packages/core/test/execution/resultValidator.test.ts`

- [ ] **Step 1: Write mapping tests**

```typescript
// packages/core/test/execution/mapping.test.ts
import { describe, test, expect } from "bun:test";
import { toTaskResult, buildTaskPrompt } from "../../src/execution/mapping";
import { TaskStatus } from "../../src/task";

describe("toTaskResult", () => {
  const baseTask = {
    ID: "task-1",
    title: "Test task",
    description: "Test desc",
    priority: 1,
  };

  test("maps success ExecutionResult to TaskResult", () => {
    const er = {
      workUnitId: "task-1",
      status: "success" as const,
      commitHash: "abc123",
      branch: "fsc/task-1",
      worktreePath: "/tmp/test",
      startedAt: 1000,
      completedAt: 2000,
      agent: { type: "claude" },
      filesChanged: ["a.ts"],
      logs: [],
    };
    const result = toTaskResult(er, baseTask);
    expect(result.status).toBe(TaskStatus.SUCCESS);
    expect(result.commitHash).toBe("abc123");
    expect(result.worktreeBranch).toBe("fsc/task-1");
  });

  test("maps timeout to FAILURE", () => {
    const er = {
      workUnitId: "task-1",
      status: "timeout" as const,
      commitHash: null,
      branch: "fsc/task-1",
      worktreePath: "/tmp/test",
      startedAt: 1000,
      completedAt: 2000,
      agent: { type: "codex" },
      filesChanged: [],
      logs: [],
      error: { message: "timed out", category: "TRANSIENT" as const },
    };
    const result = toTaskResult(er, baseTask);
    expect(result.status).toBe(TaskStatus.FAILURE);
    expect(result.report).toContain("TRANSIENT");
  });
});

describe("buildTaskPrompt", () => {
  test("includes title and description", () => {
    const prompt = buildTaskPrompt({
      ID: "t1", title: "Fix bug", description: "Fix the null check", priority: 1,
    });
    expect(prompt).toContain("Fix bug");
    expect(prompt).toContain("Fix the null check");
    expect(prompt).toContain("Commit your changes");
  });
});
```

- [ ] **Step 2: Write result validator tests**

```typescript
// packages/core/test/execution/resultValidator.test.ts
import { describe, test, expect } from "bun:test";
import { validateResult } from "../../src/execution/mapping";

describe("validateResult", () => {
  const valid = {
    workUnitId: "task-1",
    status: "success",
    commitHash: "abc",
    branch: "fsc/task-1",
    worktreePath: "/tmp/x",
    startedAt: 1000,
    completedAt: 2000,
    agent: { type: "claude" },
    filesChanged: [],
    logs: [],
  };

  test("accepts valid result", () => {
    expect(() => validateResult(valid)).not.toThrow();
  });

  test("rejects missing required fields", () => {
    const { workUnitId, ...rest } = valid;
    expect(() => validateResult(rest)).toThrow("workUnitId");
  });

  test("rejects invalid status", () => {
    expect(() => validateResult({ ...valid, status: "bogus" })).toThrow("status");
  });

  test("accepts null commitHash", () => {
    expect(() => validateResult({ ...valid, commitHash: null })).not.toThrow();
  });

  test("rejects non-object input", () => {
    expect(() => validateResult("string")).toThrow("not an object");
    expect(() => validateResult(null)).toThrow("not an object");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/core && bun test test/execution/mapping.test.ts test/execution/resultValidator.test.ts`
Expected: FAIL

- [ ] **Step 4: Implement mapping.ts**

```typescript
// packages/core/src/execution/mapping.ts
import type { Task, TaskResult } from "../task";
import { TaskStatus } from "../task";
import type { ExecutionResult, WorkUnit, AgentConfig } from "./types";
import { AGENT_BUILDERS } from "./types";
import type { Config } from "../config";
import { routeTask } from "../modelRouter";
import { gitExec } from "./gitExec";

export function toTaskResult(er: ExecutionResult, originalTask: Task): TaskResult {
  const statusMap: Record<ExecutionResult["status"], TaskStatus> = {
    success: TaskStatus.SUCCESS,
    failure: TaskStatus.FAILURE,
    timeout: TaskStatus.FAILURE,
    error: TaskStatus.FAILURE,
  };

  return {
    ...originalTask,
    status: statusMap[er.status],
    report: er.error
      ? `[${er.error.category}] ${er.error.message}`
      : "Completed",
    completedAt: er.completedAt,
    gitDiff: undefined,
    commitHash: er.commitHash ?? undefined,
    worktreeBranch: er.branch,
  };
}

export function buildTaskPrompt(task: Task): string {
  let prompt = `# Task: ${task.title}\n\n${task.description}`;
  prompt += `\n\n## Constraints`;
  prompt += `\n- Only modify files relevant to this task`;
  prompt += `\n- Commit your changes when done`;
  prompt += `\n- Write tests if applicable`;
  return prompt;
}

export function toWorkUnit(
  task: Task,
  config: Config,
  repoPath: string,
): WorkUnit {
  const route = routeTask(task, config);
  const agentType = (route.primary || config.agentType || "claude") as AgentConfig["type"];

  return {
    id: task.ID,
    repoPath,
    baseBranch: getCurrentBranch(repoPath),
    taskPrompt: buildTaskPrompt(task),
    agentConfig: getAgentConfig(agentType, config),
    constraints: {
      timeoutMs: task.maxExecutionTimeMs ?? 300_000,
      maxTokens: task.estimatedTokens,
    },
    context: {
      memorixUri: (config as any).memorix?.uri,
      taskDeps: task.dependsOn,
    },
  };
}

function getCurrentBranch(repoPath: string): string {
  const result = gitExec(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
  return result.stdout.trim() || "main";
}

function getAgentConfig(type: AgentConfig["type"], config: Config): AgentConfig {
  const command = type === "custom" ? (config as any).customAgentCommand : type;
  const buildArgs = AGENT_BUILDERS[type as keyof typeof AGENT_BUILDERS]
    ?? AGENT_BUILDERS.claude;

  return { type, command, buildArgs };
}

// ─── Result Validator ───

const VALID_STATUSES = new Set(["success", "failure", "timeout", "error"]);
const REQUIRED_FIELDS = ["workUnitId", "status", "branch", "worktreePath", "startedAt", "completedAt"];

export function validateResult(data: unknown): ExecutionResult {
  if (!data || typeof data !== "object") {
    throw new Error("result.json: not an object");
  }

  const r = data as Record<string, unknown>;

  for (const key of REQUIRED_FIELDS) {
    if (!(key in r)) {
      throw new Error(`result.json: missing required field '${key}'`);
    }
  }

  if (!VALID_STATUSES.has(r.status as string)) {
    throw new Error(`result.json: invalid status '${r.status}'`);
  }

  if (r.commitHash !== null && r.commitHash !== undefined && typeof r.commitHash !== "string") {
    throw new Error(`result.json: commitHash must be string or null`);
  }

  return data as ExecutionResult;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/core && bun test test/execution/mapping.test.ts test/execution/resultValidator.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd D:/projects/full-self-coding
git add packages/core/src/execution/mapping.ts packages/core/test/execution/
git commit -m "feat(execution): add mapping functions + result.json validator"
```

---

## Task 5: LocalExecution

**Files:**
- Create: `packages/core/src/execution/local.ts`
- Create: `packages/core/test/execution/local.test.ts`

- [ ] **Step 1: Write LocalExecution tests**

Test with a mock agent (simple bash script that creates a file and commits):

```typescript
// packages/core/test/execution/local.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { LocalExecution } from "../../src/execution/local";
import { WorktreeManager } from "../../src/execution/worktree";
import { gitExec } from "../../src/execution/gitExec";
import type { WorkUnit } from "../../src/execution/types";
import fs from "fs";
import path from "path";
import os from "os";

describe("LocalExecution", () => {
  let testRepo: string;
  let execution: LocalExecution;

  beforeAll(() => {
    testRepo = path.resolve(os.tmpdir(), `fsc-local-test-${Date.now()}`);
    fs.mkdirSync(testRepo, { recursive: true });
    gitExec(["init"], testRepo);
    gitExec(["checkout", "-b", "main"], testRepo);
    fs.writeFileSync(path.resolve(testRepo, "README.md"), "test");
    gitExec(["add", "-A"], testRepo);
    gitExec([
      "commit", "--author", "Test <test@test.com>", "-m", "initial",
    ], testRepo);
    execution = new LocalExecution(new WorktreeManager());
  });

  afterAll(() => {
    new WorktreeManager().cleanup(testRepo);
    fs.rmSync(testRepo, { recursive: true, force: true });
    // Clean sibling dirs
    const parent = path.dirname(testRepo);
    const base = path.basename(testRepo);
    for (const e of fs.readdirSync(parent)) {
      if (e.startsWith(`${base}-fsc-`)) {
        fs.rmSync(path.resolve(parent, e), { recursive: true, force: true });
      }
    }
  });

  test("executes a simple agent that creates a file", async () => {
    // Use bash as a "mock agent" — creates a file and commits
    const shell = process.platform === "win32" ? "bash" : "/bin/sh";
    const unit: WorkUnit = {
      id: "local-test-1",
      repoPath: testRepo,
      baseBranch: "main",
      taskPrompt: "test prompt",
      agentConfig: {
        type: "custom",
        command: shell,
        buildArgs: () => ["-c", 'echo "hello" > test_output.txt && git add -A && git commit --author "Test <t@t>" -m "agent commit"'],
      },
      constraints: { timeoutMs: 10_000 },
    };

    const result = await execution.execute(unit);
    expect(result.status).toBe("success");
    expect(result.commitHash).toBeTruthy();
    expect(result.filesChanged).toContain("test_output.txt");
  });

  test("auto-commits uncommitted changes", async () => {
    const shell = process.platform === "win32" ? "bash" : "/bin/sh";
    const unit: WorkUnit = {
      id: "local-test-2",
      repoPath: testRepo,
      baseBranch: "main",
      taskPrompt: "test",
      agentConfig: {
        type: "custom",
        command: shell,
        // Agent creates file but does NOT commit
        buildArgs: () => ["-c", 'echo "uncommitted" > auto_commit_test.txt'],
      },
      constraints: { timeoutMs: 10_000 },
    };

    const result = await execution.execute(unit);
    // Should have auto-committed
    expect(result.commitHash).toBeTruthy();
    expect(result.filesChanged).toContain("auto_commit_test.txt");
  });

  test("handles timeout", async () => {
    const shell = process.platform === "win32" ? "bash" : "/bin/sh";
    const unit: WorkUnit = {
      id: "local-test-timeout",
      repoPath: testRepo,
      baseBranch: "main",
      taskPrompt: "test",
      agentConfig: {
        type: "custom",
        command: shell,
        buildArgs: () => ["-c", "sleep 30"],
      },
      constraints: { timeoutMs: 1_000 },  // 1s timeout
    };

    const result = await execution.execute(unit);
    expect(result.status).toBe("timeout");
  }, 10_000);

  test("returns null commitHash when agent makes no changes", async () => {
    const shell = process.platform === "win32" ? "bash" : "/bin/sh";
    const unit: WorkUnit = {
      id: "local-test-noop",
      repoPath: testRepo,
      baseBranch: "main",
      taskPrompt: "test",
      agentConfig: {
        type: "custom",
        command: shell,
        buildArgs: () => ["-c", "echo 'no changes'"],
      },
      constraints: { timeoutMs: 5_000 },
    };

    const result = await execution.execute(unit);
    expect(result.commitHash).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test test/execution/local.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement local.ts**

```typescript
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

      // Timeout
      const timeout = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, unit.constraints.timeoutMs);

      // Collect output
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      stdoutChunks = stdout.split("\n");
      stderrChunks = stderr.split("\n");

      await proc.exited;
      clearTimeout(timeout);
      exitCode = proc.exitCode;
    } catch (e: any) {
      if (!timedOut) {
        stderrChunks.push(e?.message || String(e));
      }
    } finally {
      this.running.delete(unit.id);
    }

    // 5. Auto-commit if agent left uncommitted changes
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
    // Check for uncommitted changes
    const status = gitExec(["status", "--porcelain"], worktreePath);
    if (status.stdout.trim()) {
      // Auto-commit
      gitExec(["add", "-A"], worktreePath);
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && bun test test/execution/local.test.ts`
Expected: PASS (may need adjustment for Windows shell paths)

- [ ] **Step 5: Commit**

```bash
cd D:/projects/full-self-coding
git add packages/core/src/execution/local.ts packages/core/test/execution/local.test.ts
git commit -m "feat(execution): add LocalExecution with auto-commit + timeout"
```

---

## Task 6: WorktreeCollector + Remote Stub

**Files:**
- Create: `packages/core/src/execution/collector.ts`
- Create: `packages/core/src/execution/remote.ts`
- Create: `packages/core/test/execution/collector.test.ts`

- [ ] **Step 1: Write collector tests**

```typescript
// packages/core/test/execution/collector.test.ts
import { describe, test, expect } from "bun:test";
import { WorktreeCollector } from "../../src/execution/collector";
import { WorktreeManager } from "../../src/execution/worktree";
import { validateResult } from "../../src/execution/mapping";

describe("WorktreeCollector", () => {
  test("validateResult is called on collected results", () => {
    // Unit test: validateResult rejects bad data
    expect(() => validateResult({ status: "bogus" })).toThrow();
  });

  // Integration tests require a real git repo with worktrees —
  // covered by Task 5's LocalExecution tests which write result.json
});
```

- [ ] **Step 2: Implement collector.ts**

```typescript
// packages/core/src/execution/collector.ts
import path from "path";
import fs from "fs";
import { WorktreeManager } from "./worktree";
import { validateResult, toTaskResult } from "./mapping";
import { gitExec } from "./gitExec";
import type { Task, TaskResult } from "../task";
import { TaskStatus } from "../task";
import type { ExecutionResult } from "./types";

export class WorktreeCollector {
  constructor(private worktreeManager: WorktreeManager) {}

  async collectAll(repoPath: string, tasks: Task[]): Promise<TaskResult[]> {
    const worktrees = this.worktreeManager.list(repoPath);
    const results: TaskResult[] = [];

    for (const wt of worktrees) {
      const resultFile = path.resolve(wt.worktreePath, ".fsc", "result.json");
      if (!fs.existsSync(resultFile)) continue;

      try {
        const raw = JSON.parse(fs.readFileSync(resultFile, "utf-8"));
        const er: ExecutionResult = validateResult(raw);
        const task = tasks.find(t => t.ID === er.workUnitId);
        if (!task) continue;
        results.push(toTaskResult(er, task));
      } catch (e: any) {
        console.warn(`[Collector] Invalid result.json in ${wt.taskId}: ${e.message}`);
      }
    }

    return results;
  }

  async collectInteractive(repoPath: string, tasks: Task[]): Promise<TaskResult[]> {
    const all = await this.collectAll(repoPath, tasks);
    const sep = "═".repeat(60);

    console.log(`\n${sep}`);
    console.log(`  FSC Worktree Results — ${all.length} tasks`);
    console.log(`${sep}\n`);

    const approved: TaskResult[] = [];

    for (const result of all) {
      const icon = result.status === TaskStatus.SUCCESS ? "✅" : "❌";
      console.log(`${icon} ${result.ID}: ${result.title}`);

      if (result.commitHash && result.worktreeBranch) {
        const diffStat = gitExec(
          ["diff", "--stat", `main...${result.worktreeBranch}`],
          repoPath,
        );
        if (diffStat.stdout.trim()) {
          console.log(diffStat.stdout);
        }
      }

      if (result.status === TaskStatus.SUCCESS && result.commitHash) {
        approved.push(result);
      } else {
        console.log(`   Skipped: ${result.report}`);
      }
    }

    console.log(`\n→ ${approved.length}/${all.length} tasks approved for merge\n`);
    return approved;
  }
}
```

- [ ] **Step 3: Implement remote.ts stub**

```typescript
// packages/core/src/execution/remote.ts
import type { ExecutionStrategy } from "./strategy";
import type { WorkUnit, ExecutionResult, ExecutionStatus } from "./types";

/**
 * Transport interface for remote execution.
 * Phase 2: RedisTransport will be a thin adapter over existing DistributedScheduler
 * Redis Streams implementation — reusing connection, serialization, consumer groups.
 */
export interface Transport {
  send(unit: WorkUnit): Promise<string>;
  poll(remoteId: string): Promise<ExecutionResult | null>;
  cancel(remoteId: string): Promise<void>;
}

export class RemoteExecution implements ExecutionStrategy {
  constructor(private transport: Transport) {}

  async execute(_unit: WorkUnit): Promise<ExecutionResult> {
    throw new Error(
      "RemoteExecution not yet implemented — Phase 2. " +
      "RedisTransport will reuse DistributedScheduler's Redis Streams implementation."
    );
  }

  async abort(_unitId: string): Promise<void> {
    throw new Error("RemoteExecution not yet implemented — Phase 2");
  }

  getStatus(_unitId: string): ExecutionStatus {
    return "pending";
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/core && bun test test/execution/collector.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd D:/projects/full-self-coding
git add packages/core/src/execution/collector.ts packages/core/src/execution/remote.ts packages/core/test/execution/collector.test.ts
git commit -m "feat(execution): add WorktreeCollector + RemoteExecution stub"
```

---

## Task 7: Integration — TaskSolverManager + CodeCommitter + Rename

**Files:**
- Modify: `packages/core/src/taskSolverManager.ts` — add worktree mode
- Modify: `packages/core/src/codeCommitter.ts` — add cherry-pick + safety checks
- Modify: `packages/core/src/taskExecutor.ts` — rename WorktreeExecutor → BareWorkspaceExecutor
- Modify: `packages/core/src/index.ts` — update exports
- Modify: `packages/core/test/codeCommitter.test.ts` — add cherry-pick test

- [ ] **Step 1: Rename WorktreeExecutor → BareWorkspaceExecutor in taskExecutor.ts**

Replace class name and export. Update `createTaskExecutor()`.

- [ ] **Step 2: Update index.ts exports**

Change `WorktreeExecutor` → `BareWorkspaceExecutor` in re-exports.

- [ ] **Step 3: Add cherry-pick + safety checks to CodeCommitter**

Add to `codeCommitter.ts`:

```typescript
// After existing processTaskResult method, add:

private async preCherryPickChecks(commitHash: string): Promise<string | null> {
  const cwd = this.gitRepoPath;

  // 1. Working tree clean
  const status = gitExec(["status", "--porcelain"], cwd);
  if (status.stdout.trim()) return "working tree is dirty";

  // 2. On correct branch
  const head = gitExec(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  // Just check we're not in detached HEAD
  if (head.stdout.trim() === "HEAD") return "detached HEAD state";

  // 3. Commit exists
  const exists = gitExec(["cat-file", "-t", commitHash], cwd);
  if (exists.exitCode !== 0) return `commit ${commitHash} does not exist`;

  // 4. Not already picked
  const ancestor = gitExec(["merge-base", "--is-ancestor", commitHash, "HEAD"], cwd);
  if (ancestor.exitCode === 0) return `commit ${commitHash} already in history (skip)`;

  return null;  // All checks pass
}

private cherryPick(commitHash: string): void {
  const result = gitExec(["cherry-pick", commitHash], this.gitRepoPath);
  if (result.exitCode !== 0) {
    // Abort the failed cherry-pick
    gitExec(["cherry-pick", "--abort"], this.gitRepoPath);
    throw new Error(result.stderr);
  }
}
```

Update `processTaskResult` to handle `commitHash`:

```typescript
// In processTaskResult, after existing gitDiff handling:
if (taskResult.commitHash) {
  const checkError = await this.preCherryPickChecks(taskResult.commitHash);
  if (checkError) {
    if (checkError.includes("skip")) {
      console.log(`[CodeCommitter] ${checkError}`);
      result.success = true;
      return result;
    }
    result.error = checkError;
    return result;
  }

  try {
    this.cherryPick(taskResult.commitHash);
    result.success = true;
    result.branchName = taskResult.worktreeBranch || "";
  } catch (e: any) {
    // Output conflict repair guide
    console.log(this.conflictGuide(taskResult));
    result.error = `MERGE_CONFLICT: ${e.message}`;
  }
  return result;
}
```

Add conflict guide method:

```typescript
private conflictGuide(taskResult: TaskResult): string {
  return `
╔═══════════════════════════════════════════════════╗
║  MERGE CONFLICT: Task ${taskResult.ID.padEnd(30)}║
╠═══════════════════════════════════════════════════╣
║  To resolve:                                      ║
║    cd ${this.gitRepoPath}
║    git cherry-pick ${taskResult.commitHash}
║    # fix conflicts
║    git add -A && git cherry-pick --continue
║                                                   ║
║  To skip:                                         ║
║    git cherry-pick --abort                        ║
║                                                   ║
║  To review:                                       ║
║    git diff main...${taskResult.worktreeBranch}
╚═══════════════════════════════════════════════════╝`;
}
```

- [ ] **Step 4: Add worktree mode to TaskSolverManager**

Add import and `startWorktreeMode()` method:

```typescript
import { LocalExecution } from './execution/local';
import { WorktreeManager } from './execution/worktree';
import { ConcurrencyPool } from './execution/concurrency';
import { toWorkUnit, toTaskResult } from './execution/mapping';

// In start() method, add at top:
async start() {
  const mode = (this.config as any).executionMode || "bare";
  if (mode === "worktree") {
    return this.startWorktreeMode();
  }
  // ... existing logic
}

private async startWorktreeMode() {
  const worktreeManager = new WorktreeManager();
  const strategy = new LocalExecution(worktreeManager);
  const pool = new ConcurrencyPool((this.config as any).maxParallelWorktrees ?? 5);

  // Preflight
  const agents = [...new Set(this.taskQueue.map(t => routeTask(t, this.config).primary))];
  const errors = worktreeManager.preflight(this.gitURL, agents);
  if (errors.length > 0) {
    throw new Error(`Preflight failed:\n${errors.join("\n")}`);
  }

  // Convert and execute
  const units = this.taskQueue.map(t => toWorkUnit(t, this.config, this.gitURL));

  const results = await Promise.allSettled(
    units.map((u, i) => pool.run(() => strategy.execute(u)))
  );

  // Map back to TaskResult
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      this.completedTasks.push(toTaskResult(r.value, this.taskQueue[i]));
    } else {
      this.completedTasks.push({
        ...this.taskQueue[i],
        status: TaskStatus.FAILURE,
        report: `Execution error: ${r.reason}`,
        completedAt: Date.now(),
      } as any);
    }
  }
}
```

- [ ] **Step 5: Run all tests**

Run: `cd packages/core && bun test`
Expected: PASS (existing tests + new tests)

- [ ] **Step 6: Commit**

```bash
cd D:/projects/full-self-coding
git add packages/core/src/taskExecutor.ts packages/core/src/taskSolverManager.ts packages/core/src/codeCommitter.ts packages/core/src/index.ts
git commit -m "feat(execution): integrate worktree mode into TaskSolverManager + CodeCommitter cherry-pick"
```

---

## Task 8: CLI Commands

**Files:**
- Modify: `packages/cli/src/index.ts` — add `--mode worktree`, `collect`, `cleanup`, `preflight`

- [ ] **Step 1: Add CLI commands**

Add to the Commander program:

```typescript
program
  .command('collect')
  .description('Collect results from existing FSC worktrees')
  .option('--interactive', 'Show diffs and confirm merges')
  .action(async (options) => {
    const { WorktreeManager, WorktreeCollector } = await import('@full-self-coding/core');
    const wm = new WorktreeManager();
    const collector = new WorktreeCollector(wm);
    // Load tasks from .fsc/tasks.json if exists
    const tasksFile = '.fsc/tasks.json';
    const tasks = fs.existsSync(tasksFile)
      ? JSON.parse(fs.readFileSync(tasksFile, 'utf-8')).tasks
      : [];
    if (options.interactive) {
      await collector.collectInteractive('.', tasks);
    } else {
      const results = await collector.collectAll('.', tasks);
      console.log(JSON.stringify(results, null, 2));
    }
  });

program
  .command('cleanup')
  .description('Remove all FSC worktrees and branches')
  .action(() => {
    const { WorktreeManager } = require('@full-self-coding/core');
    new WorktreeManager().cleanup('.');
    console.log('All FSC worktrees removed.');
  });

program
  .command('preflight')
  .description('Check prerequisites for worktree execution')
  .action(() => {
    const { WorktreeManager } = require('@full-self-coding/core');
    const errors = new WorktreeManager().preflight('.', ['claude']);
    if (errors.length === 0) {
      console.log('✅ All checks passed');
    } else {
      console.error('❌ Issues found:');
      errors.forEach(e => console.error(`  - ${e}`));
      process.exit(1);
    }
  });
```

Also update the `run` command to accept `--mode`:

```typescript
program
  .command('run')
  .option('-m, --mode <mode>', 'Execution mode: docker | bare | worktree', 'bare')
  .action(async (options) => {
    if (options.mode) {
      process.env.FSC_EXECUTION_MODE = options.mode;
    }
    // ... existing runFullAnalysis()
  });
```

- [ ] **Step 2: Run type check**

Run: `cd packages/core && bunx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
cd D:/projects/full-self-coding
git add packages/cli/src/index.ts
git commit -m "feat(cli): add worktree mode, collect, cleanup, preflight commands"
```

---

## Task Summary

| Task | What | Files | Est. |
|------|------|-------|------|
| 1 | Types & Interfaces | 5 files | 5 min |
| 2 | gitExec + ConcurrencyPool | 4 files | 5 min |
| 3 | WorktreeManager | 2 files | 10 min |
| 4 | Mapping + Validator | 3 files | 5 min |
| 5 | LocalExecution | 2 files | 10 min |
| 6 | Collector + Remote stub | 3 files | 5 min |
| 7 | Integration (TSM + CC + rename) | 4 files | 10 min |
| 8 | CLI commands | 1 file | 5 min |

**Total: 8 tasks, 29 files, ~55 min agent time**

Tasks 1-6 are independent and can be parallelized. Task 7 depends on 1-6. Task 8 depends on 7.

**Parallel execution plan:**
- Wave 1 (parallel): Tasks 1, 2, 3, 4
- Wave 2 (parallel): Tasks 5, 6 (depend on 1-4)
- Wave 3 (sequential): Task 7 (integration)
- Wave 4 (sequential): Task 8 (CLI)
