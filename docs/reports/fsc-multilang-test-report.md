# PageIndex Cross-Language Indexing Test Report: FSC

**Date**: 2026-03-30
**Project**: full-self-coding (FSC) @ `D:/projects/full-self-coding/`
**Tool**: PageIndex `code_indexer.py` (tree-sitter based)

---

## 1. Project Statistics

| Metric | Value |
|--------|-------|
| Total files indexed | 99 |
| Total symbols extracted | 401 |
| Index time | 0.12s |
| Call graph edges | 35 |

### Language Distribution

| Language | Files | Percentage |
|----------|-------|------------|
| TypeScript | 98 | 98.99% |
| Python | 1 | 1.01% |

**Key finding**: FSC is effectively a **single-language (TypeScript) project**. The sole Python file is `auto_deploy.py` (deployment script, not core logic). There are no `.tsx`, `.js`, or `.jsx` files.

### Key Modules (by symbol density)

- `packages/core/src/configReader.ts` — config management
- `packages/core/src/execution/` — scheduler, pool, concurrency, sequencer, worktree
- `packages/core/src/agent-daemon/` — agent, daemon, pool, sandbox
- `packages/core/src/SWEAgent/` — Claude/Codex/Cursor/Gemini command wrappers

---

## 2. Search Query Results

### Query 1: "agent" / "executor" (definition search)

| # | Lang | Type | Symbol | File | Line |
|---|------|------|--------|------|------|
| 1 | TS | function | ask.preferredAgent | modelRouter.ts | 184 |
| 2 | TS | function | paceExecutor | taskExecutor.ts | 199 |
| 3 | TS | function | poPath, agentComm | taskSolverManager.ts | 189 |
| 4 | TS | function | (agent init) | agent-daemon/agent.ts | 86 |
| 5 | TS | const | N_AGENTS | agent-daemon/daemon.ts | 46 |
| 6 | TS | function | sh(agent) | agent-daemon/pool.ts | 132 |
| 7 | TS | function | (agent config) | agent-daemon/pool.ts | 156 |
| 8 | TS | function | getAgentConfig | execution/mapping.ts | 71 |
| 9 | TS | function | executeWithMockAgent | execution/scheduler.test.ts | 21 |

**Total**: 9 results, **all TypeScript**
**Python results**: 0 (auto_deploy.py has no agent/executor symbols)

### Query 2: "tool" (callers search)

**Total**: 0 results

No symbols with "tool" in the name were found. FSC uses `commands` terminology (e.g., `claudeCodeCommands`, `codexCommands`) rather than "tool". The indexer correctly found nothing rather than returning false positives.

### Query 3: Coordination keywords (scheduler/pool/daemon/sequencer)

| # | Lang | Type | Symbol | File |
|---|------|------|--------|------|
| 1 | TS | class | ConcurrencyPool | execution/concurrency.ts |
| 2 | TS | class | WorktreePool | execution/pool.ts |
| 3 | TS | class | UnifiedScheduler | execution/scheduler.ts |
| 4 | TS | class | Sequencer | execution/sequencer.ts |
| 5 | TS | class | TestScheduler | execution/scheduler.test.ts |
| 6 | TS | class | MockScheduler | execution/scheduler.test.ts |

**Total**: 6 results, **all TypeScript**

---

## 3. Call Graph Analysis

The call graph captured 35 caller-callee edges. Sample:

```
runFullAnalysis -> [analyzeCodebase, createConfig, getGitRemoteUrls]
analyzeCodebase -> [CursorInstallationWrapper, analyzerPrompt, copyFileToContainer]
startContainer -> [streamToTextSync]
configReader.constructor -> [configExists, ensureConfigDirectory, getDefaultConfigDir]
```

Call graph works well for **intra-language** (TS-to-TS) calls. Cross-language edges are impossible in this project since the Python file has no interface with TS code.

---

## 4. Cross-Language Assessment

### Can PageIndex handle mixed Python + TypeScript?

**Yes** — both parsers loaded correctly, both languages indexed. The Python file's 10 symbols were extracted alongside 391 TypeScript symbols.

### Actual cross-language coverage in FSC?

**Not testable** — FSC is 99% TypeScript. The single Python file (`auto_deploy.py`) is an ops script with no import/call relationship to the TypeScript codebase. There are **zero cross-language call edges** because none exist in the source.

### Symbol extraction quality

| Aspect | Rating | Notes |
|--------|--------|-------|
| TS classes | Good | All major classes found (Sequencer, UnifiedScheduler, etc.) |
| TS functions | Good | Arrow functions, exported functions, methods detected |
| TS constants | Good | UPPER_CASE and PascalCase consts captured |
| Python symbols | Partial | Some symbol names appear truncated (string fragments rather than clean names) |
| Call graph | Good | 35 edges, correct caller-callee relationships |
| Import resolution | N/A | Not tested for cross-language imports (none exist) |

### Python symbol extraction issue

The Python parser extracted 10 symbols from `auto_deploy.py` but some names are garbled (e.g., `'"<NOD'`, `'  self.nodes = '`). This suggests the Python symbol extractor may be capturing expression text rather than identifier names for some AST node types. **This is a bug worth investigating** in `_extract_python_symbols()`.

---

## 5. Comparison with Single-Language Tests

| Metric | PageIndex (Python-only) | GitNexus (TS) | FSC (mixed) |
|--------|------------------------|---------------|-------------|
| Files | ~10 | ~50 repos | 99 |
| Symbols | ~80 | N/A (graph-based) | 401 |
| Index time | <0.1s | N/A | 0.12s |
| Call graph | Yes | Yes (Cypher) | Yes (35 edges) |
| Cross-lang | N/A | N/A | Technically works, not exercisable |

---

## 6. Recommendations

1. **Find a truly mixed-language project** for cross-language testing. FSC is the wrong target — it's 99% TypeScript. Candidates:
   - `claw-router` (Python FastAPI) + `claw-mesh` (TypeScript) as a pair
   - A monorepo with both Python backend and TypeScript frontend sharing types/APIs

2. **Fix Python symbol name extraction** — the garbled names from `auto_deploy.py` indicate a parser bug in `_extract_python_symbols()` for certain AST patterns (likely assignments or string expressions being captured as symbol names)

3. **Cross-language call graph** is architecturally impossible with tree-sitter alone (it parses single files). To detect Python-TS boundaries, the indexer would need:
   - HTTP API endpoint matching (FastAPI route <-> fetch call)
   - Shared type/schema files (e.g., JSON Schema, protobuf)
   - Import map for polyglot build tools

4. **Increase call graph density** — 35 edges for 401 symbols (8.7% coverage) suggests many call relationships are missed, likely due to method calls on objects (`obj.method()`) not being resolved to their class definitions

---

## 7. Verdict

| Criterion | Status | Notes |
|-----------|--------|-------|
| Project successfully indexed | PASS | 99 files, 401 symbols, 0.12s |
| 3 queries returned results | PARTIAL | Q1: 9 results, Q2: 0 (no "tool" symbols exist), Q3: 6 results |
| Python + TypeScript symbols identified | PASS | Both languages parsed, symbols extracted |
| Cross-language call graph | N/A | No cross-language calls exist in FSC |

**Bottom line**: PageIndex code_indexer handles multi-language projects mechanically (both parsers work), but FSC is not a valid test case for cross-language search quality because it's a monolingual TypeScript project with one orphan Python script.
