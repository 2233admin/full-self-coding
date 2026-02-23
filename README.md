# FSC 多节点集群部署方案

> 基于 Full Self Coding + OpenClaw + WireGuard 的多Agent代码修复集群

无需提示词、无需指令、无需计划，让你拥有 100~1000 个 AI Agent 并行修复代码库中的所有问题。

## 🌟 概述

FSC 多节点集群部署方案是一个生产级的多Agent代码修复系统，整合了以下核心技术：

| 项目 | 用途 | 仓库 |
|------|------|------|
| **Full Self Coding (FSC)** | 多Agent并行代码修复框架 | https://github.com/NO-CHATBOT-REVOLUTION/full-self-coding |
| **OpenClaw** | Agent调度与Session管理 | https://github.com/openclaw/openclaw |
| **WireGuard** | 内网互联 | https://www.wireguard.com/ |

### 核心特性

- 🤖 **多Agent支持**: 集成 Claude Code、Gemini CLI，支持扩展
- 📦 **容器化执行**: 基于 Docker 的安全隔离执行环境
- 🔍 **智能分析**: 自动代码库分析与任务识别
- ⚙️ **灵活配置**: 分层配置系统，支持环境变量
- 📊 **详细报告**: Git Diff 追踪，完整变更记录
- 🔄 **并行处理**: 多容器并行任务执行，资源管理
- 🛡️ **错误处理**: 完善的错误恢复与优雅降级

## 🏗️ 架构

### 核心组件

```
┌─────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                         │
├─────────────────────────────────────────────────────────────┤
│  Session Manager                                            │
│  ├── 主会话: 任务分析 + 调度分发                            │
│  ├── 子会话1: Agent-1 (Docker执行)                        │
│  ├── 子会话2: Agent-2 (Docker执行)                        │
│  └── 子会话N: Agent-N (Docker执行)                        │
│                                                             │
│  Multi-Agent Routing                                       │
│  └── 智能路由: 任务类型 → 合适节点                        │
└─────────────────────────────────────────────────────────────┘
         │                    │                    │
    ┌────┴────┐         ┌────┴────┐         ┌────┴────┐
    │ 中央节点  │         │ 硅谷节点  │         │ 东京节点  │
    │<NODE1_IP> │         │<NODE2_IP> │         │<NODE3_IP> │
    │(调度+分析)│         │(Claude)  │         │(Gemini)  │
    └─────────┘         └─────────┘         └─────────┘
         │                                       │
         └───────────────────┬───────────────────┘
                             │
                    WireGuard 内网
```

### 支持的 Agent 类型

| Agent类型 | 描述 | 容器镜像 | 关键特性 |
|-----------|------|----------|----------|
| **CLAUDE_CODE** | Anthropic Claude Code 集成 | `node:latest` | 高级代码分析、自然语言处理 |
| **GEMINI_CLI** | Google Gemini CLI 集成 | `node:latest` | Google AI模型集成，快速响应 |

## 🚀 快速开始

### 前置要求

- **Bun** (v1.0.0+)
- **Docker** (最新版本)
- **Git** (版本控制)
- **WireGuard** (内网互联)

### 1. 安装 Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. 安装 Docker

```bash
# OpenCloudOS/CentOS
dnf install -y podman-docker

# Ubuntu/Debian
apt-get update && apt-get install -y docker.io
```

### 3. 安装 WireGuard

```bash
dnf install -y wireguard-tools
```

### 4. 克隆并配置项目

```bash
git clone https://github.com/2233admin/fsc-deploy.git
cd fsc-deploy
```

### 5. 配置内网

生成密钥对：
```bash
wg genkey | tee private.key | wg pubkey > public.key
```

创建配置文件 `/etc/wireguard/wg0.conf`：

```ini
[Interface]
PrivateKey = <你的PrivateKey>
Address = <NODE1_IP>/24
ListenPort = 51820

[Peer]
PublicKey = <对端PublicKey>
Endpoint = <对端IP>:51820
AllowedIPs = <NODE_IP>/32
PersistentKeepalive = 25
```

启动：
```bash
wg-quick up wg0
systemctl enable wg-quick@wg0
```

## ⚙️ 配置

### 配置层级

本系统使用分层配置，优先级从高到低：

1. **环境变量** (`FSC_*`)
2. **项目级配置** (`.fsc/config.json`)
3. **用户级配置** (`~/.config/full-self-coding/config.json`)
4. **默认值**

### 配置选项

| 字段 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `agentType` | `string` | `claude-code` | 使用的AI Agent |
| `maxDockerContainers` | `number` | `10` | 最大容器数 |
| `maxParallelDockerContainers` | `number` | `3` | 最大并行数 |
| `dockerTimeoutSeconds` | `number` | `600` | Docker超时(秒) |
| `dockerMemoryMB` | `number` | `1024` | 容器内存限制(MB) |
| `dockerCpuCores` | `number` | `2` | 容器CPU核心数 |
| `maxTasks` | `number` | `100` | 最大任务数 |
| `codingStyleLevel` | `number` | `5` | 代码风格级别(0-10) |

### 任务路由配置

```json
{
  "routing": {
    "code-fix": "<NODE2_IP>",
    "bug-fix": "<NODE2_IP>",
    "analysis": "<NODE3_IP>",
    "refactor": "<NODE2_IP>",
    "optimize": "<NODE3_IP>",
    "review": "<NODE1_IP>"
  }
}
```

## 📖 使用方法

### 本地执行 (中央节点)

```bash
python3 fsc_wrapper.py \
  --target /path/to/project \
  --task-type code-fix \
  --parallel 5
```

### 远程执行 (跨节点)

```bash
# 硅谷节点执行
ssh root@<NODE2_IP> "cd /path/to/fsc && python3 fsc_wrapper.py --task-type code-fix"

# 东京节点执行
ssh root@<NODE3_IP> "cd /path/to/fsc && python3 fsc_wrapper.py --task-type analysis"
```

### 可用参数

| 参数 | 简写 | 说明 |
|------|------|------|
| `--target` | `-t` | 目标代码路径 |
| `--agent` | `-a` | Agent类型 (claude-code/gemini-cli) |
| `--parallel` | `-p` | 并行数 |
| `--task-type` | `-k` | 任务类型 |
| `--check` | - | 检查依赖 |
| `--status` | - | 查看状态 |
| `--cleanup` | - | 清理Session |

## 📁 目录结构

```
fsc-deploy/
├── README.md           # 本文档
├── LICENSE            # GPL v2 许可证
├── .gitignore        # Git忽略配置
├── fsc_wrapper.py    # 核心执行脚本
└── install.sh        # 一键安装脚本
```

## ⚠️ 注意事项

1. **安全**: 妥善保管 PrivateKey，不要提交到 Git
2. **成本**: 监控 API 调用，避免超额
3. **资源**: 限制并发数，防止服务器过载
4. **备份**: 每次执行前自动 commit

## 📚 参考资料

- [Full Self Coding 官方文档](https://github.com/NO-CHATBOT-REVOLUTION/full-self-coding)
- [OpenClaw 文档](https://docs.openclaw.ai)
- [WireGuard 快速入门](https://www.wireguard.com/quickstart/)
- [Bun 官方文档](https://bun.sh)
- [Docker 官方文档](https://docs.docker.com)

## 📄 许可证

本项目基于 **GPL v2** (Blender协议) 发布。

---

*本方案整合了 Full Self Coding、OpenClaw 和 WireGuard 等开源项目。*
