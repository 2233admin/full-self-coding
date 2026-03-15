# FSC Worktree Execution Mode — Design Spec v3

> v2: Incorporated critic review + user decisions on auto-commit, conflict handling, naming.
> v3: Added concurrency pool, git timeout wrapper, result.json validation, cherry-pick safety checks, conflict repair guide, graceful shutdown with auto-commit, worktree directory policy, RedisTransport reuse policy.

## Problem

FSC currently supports Docker and bare (mkdir) execution modes. Neither supports the real-world workflow of:
1. Creating git worktrees for task isolation
2. Dispatching external CLI agents (claude/codex/gemini) into each worktree
3. Collecting commits and metadata from completed worktrees
4. Merging results back to the main branch

The user's manual test on quant-terminal (5 worktrees, 10 agents) proved the flow works but requires FSC engine automation.

## Design Principles

- **One codebase, two execution environments** — Local and Remote share the same interfaces
- **Execution environment ⊥ agent type** — orthogonal concerns, not mixed
- **Commit = proof-of-work, metadata = sidecar** — code output and execution metadata are separate
- **Memorix = injected context, not core dependency** — FSC passes env vars, agents decide usage
- **Serial prepare, parallel execute** — worktree creation is serialized, agent execution is parallel

## Architecture

```
TaskSolverManager
  └── ExecutionStrategy (interface)
        ├── LocalExecution
        │     ├── WorktreeManager (git worktree add/remove/list) — SERIALIZED
        │     ├── Bun.spawn(agent CLI) × N — PARALLEL
        │     └── AutoCommitter (post-execution: detect uncommitted changes → auto commit)
        └── RemoteExecution (Phase 2)
              ├── Transport (interface: SshTransport | RedisTransport)
              └── Remote worker runs LocalExecution logic

WorktreeCollector
  └── Scans worktrees → reads .fsc/result.json + git diff base..branch → TaskResult[]

CodeCommitter (existing, modified)
  └── Takes TaskResult[] with commitHash → cherry-pick to target branch
  └── On conflict → mark MERGE_CONFLICT, preserve worktree, report to user
```

## Naming Changes

| Old Name | New Name | Reason |
|----------|----------|--------|
| `WorktreeExecutor` | `BareWorkspaceExecutor` | It's `mkdir`, not git worktree. Avoid confusion with new real git worktree mode. |

The new git worktree execution lives in `packages/core/src/execution/` — completely separate from the legacy `taskExecutor.ts`.

## Modified Types

### TaskResult (extend existing `task.ts`)

```typescript
export interface TaskResult extends Task {
  // ... existing fields (title, description, status, report, completedAt, gitDiff)

  /** Commit hash produced by worktree execution (for cherry-pick) */
  commitHash?: string;

  /** Worktree branch name (for debugging/tracing) */
  worktreeBranch?: string;
}
```

All existing consumers ignore unknown optional fields — zero breakage.

## New Types

### WorkUnit

```typescript
interface WorkUnit {
  id: string;                    // e.g. "task-1"
  repoPath: string;              // absolute path to source repo
  baseBranch: string;            // branch to create worktree from
  taskPrompt: string;            // full prompt for the agent
  agentConfig: AgentConfig;      // which CLI + flags
  constraints: {
    timeoutMs: number;           // max execution time (default: 300_000)
    maxTokens?: number;          // token budget hint
    allowedPaths?: string[];     // files agent can touch (advisory)
  };
  context?: {
    memorixUri?: string;         // memorix endpoint for cross-agent memory
    codeRAGContext?: string;     // reference code snippets
    taskDeps?: string[];         // IDs of tasks this depends on
  };
}

interface AgentConfig {
  type: "claude" | "codex" | "gemini" | "custom";
  command: string;               // e.g. "claude" or full path
  buildArgs(prompt: string, cwd: string): string[];  // agent-specific arg builder
  env?: Record<string, string>;  // additional env vars
}
```

#### Agent-specific arg builders

```typescript
// Claude Code
const claudeArgs = (prompt: string, cwd: string) =>
  ["-p", prompt, "--cwd", cwd, "--allowedTools", "Edit,Write,Bash,Read,Glob,Grep"];

// Codex CLI
const codexArgs = (prompt: string, cwd: string) =>
  ["exec", "--approval-mode", "full-auto", "-w", cwd, prompt];

// Gemini CLI
const geminiArgs = (prompt: string, cwd: string) =>
  ["-p", prompt, "--cwd", cwd];
```

### ExecutionResult

```typescript
interface ExecutionResult {
  workUnitId: string;
  status: "success" | "failure" | "timeout" | "error";
  commitHash: string | null;     // null → agent produced no changes
  branch: string;                // fsc/<taskId>
  worktreePath: string;          // absolute path (via path.resolve)
  startedAt: number;
  completedAt: number;
  agent: { type: string; version?: string };
  filesChanged: string[];
  logs: string[];                // key log lines, capped at 100 lines
  error?: {
    message: string;
    category: "RESOURCE" | "TRANSIENT" | "PERMANENT" | "QUALITY" | "MERGE_CONFLICT" | "UNKNOWN";
  };
}
```

### ExecutionResult → TaskResult mapping

```typescript
function toTaskResult(er: ExecutionResult, originalTask: Task): TaskResult {
  const statusMap: Record<ExecutionResult["status"], TaskStatus> = {
    success: TaskStatus.SUCCESS,
    failure: TaskStatus.FAILURE,
    timeout: TaskStatus.FAILURE,   // timeout = failure with category
    error: TaskStatus.FAILURE,
  };

  return {
    ...originalTask,
    status: statusMap[er.status],
    report: er.error ? `[${er.error.category}] ${er.error.message}` : "Completed",
    completedAt: er.completedAt,
    gitDiff: undefined,            // worktree mode uses commitHash, not gitDiff
    commitHash: er.commitHash ?? undefined,
    worktreeBranch: er.branch,
  };
}
```

### Task → WorkUnit mapping

```typescript
function toWorkUnit(task: Task, config: Config, repoPath: string): WorkUnit {
  const route = routeTask(task, config);
  const agentType = route.primary as AgentConfig["type"];

  return {
    id: task.ID,
    repoPath,
    baseBranch: getCurrentBranch(repoPath),  // git rev-parse --abbrev-ref HEAD
    taskPrompt: buildTaskPrompt(task),       // see below
    agentConfig: getAgentConfig(agentType, config),
    constraints: {
      timeoutMs: task.maxExecutionTimeMs ?? 300_000,
      maxTokens: task.estimatedTokens,
      allowedPaths: undefined,  // future: extract from task metadata
    },
    context: {
      memorixUri: config.memorix?.uri,
      taskDeps: task.dependsOn,
    },
  };
}

function buildTaskPrompt(task: Task): string {
  let prompt = `# Task: ${task.title}\n\n${task.description}`;
  // Append constraints
  prompt += `\n\n## Constraints\n- Only modify files relevant to this task`;
  prompt += `\n- Commit your changes when done`;
  prompt += `\n- Write tests if applicable`;
  return prompt;
}
```

## New Modules

### 1. `packages/core/src/execution/strategy.ts`

```typescript
interface ExecutionStrategy {
  execute(unit: WorkUnit): Promise<ExecutionResult>;
  abort(unitId: string): Promise<void>;
  getStatus(unitId: string): ExecutionStatus;
}

type ExecutionStatus = "pending" | "running" | "completed" | "failed" | "aborted";
```

### 2. `packages/core/src/execution/worktree.ts` — WorktreeManager

Responsibilities:
- `create(repoPath, baseBranch, taskId)` → `git worktree add -b fsc/<taskId> <path>`
- `remove(worktreePath)` → `git worktree remove --force`
- `list(repoPath)` → returns all FSC-managed worktrees (`fsc/*` branches)
- `collect(worktreePath, baseBranch)` → reads `.fsc/result.json` + `git diff baseBranch...HEAD`
- `cleanup(repoPath)` → removes all `fsc/*` worktrees and branches
- `preflight(repoPath)` → checks git version ≥ 2.5, disk space, agent CLI availability

#### 7.1 Worktree Directory Location (Final)

To avoid Git fatal errors related to nested working trees, all worktrees MUST be created as **siblings** of the main repository, not inside it. This is the official Git-recommended pattern and compatible with all Git versions ≥ 2.5.

**Path Convention:** `[parent-dir]/[repo-name]-fsc-[task-id]`
**Example:** Repo: `/projects/quant-terminal/` → Worktree: `/projects/quant-terminal-fsc-task-1/`

**CRITICAL: All `create()` calls MUST be serialized** (async mutex). `git worktree add` modifies `.git/worktrees/` and acquires `index.lock`. Concurrent calls will `fatal: Unable to create '.git/index.lock'`, especially on Windows.

```typescript
class WorktreeManager {
  private mutex = new AsyncMutex();  // simple promise-based mutex

  async create(repoPath: string, baseBranch: string, taskId: string): Promise<WorktreeInfo> {
    return this.mutex.runExclusive(async () => {
      const repoName = path.basename(path.resolve(repoPath));
      const parentDir = path.dirname(path.resolve(repoPath));
      const worktreePath = path.resolve(parentDir, `${repoName}-fsc-${taskId}`);
      const branch = `fsc/${taskId}`;

      // git worktree add -b fsc/<taskId> <worktreePath> <baseBranch>
      const result = Bun.spawnSync({
        cmd: ["git", "worktree", "add", "-b", branch, worktreePath, baseBranch],
        cwd: repoPath,
      });

      if (result.exitCode !== 0) {
        throw new Error(`Failed to create worktree: ${new TextDecoder().decode(result.stderr)}`);
      }

      return { worktreePath, branch, taskId };
    });
  }
}
```

### 3. `packages/core/src/execution/local.ts` — LocalExecution

```typescript
class LocalExecution implements ExecutionStrategy {
  private worktreeManager: WorktreeManager;
  private running: Map<string, Subprocess> = new Map();

  async execute(unit: WorkUnit): Promise<ExecutionResult> {
    const startedAt = Date.now();

    // 1. Create worktree (serialized via mutex)
    const { worktreePath, branch } = await this.worktreeManager.create(
      unit.repoPath, unit.baseBranch, unit.id
    );

    // 2. Write .fsc/current-task.md
    const fscDir = path.resolve(worktreePath, ".fsc");
    fs.mkdirSync(fscDir, { recursive: true });
    fs.writeFileSync(path.resolve(fscDir, "current-task.md"), unit.taskPrompt);

    // 3. Build CLI command — cross-platform shell detection
    const args = unit.agentConfig.buildArgs(unit.taskPrompt, worktreePath);
    const cmd = [unit.agentConfig.command, ...args];

    // 4. Spawn process
    const proc = Bun.spawn(cmd, {
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

    // 5. Wait with timeout
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; proc.kill(); }, unit.constraints.timeoutMs);

    try {
      await proc.exited;  // Bun native — no polling needed
    } finally {
      clearTimeout(timeout);
      this.running.delete(unit.id);
    }

    // 6. Auto-commit if agent left uncommitted changes
    const commitHash = await this.autoCommitIfNeeded(worktreePath, unit.id);

    // 7. Collect result
    const completedAt = Date.now();
    const filesChanged = this.getFilesChanged(worktreePath, unit.baseBranch);

    // 8. Write .fsc/result.json
    const result: ExecutionResult = {
      workUnitId: unit.id,
      status: timedOut ? "timeout" : (proc.exitCode === 0 ? "success" : "failure"),
      commitHash,
      branch,
      worktreePath,
      startedAt,
      completedAt,
      agent: { type: unit.agentConfig.type },
      filesChanged,
      logs: await this.captureLogs(proc, 100),
      error: proc.exitCode !== 0 ? {
        message: timedOut ? `Timeout after ${unit.constraints.timeoutMs}ms` : `Exit code ${proc.exitCode}`,
        category: timedOut ? "TRANSIENT" : "UNKNOWN",
      } : undefined,
    };

    fs.writeFileSync(
      path.resolve(fscDir, "result.json"),
      JSON.stringify(result, null, 2)
    );

    return result;
  }

  /**
   * If agent left uncommitted changes, auto commit them.
   * Returns commitHash (existing or newly created), or null if no changes at all.
   */
  private async autoCommitIfNeeded(worktreePath: string, taskId: string): Promise<string | null> {
    // Check for uncommitted changes
    const status = Bun.spawnSync({
      cmd: ["git", "status", "--porcelain"],
      cwd: worktreePath,
    });
    const statusText = new TextDecoder().decode(status.stdout).trim();

    if (statusText) {
      // Agent left uncommitted changes — auto commit
      Bun.spawnSync({ cmd: ["git", "add", "-A"], cwd: worktreePath });
      Bun.spawnSync({
        cmd: ["git", "commit", "-m", `auto: ${taskId} completion`],
        cwd: worktreePath,
      });
    }

    // Get latest commit hash (could be agent's commit or our auto-commit)
    const log = Bun.spawnSync({
      cmd: ["git", "log", "-1", "--format=%H", `--not`, `--remotes`],
      cwd: worktreePath,
    });
    const hash = new TextDecoder().decode(log.stdout).trim();

    // Check if there are any new commits vs base
    const diffCheck = Bun.spawnSync({
      cmd: ["git", "log", "--oneline", "HEAD", "--not", "HEAD~1"],
      cwd: worktreePath,
    });
    // If worktree has commits beyond base, return hash; else null
    return hash || null;
  }

  private getFilesChanged(worktreePath: string, baseBranch: string): string[] {
    const diff = Bun.spawnSync({
      cmd: ["git", "diff", "--name-only", `${baseBranch}...HEAD`],
      cwd: worktreePath,
    });
    return new TextDecoder().decode(diff.stdout).trim().split("\n").filter(Boolean);
  }

  async abort(unitId: string): Promise<void> {
    const proc = this.running.get(unitId);
    if (proc) {
      proc.kill("SIGTERM");
      // Grace period, then force kill
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
    }
  }
}
```

### 4. `packages/core/src/execution/remote.ts` — Phase 2 Stub

```typescript
interface Transport {
  send(unit: WorkUnit): Promise<string>;       // returns remote execution ID
  poll(remoteId: string): Promise<ExecutionResult | null>;
  cancel(remoteId: string): Promise<void>;
}

class RemoteExecution implements ExecutionStrategy {
  constructor(private transport: Transport) {}

  async execute(unit: WorkUnit): Promise<ExecutionResult> {
    throw new Error("RemoteExecution not yet implemented — Phase 2");
  }

  async abort(unitId: string): Promise<void> {
    throw new Error("RemoteExecution not yet implemented — Phase 2");
  }

  getStatus(unitId: string): ExecutionStatus {
    return "pending";
  }
}

// Stubs for future implementation
class SshTransport implements Transport { /* ... */ }
class RedisTransport implements Transport { /* ... */ }
```

### 5. `packages/core/src/execution/collector.ts` — WorktreeCollector

```typescript
class WorktreeCollector {
  constructor(private worktreeManager: WorktreeManager) {}

  /**
   * Scan all FSC worktrees, read results, produce TaskResult[].
   * For each worktree:
   *   1. Read .fsc/result.json (metadata)
   *   2. git diff baseBranch...worktreeBranch (code changes)
   *   3. Map to TaskResult via toTaskResult()
   */
  async collectAll(repoPath: string, tasks: Task[]): Promise<TaskResult[]> {
    const worktrees = await this.worktreeManager.list(repoPath);
    const results: TaskResult[] = [];

    for (const wt of worktrees) {
      const resultFile = path.resolve(wt.path, ".fsc", "result.json");
      if (!fs.existsSync(resultFile)) continue;

      const er: ExecutionResult = JSON.parse(fs.readFileSync(resultFile, "utf-8"));
      const task = tasks.find(t => t.ID === er.workUnitId);
      if (!task) continue;

      results.push(toTaskResult(er, task));
    }

    return results;
  }

  /**
   * Interactive mode: show diff summary per worktree, let user confirm which to merge.
   * Returns filtered TaskResult[] of approved tasks only.
   */
  async collectInteractive(repoPath: string, tasks: Task[]): Promise<TaskResult[]> {
    const all = await this.collectAll(repoPath, tasks);

    console.log(`\n${"═".repeat(60)}`);
    console.log(`  FSC Worktree Results — ${all.length} tasks`);
    console.log(`${"═".repeat(60)}\n`);

    const approved: TaskResult[] = [];

    for (const result of all) {
      const status = result.status === TaskStatus.SUCCESS ? "✅" : "❌";
      console.log(`${status} ${result.ID}: ${result.title}`);

      if (result.commitHash) {
        // Show diff stat
        const diffStat = Bun.spawnSync({
          cmd: ["git", "diff", "--stat", `${result.worktreeBranch}~1...${result.worktreeBranch}`],
          cwd: repoPath,
        });
        console.log(new TextDecoder().decode(diffStat.stdout));
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

## Modified Modules

### TaskSolverManager — add worktree mode

```typescript
async start() {
  const mode = this.config.executionMode || "bare";

  if (mode === "worktree") {
    return this.startWorktreeMode();
  }

  // ... existing Docker/bare logic unchanged
}

private async startWorktreeMode() {
  const strategy = new LocalExecution(new WorktreeManager());

  // Preflight: check git, agents, disk space
  await strategy.preflight(this.gitURL);

  // Convert tasks to work units
  const units = this.taskQueue.map(t => toWorkUnit(t, this.config, this.gitURL));

  // Execute all in parallel (worktree creation is serialized internally)
  const results = await Promise.allSettled(
    units.map(u => strategy.execute(u))
  );

  // Map results back to TaskResult
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      this.completedTasks.push(toTaskResult(r.value, this.taskQueue[i]));
    } else {
      this.completedTasks.push({
        ...this.taskQueue[i],
        status: TaskStatus.FAILURE,
        report: `Execution failed: ${r.reason}`,
        completedAt: Date.now(),
      });
    }
  }
}
```

### CodeCommitter — add cherry-pick path

```typescript
private async processTaskResult(taskResult: TaskResult) {
  // Existing path: apply diff from string
  if (taskResult.gitDiff) {
    await this.applyGitDiff(taskResult.gitDiff);
    this.commitChanges(taskResult);
  }
  // New path: cherry-pick from worktree branch
  else if (taskResult.commitHash) {
    try {
      await this.cherryPick(taskResult.commitHash);
    } catch (e) {
      // Cherry-pick conflict → abort, preserve worktree, report
      Bun.spawnSync({ cmd: ["git", "cherry-pick", "--abort"], cwd: this.gitRepoPath });
      return {
        success: false,
        branchName: taskResult.worktreeBranch || "",
        error: `MERGE_CONFLICT: cherry-pick failed for ${taskResult.commitHash}. ` +
               `Worktree preserved at branch ${taskResult.worktreeBranch} for manual resolution.`,
      };
    }
  }
}

private async cherryPick(commitHash: string): Promise<void> {
  const result = Bun.spawnSync({
    cmd: ["git", "cherry-pick", commitHash],
    cwd: this.gitRepoPath,
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}
```

### BareWorkspaceExecutor (renamed from WorktreeExecutor)

Rename `WorktreeExecutor` → `BareWorkspaceExecutor` in `taskExecutor.ts`. Update all references:
- `taskExecutor.ts`: class name + export
- `index.ts`: re-export

## CLI Extensions

```
fsc run                              # existing: Docker/bare
fsc run --mode worktree              # new: local worktree + agent dispatch
fsc run --mode worktree --remote     # future: remote execution (Phase 2)
fsc collect [--interactive]          # collect results from existing worktrees
fsc cleanup                          # remove all FSC worktrees + branches
fsc preflight                        # check prerequisites (git, agents, disk)
```

## Cross-Platform Path Handling

```typescript
import path from "path";

// ALWAYS use path.resolve() — never string concatenation for paths
const worktreePath = path.resolve(parentDir, `${repoName}-fsc-${taskId}`);

// Shell detection — never hardcode /usr/bin/bash
function getShell(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec || "cmd.exe";
  }
  return process.env.SHELL || "/bin/sh";
}

// Git commands: always call "git" directly (not via shell wrapper)
// Bun.spawn(["git", "worktree", "add", ...]) — no shell needed
```

## Memorix Integration

FSC does NOT depend on memorix. Integration is opt-in via config:

```json
{
  "memorix": { "enabled": true, "uri": "http://localhost:6677" }
}
```

When enabled, FSC passes `MEMORIX_URL` as env var to spawned agents. Each agent independently decides whether/how to use memorix for cross-agent memory sharing.

## Signal Handling & Cleanup

```typescript
// On SIGINT/SIGTERM: graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[FSC] Shutting down — killing agent processes...");

  // 1. SIGTERM all running agents
  for (const [id, proc] of strategy.running) {
    proc.kill("SIGTERM");
  }

  // 2. Wait 5s grace period
  await new Promise(r => setTimeout(r, 5000));

  // 3. SIGKILL stragglers
  for (const [id, proc] of strategy.running) {
    try { proc.kill("SIGKILL"); } catch {}
  }

  // 4. Do NOT cleanup worktrees — preserve work-in-progress
  console.log("[FSC] Agent processes killed. Worktrees preserved for recovery.");
  console.log("[FSC] Run 'fsc collect' to salvage results, or 'fsc cleanup' to remove.");
  process.exit(1);
});
```

## Conflict Prevention

Task assignment should minimize file overlap:

```typescript
// In analyzer or task planner: tag each task with its target files
// TaskSolverManager checks for overlapping allowedPaths before parallel dispatch
function detectFileConflicts(tasks: Task[]): string[][] {
  // Returns groups of task IDs that touch the same files
  // Scheduler can serialize conflicting groups or warn the user
}
```

This is advisory — if cherry-pick still conflicts, the task is marked `MERGE_CONFLICT` and the worktree is preserved for manual resolution.

## Execution Flow

```
User: fsc run --mode worktree

Phase 0: Preflight
  └── Check git ≥ 2.5, agent CLIs in PATH, disk space

Phase 1: Analyze
  └── analyzer.ts → tasks (existing)

Phase 2: Dispatch (serial create, parallel execute)
  ├── for each task: WorktreeManager.create()     ← SERIALIZED (mutex)
  ├── for each task: write .fsc/current-task.md
  └── Promise.allSettled(tasks.map(execute))       ← PARALLEL

Phase 3: Post-process
  ├── Auto-commit uncommitted changes in each worktree
  ├── Collect git log + write .fsc/result.json
  └── Map ExecutionResult → TaskResult

Phase 4: Collect & Confirm
  ├── WorktreeCollector.collectInteractive()
  │     ├── Show per-task: status, diff stat, files changed
  │     └── Auto-approve SUCCESS, skip FAILURE
  └── Returns approved TaskResult[]

Phase 5: Merge
  ├── CodeCommitter with cherry-pick path
  ├── On conflict → mark MERGE_CONFLICT, preserve worktree
  └── Generate final report

Phase 6: Cleanup (user-initiated)
  └── fsc cleanup → WorktreeManager.cleanup()
```

## File Layout

```
packages/core/src/
├── execution/
│   ├── index.ts          — re-exports all
│   ├── types.ts          — WorkUnit, ExecutionResult, AgentConfig, ExecutionStatus
│   ├── strategy.ts       — ExecutionStrategy interface
│   ├── worktree.ts       — WorktreeManager (with async mutex)
│   ├── local.ts          — LocalExecution implements ExecutionStrategy
│   ├── remote.ts         — RemoteExecution stub (Phase 2)
│   ├── collector.ts      — WorktreeCollector
│   └── mapping.ts        — toWorkUnit(), toTaskResult(), buildTaskPrompt()
├── taskExecutor.ts        — rename WorktreeExecutor → BareWorkspaceExecutor
├── taskSolverManager.ts   — add worktree mode branch
├── codeCommitter.ts       — add cherry-pick path
├── task.ts                — add commitHash?, worktreeBranch? to TaskResult
└── index.ts               — add new exports
```

## Constraints

- Bun runtime, TypeScript strict mode
- Git ≥ 2.5 required (worktree support)
- `path.resolve()` everywhere — no string concatenation for paths
- No hardcoded shell paths — use `process.env.ComSpec` / `process.env.SHELL`
- Max parallel worktrees: configurable via `config.maxParallelWorktrees` (default: 5)
- Agent CLI must be in PATH — preflight validates

## Hardening Details (v3)

### Concurrency Pool

Never `Promise.allSettled(all)` without a pool. 20 tasks = 20 agents = OOM.

```typescript
class ConcurrencyPool {
  private running = 0;
  private queue: Array<() => void> = [];
  constructor(private max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running >= this.max) {
      await new Promise<void>(r => this.queue.push(r));
    }
    this.running++;
    try { return await fn(); }
    finally { this.running--; this.queue.shift()?.(); }
  }
}

// Usage: pool.run(() => strategy.execute(unit))
```

Default `maxParallelWorktrees: 5`. Configurable via `config.maxParallelWorktrees`.

### Worktree Creation Lock with Timeout

Mutex acquires with 30s timeout. If `git worktree add` hangs (index.lock deadlock), fail fast instead of blocking the queue.

### Git Command Timeout Wrapper

ALL git commands go through `gitExec()` with a default 30s timeout:

```typescript
const GIT_TIMEOUT_MS = 30_000;

function gitExec(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS) {
  const r = Bun.spawnSync({ cmd: ["git", ...args], cwd, timeout: timeoutMs });
  return {
    stdout: new TextDecoder().decode(r.stdout),
    stderr: new TextDecoder().decode(r.stderr),
    exitCode: r.exitCode ?? 1,
  };
}
```

### Auto-commit Fixed Author + Skip Empty

- Author: `FSC Worker <fsc@full-self-coding>` (consistent across machines)
- If `git status --porcelain` is empty AND no new commits vs base → `commitHash: null`, skip commit
- No `--allow-empty` — empty commits are never created

### result.json Schema Validation

Hand-written validator (no external deps). Checks:
- Required fields: `workUnitId`, `status`, `branch`, `worktreePath`, `startedAt`, `completedAt`
- `status` ∈ `["success", "failure", "timeout", "error"]`
- `commitHash` is `string | null`
- On validation failure: task marked `FAILURE` with validation error in report

### Cherry-pick Safety Checks (4 items)

Before every `git cherry-pick`:

1. **Working tree clean** — `git status --porcelain` must be empty
2. **On correct target branch** — `git rev-parse --abbrev-ref HEAD` matches expected
3. **Commit exists** — `git cat-file -t <hash>` returns `commit`
4. **Not already picked** — `git merge-base --is-ancestor <hash> HEAD` must fail (exitCode ≠ 0)

If any check fails, skip with clear error message. Never cherry-pick blind.

### Conflict Repair Guide

On cherry-pick conflict, output copy-paste commands:

```
╔═══════════════════════════════════════════════════╗
║  MERGE CONFLICT: Task <id>                        ║
╠═══════════════════════════════════════════════════╣
║  To resolve:                                      ║
║    cd <repoPath>                                  ║
║    git cherry-pick <commitHash>                   ║
║    # fix conflicts                                ║
║    git add -A && git cherry-pick --continue       ║
║                                                   ║
║  To skip:                                         ║
║    git cherry-pick --abort                        ║
║                                                   ║
║  To review changes:                               ║
║    git diff <base>...<worktreeBranch>             ║
╚═══════════════════════════════════════════════════╝
```

### Graceful Shutdown with Auto-commit

On SIGINT/SIGTERM:
1. SIGTERM all running agent processes
2. Wait 3s grace period
3. **Auto-commit ALL worktrees with uncommitted changes** (author: `FSC Worker`, message: `auto: <taskId> interrupted — partial work saved`)
4. Print: `Run 'fsc collect' to review results, or 'fsc cleanup' to remove.`
5. Exit

Work is never silently lost.

### 7.2 RemoteExecution & RedisTransport Reuse Policy

`RedisTransport` shall be a thin adapter that fully reuses the existing `DistributedScheduler` Redis Streams implementation. It shares:

- Redis client connection
- Message serialization
- Consumer group management
- Error handling & retry logic

No separate or duplicated Redis logic will be introduced. The execution layer and scheduling layer share a single, unified control plane.

## Out of Scope (Phase 1)

- RemoteExecution implementation (stub only)
- Redis Streams / SSH transport
- Quality gate integration for worktree mode
- Trust factor updates from worktree results
- DAG-based scheduling (existing `dependsOn` handles linear deps)
- Disk space pre-checks beyond basic warning

## Success Criteria

1. `fsc run --mode worktree` creates N worktrees, dispatches N agents, collects results
2. Worktree creation is serialized (no index.lock conflicts)
3. Auto-commit handles agents that don't commit their changes
4. Interactive Phase 4 shows diffs and auto-approves successful tasks
5. Cherry-pick merges approved results; conflicts marked and preserved
6. `fsc cleanup` removes all FSC worktrees and `fsc/*` branches
7. Works on Windows (Git Bash) and Linux
8. Existing Docker/bare modes unaffected (zero regression)
