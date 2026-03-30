# FSC Harness

Anthropic best-practice agent loop, split into three discrete roles.
Runs entirely on the host — no Docker required for the harness itself.

## Agent Roles

| Agent | File | Responsibility |
|-------|------|----------------|
| **Initializer** | `initializer.ts` | Reads project files (AGENTS.md / README.md / package.json / Cargo.toml), calls Claude Haiku to produce a prioritized feature list, persists it as `progress.txt` |
| **Coding Agent** | (external — Claude Code / Gemini CLI / Codex) | Picks the next pending feature, implements it in an isolated environment, commits changes |
| **Evaluator** | `evaluator.ts` | Acts as a hostile reviewer: scores the commit diff + test output (0–100), marks feature done/failed, surfaces concrete issues |

## Basic Usage

```typescript
import path from "path";
import {
  analyzeProject,
  saveProgress,
  nextPendingFeature,
  markInProgress,
  markFeatureDone,
  evaluate,
} from "@full-self-coding/core/harness";

const API_KEY = process.env.ANTHROPIC_API_KEY!;
const REPO    = "/path/to/your/repo";
const PROG    = path.join("./", "progress.txt");

// 1. Initialize (once per project)
const initResult = await analyzeProject(REPO, API_KEY);
if (!initResult.ok) throw new Error(initResult.error);
await saveProgress(initResult.value, PROG);

// 2. Agent loop
let progress = initResult.value;
let feature  = nextPendingFeature(progress);

while (feature) {
  await markInProgress(progress, feature.id, PROG);

  // ... run your coding agent here, capture diff + test output ...
  const diff       = ""; // git diff HEAD~1..HEAD
  const testOutput = ""; // bun test stdout

  const evalResult = await evaluate(feature, diff, testOutput, API_KEY);
  if (!evalResult.ok) throw new Error(evalResult.error);

  await markFeatureDone(progress, feature.id, evalResult.value.passed, PROG);
  feature = nextPendingFeature(progress);
}
```

## Parallel Mode

Set `maxParallelAgents > 1` in your Config to signal that multiple agents share the
same `progressDir`. You are responsible for file-lock coordination (e.g. `proper-lockfile`
or a simple `.lock` sentinel file) before calling `markInProgress` / `markFeatureDone`.

```typescript
import { createConfig } from "@full-self-coding/core";

const cfg = createConfig({
  maxParallelAgents: 4,
  progressDir: "/shared/run-001/",
});

// Pass cfg to analyzeProject so the caller knows where to save progress.txt:
const result = await analyzeProject(REPO, API_KEY, undefined, cfg);
await saveProgress(result.value, path.join(cfg.progressDir!, "progress.txt"));
```

## Programmatic Tool Calling

Enable `enableProgrammaticToolCalling: true` to allow the coding agent to emit
tool-call batches inside a single turn (Anthropic Advanced Tool Use pattern).
Pair with `deferToolLoading: true` when your tool set exceeds ~20 tools — schemas
are withheld from the system prompt and injected only when the agent requests them,
saving ~85% of tool-definition tokens per turn.

```typescript
const cfg = createConfig({
  enableProgrammaticToolCalling: true,
  deferToolLoading: true,
});
```

## Reusing This Module

The harness has no FSC-specific dependencies beyond `../utils/trimJSON`.
To use it standalone:

1. Copy `packages/core/src/harness/` and `packages/core/src/utils/trimJSON.ts` into your project.
2. Remove the `import("../config").Config` reference in `initializer.ts` and inline the
   `{ progressDir?: string; maxParallelAgents?: number }` type directly.
3. Call `analyzeProject` + `evaluate` with your own Anthropic API key.

No other runtime dependencies are required.
