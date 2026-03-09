# FSC 核心调度器 ↔ Agent Daemon 对接报告

**日期**: 2026-03-07
**状态**: 代码对接完成，端到端 bash 模式验证通过

---

## 1. 对接目标

将 FSC 核心引擎的任务拆解流水线 (analyzer → taskSolverManager) 与 Agent Daemon v2.1 的分布式执行层打通，实现：

```
用户 codebase → FSC 分析 → Task[] → Redis Streams → 多节点并行执行 → 结果聚合 → Git 提交
```

## 2. 数据流

```
FSC CLI (--distributed)
  │
  ├─ analyzeCodebase(config, gitUrl) → Task[]
  │     (title, description, ID, priority, riskLevel, dependsOn...)
  │
  ├─ DistributedScheduler({gitUrl, agentType: "claude"})
  │   └─ submitTask(task)
  │       → XADD fsc:tasks {
  │           task: JSON({id, title, description, gitUrl, agentType, timeoutSeconds}),
  │           task_id, priority, risk_level, submitted_at
  │         }
  │
  ├─ Scheduler v1.1 (中央 10.10.0.1)
  │   └─ 读 fsc:tasks → 按 effective idle 分发 → XADD fsc:tasks:{node_id}
  │
  ├─ Daemon v2.1 (子节点)
  │   └─ 读 fsc:tasks:{node_id} → parseTask()
  │       → Agent.execute(task)
  │           ├─ prepareRepo()   — git clone gitUrl (宿主机执行)
  │           ├─ buildPrompt()   — 生成 task_prompt.md
  │           ├─ executeTask()   — 检测 agentType
  │           │   ├─ "bash"   → bash -c 'description'
  │           │   ├─ "claude" → claude -p task_prompt.md --allowedTools ...
  │           │   ├─ "gemini" → gemini -p task_prompt.md
  │           │   └─ "codex"  → codex -p task_prompt.md
  │           └─ getDiff()       — git diff HEAD
  │
  ├─ XADD fsc:results {task_id, status, output, git_diff, node_id, duration_ms}
  │
  └─ DistributedScheduler.waitForResults()
      → TaskResult[] → CodeCommitter.commitAllChanges()
```

## 3. 修改的文件

| 文件 | 变更 |
|------|------|
| `distributedScheduler.ts` | 加入 gitUrl/branch/agentType 参数；submitTask 改用 JSON task 格式；connect 不再创建 consumer group；waitForResults 适配 daemon 返回字段 |
| `packages/cli/src/index.ts` | 传入 gitUrl + agentType 映射 (claude-code→claude) |
| `daemon.ts` (已部署) | 读节点专属队列 fsc:tasks:{NODE_ID} |
| `scheduler.ts` (已部署) | v1.1 pending 追踪 + capacity-aware 分发 |

## 4. 类型映射

### FSC Config agentType → daemon agentType

| FSC SWEAgentType | daemon agentType | 沙箱内命令 |
|------------------|-----------------|-----------|
| `claude-code` | `claude` | `claude -p prompt.md --allowedTools Bash,Read,Edit... --permission-mode bypassPermissions` |
| `gemini-cli` | `gemini` | `gemini -p prompt.md` |
| `codex` | `codex` | `codex -p prompt.md` |
| `cursor` | `bash` | fallback to bash |

### FSC Task → daemon TaskPayload

| FSC Task 字段 | daemon TaskPayload 字段 | 传递方式 |
|--------------|----------------------|---------|
| ID | id | JSON task 字段 |
| title | title | JSON task 字段 |
| description | description | JSON task 字段 |
| (from scheduler) | gitUrl | DistributedScheduler 构造时传入 |
| (from scheduler) | agentType | DistributedScheduler 构造时传入 |
| maxExecutionTimeMs | timeoutSeconds | 转换: ms → s |

### daemon TaskResult → FSC TaskResult

| daemon 字段 | FSC TaskResult 字段 |
|------------|-------------------|
| task_id | ID |
| status | status (success→SUCCESS, else→FAILURE) |
| output | report |
| git_diff | gitDiff |
| timestamp | completedAt |

## 5. 验证结果

### 端到端 bash 模式 ✅

```
XADD fsc:tasks task={"id":"e2e-test-1","agentType":"bash","description":"echo hello"}
  → Scheduler → tokyo (eff=2, pending=1)
  → Daemon received → Agent executed (24ms)
  → fsc:results: status=success, node=tokyo
```

### Git clone ❌ (部署问题，非代码问题)

东京/硅谷到 GitHub HTTPS 不通 (中国网络)，需要:
- 配置 SSH key + `git@github.com:` URL
- 或使用 Gitea 内网 (需配 HTTP 凭证)
- 或配置代理

## 6. 使用方法

```bash
# 本地模式 (原有)
cd your-project && bun run full-self-coding run

# 分布式模式 (新增)
cd your-project && bun run full-self-coding run --distributed
# 或
FSC_DISTRIBUTED=1 bun run full-self-coding run
```

## 7. 剩余工作

| 优先级 | 任务 | 说明 |
|--------|------|------|
| P0 | Git 凭证配置 | 子节点需要 GitHub SSH key 或代理 |
| P0 | 安装 Claude Code CLI | 子节点需要 `claude` 命令才能跑 AI agent |
| P1 | API Key 分发 | daemon baseEnv 需要 ANTHROPIC_API_KEY 或 MiniClaw URL |
| P1 | 结果聚合优化 | waitForResults 目前轮询所有结果，大量历史结果时效率低 |
| P2 | 依赖任务支持 | DistributedScheduler 暂不处理 dependsOn，需 scheduler 层支持 |

---

*FSC 核心引擎 + Agent Daemon v2.1 分布式对接完成*
*代码: D:/projects/full-self-coding/packages/core/src/*
