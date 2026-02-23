# FSC 多节点集群部署指南

> 基于 OpenClaw + WireGuard 的生产级部署方案

## 概述

本指南介绍如何在多台服务器上部署 FSC 集群，结合 OpenClaw 实现智能任务调度。

### 核心技术栈

| 项目 | 用途 |
|------|------|
| Full Self Coding | 多Agent并行代码修复 |
| OpenClaw | Agent调度与Session管理 |
| WireGuard | 内网VPN互联 |

## 节点规划

| 节点 | 角色 | 说明 |
|------|------|------|
| 节点1 | 调度中心 | 运行 OpenClaw Gateway |
| 节点2 | 执行节点 | Claude Code Agent |
| 节点3 | 执行节点 | Gemini CLI Agent |

## 快速开始

### 1. 环境准备

所有节点执行：

```bash
# 安装 Bun
curl -fsSL https://bun.sh/install | bash
echo 'registry = "https://registry.npmjs.org/"' > ~/.bunfig.toml

# 安装 Docker
dnf install -y podman-docker  # OpenCloudOS/CentOS
# 或
apt-get install -y docker.io   # Ubuntu/Debian

# 安装 WireGuard
dnf install -y wireguard-tools
```

### 2. WireGuard 内网配置

生成密钥：
```bash
wg genkey | tee private.key | wg pubkey > public.key
```

配置 `/etc/wireguard/wg0.conf`：
```ini
[Interface]
PrivateKey = <你的PrivateKey>
Address = <本机IP>/24
ListenPort = 51820

[Peer]
PublicKey = <对端PublicKey>
Endpoint = <对端IP>:51820
AllowedIPs = <对端内网IP>/32
PersistentKeepalive = 25
```

启动：
```bash
wg-quick up wg0
systemctl enable wg-quick@wg0
```

### 3. 安装 FSC

```bash
git clone https://github.com/2233admin/full-self-coding.git
cd full-self-coding
bun install
```

### 4. 配置 SSH 密钥互信

```bash
# 生成专用密钥
ssh-keygen -t rsa -b 4096 -f ~/.ssh/fsc_cluster

# 复制到其他节点
ssh-copy-id -i ~/.ssh/fsc_cluster.pub root@<节点2_IP>
ssh-copy-id -i ~/.ssh/fsc_cluster.pub root@<节点3_IP>
```

### 5. 配置 OpenClaw

```bash
# 在调度节点配置 OpenClaw Gateway
openclaw gateway start
```

## 使用方法

### 任务类型与路由

| 任务类型 | 默认路由节点 |
|----------|--------------|
| code-fix | 节点2 (Claude) |
| analysis | 节点3 (Gemini) |
| bug-fix | 节点2 (Claude) |
| optimize | 节点3 (Gemini) |

### 执行命令

```bash
# 本地执行
python3 fsc_wrapper.py --target /path/to/project --task-type code-fix

# 远程执行
ssh -i ~/.ssh/fsc_cluster root@<节点2_IP> "cd /path/to/fsc && python3 fsc_wrapper.py --task-type code-fix"
```

## 配置说明

### 环境变量

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export GEMINI_API_KEY="AIza..."
```

### 配置文件

创建 `~/.config/full-self-coding/config.json`：

```json
{
  "agentType": "claude-code",
  "anthropicAPIKey": "${ANTHROPIC_API_KEY}",
  "googleGeminiApiKey": "${GEMINI_API_KEY}",
  "maxParallelDockerContainers": 5,
  "maxDockerContainers": 10,
  "dockerMemoryMB": 2048,
  "dockerCpuCores": 2
}
```

## 故障排查

### WireGuard 连接问题

```bash
# 检查状态
wg show wg0

# 测试连通性
ping -c 2 <对端内网IP>
```

### Docker 容器问题

```bash
# 查看容器日志
docker logs <container_id>

# 查看运行中的容器
docker ps -a
```

## 参考资料

- [OpenClaw 官方文档](https://docs.openclaw.ai)
- [WireGuard 文档](https://www.wireguard.com)
- [FSC 原版](https://github.com/NO-CHATBOT-REVOLUTION/full-self-coding)

---

*本项目基于 GPL v2 许可证发布。*
