# CLAUDE.md — full-self-coding (FSC)

## 项目概述
FSC 核心引擎: 把代码任务拆解成原子级子任务，分发给 100~1000 个 Docker Agent 并行执行。
类比 GPU 并行计算 — CUDA Cores 换成 AI Agent 容器。

## 架构
- **分析器**: analyzeCodebase() → Docker 容器 → AI 扫描代码库 → tasks.json
- **调度器**: TaskSolverManager → 并行 N 个容器 → 每任务独立执行
- **提交器**: CodeCommitter → 汇总 git diff → 创建分支 → 合并
- **Agent 适配**: Claude Code / Gemini CLI / Codex / Cursor

## 技术约束
- 运行时: Bun
- Monorepo: packages/core + packages/cli
- Docker 容器 < 200MB (极简化)
- 每任务 < 4000 tokens
- Worker 优先用廉价模型 (MiniMax/Doubao)
- 测试: bun test

## 编码规范
- TypeScript strict mode
- 导出统一从 packages/core/src/index.ts
- Docker 操作通过 Bun spawnSync/spawn
- 配置: FSC_* 环境变量 > 项目配置 > 用户配置 > 默认值

## 关键路径
- `packages/core/src/analyzer.ts` — 代码库分析
- `packages/core/src/taskSolver.ts` — 单任务执行
- `packages/core/src/taskSolverManager.ts` — 并行调度
- `packages/core/src/dockerInstance.ts` — 容器管理
- `packages/core/src/codeCommitter.ts` — Git 提交
- `packages/core/src/SWEAgent/` — Agent 适配器
- `packages/cli/src/index.ts` — CLI 入口
- `cluster_config.example.json` — 集群配置模板
- `auto_deploy.py` — 集群部署脚本

## 扩展计划
- 新增 SWEAgent 适配器: MiniMax, Doubao (廉价模型)
- 集成 claw-mesh 的 Redis Streams 任务分发
- 信任分机制: 根据 Agent 成功率动态分配任务
- 层级汇总: 100 Agent/组 → 组长 → 中央委员会

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **full-self-coding** (786 symbols, 2400 relationships, 60 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/full-self-coding/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/full-self-coding/context` | Codebase overview, check index freshness |
| `gitnexus://repo/full-self-coding/clusters` | All functional areas |
| `gitnexus://repo/full-self-coding/processes` | All execution flows |
| `gitnexus://repo/full-self-coding/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
