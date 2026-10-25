# Module Structure

Source of truth for what lives in `packages/core/src` and which way imports may point.
`packages/core/test/architecture.test.ts` enforces this file: add a directory or change a
rule there and here in the same commit.

## Packages

- `packages/core` (`@full-self-coding/core`) — all logic, pure TypeScript, Bun runtime, entry `src/index.ts`.
- `packages/cli` — Commander CLI, depends on core only through its public exports.

## Subsystems in `packages/core/src`

| Path | Role | Status |
|------|------|--------|
| top-level `*.ts` (`analyzer`, `taskSolver`, `taskSolverManager`, `codeCommitter`, `dockerInstance`, `taskExecutor`, `config*`, `modelRouter`, `distributedScheduler`, `codeRAG`) | Original v1 pipeline: analyze → solve in Docker/bare → commit | live, exported from `index.ts` |
| `SWEAgent/` | Per-agent CLI command builders (Claude Code, Gemini, Codex, Cursor) | live |
| `prompts/`, `utils/` | Prompt templates, git/JSON helpers | live, leaf layer |
| `execution/` | v3 worktree pipeline: `UnifiedScheduler` → `WorktreePool` → `LocalExecution` → `CommitSequencer` (4-tier merge) | live, exported from `index.ts` |
| `salacia/` | Scope contracts, drift scoring, co-change coupling, A/B experiment | live, used by `execution/` and `codeCommitter` |
| `harness/` | Initializer/Evaluator agent loop, pass^k eval, DIY advisor | live, exported from `index.ts` |
| `codeRAGv2/` | tree-sitter RAG (store/parser/retriever) | **not wired**: no importer, not exported |
| `agent-daemon/` | Long-running pooled agent daemon with its own Redis scheduler | **standalone**: runs as its own process, not imported by core |

Three scheduling stacks coexist: `taskSolverManager` (v1 Docker), `execution/scheduler` (v3 worktree),
`agent-daemon/scheduler` + `distributedScheduler` (Redis). New work goes on `execution/`; the others
are maintenance only until one is retired.

## Import rules (enforced)

1. `agent-daemon/` and `codeRAGv2/` import nothing from the rest of `src` except `utils/`; `harness/` may also import `config`.
2. `execution/` never imports `agent-daemon/`, `dockerInstance`, `taskSolver*`, `analyzer`.
3. `utils/` imports nothing from other `src` modules; `prompts/` may only read `config`, `task`, `codingStyle`.

## Known debt (do not extend)

- `execution/` → `salacia/plugin` → `codeCommitter` → `execution/` is an import cycle. Break it by moving
  the commit-side hooks (`QualityGateHook`, `TrustUpdateHook`) into a leaf `types` module.
- `codeRAG.ts` and `codeRAGv2/` overlap; `codeRAGv2` has no consumer.
