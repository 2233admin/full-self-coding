# OpenClaw + WireGuard mesh (optional)

FSC does not require OpenClaw or WireGuard. This page keeps the multi-node reference setup that was originally in the README. 
Replace the example `10.10.0.x` addresses and Redis credentials with your own; never commit them.

### OpenClaw集成版 vs 原版

| 特性 | 原版 FSC | OpenClaw集成版 |
|------|----------|----------------|
| 部署方式 | 单机 | 多节点集群 |
| 任务调度 | Docker本地 | OpenClaw Gateway |
| Session管理 | 无 | 任务隔离Session |
| 多节点路由 | 手动 | 自动Routing |
| 内网互联 | 无 | WireGuard VPN |
| 规模 | 单机并行 | 跨服务器并行 |

### 本分支新增特性

- ✅ **多节点集群部署**: 支持跨服务器部署
- ✅ **OpenClaw Gateway**: 统一任务调度中心
- ✅ **Session隔离**: 任务间上下文隔离
- ✅ **智能路由**: 根据任务类型自动选择节点
- ✅ **WireGuard内网**: 主要跨服务器通信方式 (10.10.0.x)
- ✅ **SSH隧道**: 备用通道
- ✅ **自动部署脚本**: 一键部署整个集群

### 自定义调度器 (类似渲染集群)

本分支还实现了类似渲染集群的自定义调度器：

| 功能 | 说明 |
|------|------|
| **错误分类器** | 自动分类任务错误类型，智能重试 |
| **Token流控** | 控制API调用，避免超额 |
| **时长预估** | 估算任务执行时间，优化资源分配 |
| **DAG依赖** | 支持任务依赖关系，拓扑排序调度 |
| **多节点协同** | 跨服务器任务分发与结果汇总 |

```
调度器核心流程:
提交任务 → 解析依赖 → 入队 → 调度器匹配空闲节点 → 下发 → 监控 → 成功/失败重投
```


### Core Components

```
┌─────────────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │  Session Mgr   │  │  Task Scheduler │  │  Error Handler │  │
│  │                 │  │                 │  │                 │  │
│  │ • Session隔离  │  │ • DAG依赖排序   │  │ • 错误分类     │  │
│  │ • 上下文管理    │  │ • 节点选择      │  │ • 智能重试     │  │
│  │ • Token流控    │  │ • 负载均衡      │  │ • 熔断降级     │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌─────────────────┴─────────────────┐
                    │                                 │
           ┌────────┴────────┐              ┌────────┴────────┐
           │    Node 1       │              │    Node 2       │
           │  (Coordinator)  │              │   (Executor)    │
           │                  │              │                  │
           │ ┌─────────────┐ │              │ ┌─────────────┐ │
           │ │ DockerHost  │ │              │ │ DockerHost  │ │
           │ │             │ │              │ │             │ │
           │ │ • Container │ │              │ │ • Container │ │
           │ │ • Analyzer  │ │              │ │ • TaskSolver│ │
           │ │ • TaskMgr   │ │              │ │ • CodeFix   │ │
           │ └─────────────┘ │              │ └─────────────┘ │
           └─────────────────┘              └─────────────────┘
```

### 系统数据流

```
用户请求 → Gateway → Session创建 → DAG解析 → 调度器选节点 → WireGuard下发 → Docker执行 → 结果汇总 → Session关闭
                              ↓
                       错误分类 → 重试/熔断

通信方式 (实际部署):
- 主要: WireGuard 内网 (10.10.0.x)
- 备用: SSH 隧道 (公网)
```

