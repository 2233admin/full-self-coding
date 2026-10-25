# Scale benchmark: native worktree pipeline with mock agents

Date: 2026-10-26. Issue: #10. Script: `script/bench/scale.ts`.

## What this measures, and what it does not

Measured: the orchestration layer only, `UnifiedScheduler` -> `LocalExecution` (one git worktree + branch per task) -> `CommitSequencer` (serial cherry-pick onto the base branch), with a mock agent that writes one file (`bash -c`) and optionally sleeps. No model is called.

Not measured: model latency, model rate limits or cost, agent memory, real repositories.

Setup: one Windows Server 2025 machine, local NTFS, repository of 201 small files (about 40 KB of working tree), `git` on PATH. Other sessions were running on the same machine, so absolute numbers carry noise. Reproduce:

```
bun script/bench/scale.ts --n 200 --concurrency 16 --overlap none --agent-ms 0
```

## Results

All runs finished with `executionFailed = 0`, no leftover worktrees, and (for `overlap=none`) every commit merged.

### Independent tasks (each task writes its own file), mock agent 0 ms

| tasks | concurrency | total | exec | merge | cleanup | tasks/min | build |
|---:|---:|---:|---:|---:|---:|---:|---|
| 50 | 5 | 18.6 s | 12.9 s | 4.6 s | 1.1 s | 161 | after fix |
| 200 | 5 | 86.5 s | 63.0 s | 18.5 s | 5.0 s | 139 | after fix |
| 200 | 16 | 80.8 s | 57.5 s | 18.7 s | 4.6 s | 148 | after fix |
| 1000 | 16 | 461.9 s | 325.3 s | 111.7 s | 24.9 s | 130 | after fix |
| 200 | 16 | 113.8 s | 66.3 s | 28.1 s | 19.4 s | 105 | before fix |
| 1000 | 16 | 1206.2 s | 744.1 s | 110.4 s | 351.6 s | 50 | before fix |

"Fix" = worktrees are removed as soon as a task finishes. Before it, every worktree stayed alive until the end of the run (1000 live checkouts at 1000 tasks) and the end-of-run cleanup took 352 s; after it, 25 s.

### With simulated agent work (5 s per task)

| tasks | concurrency | total | exec | merge |
|---:|---:|---:|---:|---:|
| 100 | 5 | 119.9 s | 107.7 s | 9.9 s |
| 100 | 16 | 49.2 s | 38.0 s | 8.9 s |
| 200 | 16 | 96.1 s | 71.4 s | 19.3 s |

Ideal exec time is waves x 5 s: 100 s, 35 s and 65 s. Measured is within about 10 % of that, so with a 5 s agent the pipeline is agent-bound and scales with concurrency.

### Tasks that all rewrite the same line of one file (worst-case overlap), 0 ms agent (before the cleanup fix)

| tasks | concurrency | total | merged | conflicts | branches kept for recovery |
|---:|---:|---:|---:|---:|---:|
| 50 | 5 | 64.8 s | 1 | 49 | 49 |
| 200 | 16 | 136.1 s | 1 | 199 | 199 |

One task wins, every other task is reported as `MERGE_CONFLICT` and kept on its `fsc/<task>` branch. Each conflict costs about 130 to 320 ms in the merge step. Nothing is lost, but 99.5 % of the agent work in this scenario is wasted, and FSC does nothing to avoid it (conflict-aware scheduling is #6).

## Findings

1. **Starting tasks is serialized.** `WorktreeManager.create` runs under one mutex and takes about 300 ms here (a `git worktree add` of 201 files). Exec time per task is about 270 to 325 ms whether concurrency is 5 or 16 (rows 1 to 4). That caps task starts at roughly 190 per minute on this machine and repository. With real agents that run for tens of seconds the cap is hidden: a 60 s agent only reaches it at about 60 s / 0.3 s = 200 simultaneous agents.
2. **Merging is serial and linear**: about 90 to 110 ms per commit, about 9 per second, 112 s for 1000 commits. It does not grow with the number of tasks. At 200 simultaneous 60 s agents it would need about 3 commits per second, far under the cap.
3. **Cleanup was the superlinear cost** (22 ms per task at 50, 350 ms per task at 1000) because all worktrees were alive at once. Fixed.
4. **Scheduler memory is small**: 35 to 52 MB for the Bun process at 50 to 1000 tasks. Agent processes are not included.
5. **Throughput of useful work collapses under overlap** (above). The pipeline is correct under conflicts, but not efficient.

## Answer to "how many agents can it run"

On this machine, with a small repository and mock agents, the orchestration layer ran **1000 independent tasks to completion with no failures** in 7.7 minutes, and would not be the bottleneck for up to roughly **200 simultaneous real agents** (limits 1 and 2 above). It was never tested with more than 16 concurrent agents, and the default is 5 (`maxParallelWorktrees`).

What actually limits "thousands of agents in parallel" is outside this benchmark and still unmeasured:

- **Memory**: `AGENT_CATALOG` assumes 50 to 200 MB per agent; 200 Claude-class agents is on the order of 40 GB.
- **Model API rate limits and cost**: nothing in FSC currently caps spend (the README mentions token flow control; the code has none). Tracked in #6.
- **Real repositories**: `git worktree add` time grows with checkout size. A 50,000-file repository will make finding 1 much worse.
- **Overlap**: realistic task sets overlap far less than the worst case above, but how much is unknown.

## Not covered

Multi-machine runs (the Redis path), Docker mode, repositories larger than 201 files, anything above 16 concurrent agents, partial overlap (some tasks sharing files).
