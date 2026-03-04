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
