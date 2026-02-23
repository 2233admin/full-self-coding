# Full Self Coding (FSC)

> 🔗 **OpenClaw集成版** - 本分支基于原版FSC，集成OpenClaw实现生产级多节点集群部署

**原版**: https://github.com/NO-CHATBOT-REVOLUTION/full-self-coding

No prompts, no instructions, no plans, you have 100~1000 AI agent coding in parallel now, solving all possible problems and issues in your codebase.

## 🌟 Overview

Full Self Coding (FSC) is a sophisticated framework designed to automate software engineering tasks by integrating multiple AI agents (Claude Code, Gemini CLI) within Docker containers. It provides intelligent codebase analysis, task decomposition, automated code modification, and comprehensive reporting capabilities.

### Key Features

- **🤖 Multi-Agent Support**: Integration with Claude Code, Gemini CLI, and extensible agent architecture
- **📦 Containerized Execution**: Secure, isolated Docker-based task execution
- **🔍 Intelligent Analysis**: Automated codebase analysis and task identification
- **⚙️ Flexible Configuration**: Hierarchical configuration system with environment variable support
- **📊 Comprehensive Reporting**: Detailed execution reports with git diff tracking
- **🔄 Parallel Processing**: Multi-container parallel task execution with resource management
- **🛡️ Robust Error Handling**: Comprehensive error recovery and graceful degradation

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
- ✅ **WireGuard内网**: 节点间安全通信
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

## 🏗️ Architecture

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

通信方式:
- 节点间: WireGuard 内网 (10.10.0.x)
- 备用: SSH 隧道
```

### Supported Agent Types

| Agent Type | Description | Container Image | Key Features |
|------------|-------------|----------------|--------------|
| **CLAUDE_CODE** | Anthropic Claude Code integration | `node:latest` | Advanced code analysis, natural language processing |
| **GEMINI_CLI** | Google Gemini CLI integration | `node:latest` | Google's AI model integration, fast response |
| **CODEX** | OpenAI Codex integration (planned) | - | OpenAI GPT-based code completion |

## 🚀 Getting Started

### Prerequisites

- **Bun** (v1.0.0 or higher)
- **Docker** (latest version)
- **Git** (for repository operations)


### Quick Start

1. **Install bun.js on your machine**
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

2. **Clone and setup the project**
   ```bash
   git clone https://github.com/NO-CHATBOT-REVOLUTION/full-self-coding.git
   cd full-self-coding
   bun install
   ```

3. **Run on a repository**
   ```bash
   # Run CLI from source
   bun run start

   # Or run on a specific repository
   full-self-coding
   ```

### Installation as npm Package

The project is structured as a monorepo with two main packages:

- **@full-self-coding/core**: Core library for code analysis and task execution
- **@full-self-coding/cli**: Command-line interface

#### Core Package

```bash
npm install @full-self-coding/core
```

#### CLI Package

```bash
npm install -g @full-self-coding/cli
# Then run:
full-self-coding-cli
```

## ⚙️ Configuration

### Configuration Hierarchy

Full Self Coding uses a hierarchical configuration system with the following precedence (highest to lowest):

1. **Environment Variables** (`FSC_*`)
2. **Project-level Configuration** (`.fsc/config.json`)
3. **User Configuration** (`~/.config/full-self-coding/config.json`)
4. **Default Values**

### Configuration Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agentType` | `SWEAgentType` | `CLAUDE_CODE` | AI agent to use (`claude-code`, `gemini-cli`) |
| `maxDockerContainers` | `number` | `10` | Maximum Docker containers allowed |
| `maxParallelDockerContainers` | `number` | `3` | Maximum parallel container execution |
| `dockerTimeoutSeconds` | `number` | `600` | Docker command timeout in seconds |
| `dockerMemoryMB` | `number` | `1024` | Docker container memory limit in MB |
| `dockerCpuCores` | `number` | `2` | Docker container CPU core limit |
| `dockerImageRef` | `string` | `"node:latest"` | Docker image reference for containers |
| `maxTasks` | `number` | `100` | Maximum tasks to generate during analysis |
| `minTasks` | `number` | `1` | Minimum tasks to generate during analysis |
| `workStyle` | `WorkStyle` | `DEFAULT` | Work style (`default`, `bold_genius`, `careful`, etc.) |
| `customizedWorkStyle` | `string` | - | Custom work style description |
| `codingStyleLevel` | `number` | `5` | Coding style level (0-10) |
| `customizedCodingStyle` | `string` | - | Custom coding style description |
| `anthropicAPIKey` | `string` | - | Anthropic API key |
| `anthropicAPIBaseUrl` | `string` | - | Custom Anthropic API base URL |
| `anthropicAPIKeyExportNeeded` | `boolean` | `true` | Whether to export Anthropic API key |
| `googleGeminiApiKey` | `string` | - | Google Gemini API key |
| `googleGeminiAPIKeyExportNeeded` | `boolean` | `true` | Whether to export Gemini API key |
| `openAICodexApiKey` | `string` | - | OpenAI Codex API key |
| `openAICodexAPIKeyExportNeeded` | `boolean` | `true` | Whether to export OpenAI API key |

### Configuration Files

#### Global Configuration (`~/.config/full-self-coding/config.json`)

```json
{
  "agentType": "claude-code",
  "anthropicAPIKey": "sk-ant-api03-...",
  "maxDockerContainers": 8,
  "maxParallelDockerContainers": 4,
  "dockerTimeoutSeconds": 600,
  "dockerMemoryMB": 2048,
  "workStyle": "bold_genius",
  "customizedWorkStyle": "Focus on rapid prototyping and innovation"
}
```

#### Project Configuration (`.fsc/config.json`)

```json
{
  "agentType": "gemini-cli",
  "googleGeminiApiKey": "AIzaSy...",
  "maxTasks": 50,
  "minTasks": 5,
  "codingStyleLevel": 8,
  "customizedCodingStyle": "Follow enterprise coding standards with comprehensive documentation"
}
```

#### Environment Variables

```bash
# API Keys
export FSC_ANTHROPIC_API_KEY="sk-ant-api03-..."
export FSC_GOOGLE_GEMINI_API_KEY="AIzaSy..."
export FSC_OPENAI_CODEX_API_KEY="sk-..."

# Docker Settings
export FSC_MAX_DOCKER_CONTAINERS=15
export FSC_DOCKER_TIMEOUT_SECONDS=900
export FSC_DOCKER_MEMORY_MB=4096

# Agent Configuration
export FSC_AGENT_TYPE="claude-code"
export FSC_WORK_STYLE="bold_genius"
export FSC_CODING_STYLE_LEVEL=9
```

## 📖 Usage Guide

### Command Line Interface

The CLI provides various options for configuration and execution:

```bash
full-self-coding-cli run [options]
```

#### Options

| Option | Short | Type | Description |
|--------|-------|------|-------------|
| `--agent-type` | `-a` | `string` | AI agent type (`claude-code`, `gemini-cli`) |
| `--config` | `-c` | `string` | Path to configuration file |
| `--help` | `-h` | - | Show help information |
| `--version` | `-V` | - | Show version information |

### Examples

#### Basic Repository Analysis

```bash
# Analyze current repository with default settings
full-self-coding-cli run

# Analyze with custom config
full-self-coding-cli run --config ./my-config.json
```

#### Core Library Usage

```typescript
import { analyzeCodebase, TaskSolverManager, createConfig } from '@full-self-coding/core';

// Create configuration
const config = createConfig({
  agentType: 'claude-code',
  anthropicAPIKey: 'your-api-key'
});

// Analyze repository
const tasks = await analyzeCodebase(config, 'https://github.com/user/repo.git');

// Execute tasks
const taskSolver = new TaskSolverManager(config, 'https://github.com/user/repo.git');
for (const task of tasks) {
  taskSolver.addTask(task);
}
await taskSolver.start();
```

## 🔧 API Reference

### Core Classes

#### ConfigReader

Manages configuration loading, validation, and merging.

```typescript
import { ConfigReader, readConfigWithEnv } from '@full-self-coding/core';

// Read configuration with environment variable support
const config = readConfigWithEnv();

// Create custom configuration
import { createConfig } from '@full-self-coding/core';
const customConfig = createConfig({
  agentType: 'claude-code',
  anthropicAPIKey: 'your-api-key'
});
```

**Methods**

- `readConfigWithEnv(): Config` - Read config with environment variables
- `createConfig(userConfig: Partial<Config>): Config` - Create configuration from user config
- `getGitRemoteUrls(useSSH?: boolean): Promise<{fetchUrl: string, pushUrl: string}>` - Get git remote URLs

#### DockerInstance

Manages Docker container lifecycle and operations.

```typescript
import { DockerInstance, DockerRunStatus } from '@full-self-coding/core';

const docker = new DockerInstance();

// Start container
const containerName = await docker.startContainer('node:latest', 'my-task');

// Run commands
const result = await docker.runCommands(['npm', 'install']);

// Copy files
await docker.copyFileToContainer('local.txt', '/app/remote.txt');
await docker.copyFilesToContainer('./src', '/app/src');

// Copy files from container
const content = await docker.copyFileFromContainer('/app/output.txt');

// Shutdown
await docker.shutdownContainer();
```

**Methods**

- `startContainer(imageRef: string, taskName?: string): Promise<string>` - Start new container
- `runCommands(commands: string[], timeout?: number): Promise<DockerRunResult>` - Execute commands
- `copyFileToContainer(localPath: string, containerPath: string): Promise<void>` - Copy single file
- `copyFilesToContainer(localPath: string, containerPath: string): Promise<void>` - Copy recursively
- `copyFileFromContainer(containerPath: string): Promise<string>` - Copy file from container
- `shutdownContainer(): Promise<void>` - Stop and remove container

#### TaskSolver

Executes individual tasks within Docker containers.

```typescript
import { TaskSolver, SWEAgentType } from '@full-self-coding/core';

const taskSolver = new TaskSolver(
  config,
  task,
  SWEAgentType.CLAUDE_CODE,
  'https://github.com/user/repo.git'
);

// Solve the task
await taskSolver.solve();

// Get results
const result = taskSolver.getResult();
```

**Methods**

- `solve(shutdown?: boolean): Promise<void>` - Execute the task
- `getResult(): TaskResult` - Get task execution result

#### Analyzer

Analyzes codebases and generates task lists.

```typescript
import { analyzeCodebase } from '@full-self-coding/core';

// Analyze a repository
const tasks = await analyzeCodebase(
  config,
  'https://github.com/user/repo.git'
);
```

### Configuration Types

```typescript
interface Config {
  agentType: SWEAgentType;
  maxDockerContainers: number;
  maxParallelDockerContainers: number;
  dockerTimeoutSeconds: number;
  dockerMemoryMB: number;
  dockerCpuCores: number;
  dockerImageRef: string;
  maxTasks: number;
  minTasks: number;
  workStyle: WorkStyle;
  customizedWorkStyle?: string;
  codingStyleLevel: number;
  customizedCodingStyle?: string;
  anthropicAPIKey?: string;
  anthropicAPIBaseUrl?: string;
  anthropicAPIKeyExportNeeded: boolean;
  googleGeminiApiKey?: string;
  googleGeminiAPIKeyExportNeeded: boolean;
  openAICodexApiKey?: string;
  openAICodexAPIKeyExportNeeded: boolean;
}

enum SWEAgentType {
  CLAUDE_CODE = 'claude-code',
  GEMINI_CLI = 'gemini-cli',
  CODEX = 'codex'
}

enum WorkStyle {
  DEFAULT = 'default',
  BOLDGENIUS = 'bold_genius',
  CAREFUL = 'careful',
  AGILE = 'agile',
  RESEARCH = 'research'
}
```

## 🧪 Testing

### Running Tests

```bash
# Run all tests from project root
bun run test

# Or run from core package
cd packages/core
bun test

# Run with timeout
bun test --timeout 30000
```

### Test Structure

```
packages/core/test/
├── dockerInstance.test.ts           # Docker functionality tests
├── configReaderSupplementary.test.ts # Configuration system tests
├── taskSolverClaudeCode.test.ts     # Claude Code task solver tests
├── taskSolverGemini.test.ts         # Gemini task solver tests
└── integration/                     # Integration tests
    ├── full-workflow.test.ts        # End-to-end workflow tests
    └── multi-agent.test.ts          # Multi-agent integration tests
```

### Writing Tests

```typescript
import { expect, test, describe, beforeAll, afterAll } from 'bun:test';
import { DockerInstance } from '@full-self-coding/core';

describe('DockerInstance', () => {
  let docker: DockerInstance;
  let containerName: string;

  beforeAll(async () => {
    docker = new DockerInstance();
    containerName = await docker.startContainer('node:latest', 'test-container');
  });

  afterAll(async () => {
    await docker.shutdownContainer();
  });

  test('should run simple commands', async () => {
    const result = await docker.runCommands(['echo', 'hello']);
    expect(result.status).toBe(DockerRunStatus.SUCCESS);
    expect(result.output).toContain('hello');
  });
});
```

## 🐳 Docker Integration

### Container Management

FSC creates isolated Docker containers for each task execution, ensuring:

- **Security**: Complete isolation from host system
- **Consistency**: Reproducible execution environments
- **Parallelism**: Multiple tasks can run simultaneously
- **Resource Management**: Controlled CPU and memory usage

### Supported Operations

- File copying (both directions)
- Command execution with timeout protection
- Real-time output streaming
- Resource monitoring
- Graceful shutdown

### Custom Docker Images

You can use custom Docker images:

```json
{
  "dockerImageRef": "custom/node:18-alpine",
  "dockerMemoryMB": 1536,
  "dockerCpuCores": 3
}
```

## 🔍 Troubleshooting

### Common Issues

#### Docker Connectivity

```bash
# Check Docker daemon
docker --version
docker info

# Test container creation
docker run --rm hello-world
```

#### Permission Issues

```bash
# Add user to docker group (Linux)
sudo usermod -aG docker $USER
newgrp docker
```

#### API Key Problems

```bash
# Verify API key format
echo $FSC_ANTHROPIC_API_KEY | head -c 20

# Test API connectivity
curl -H "x-api-key: $FSC_ANTHROPIC_API_KEY" \
     https://api.anthropic.com/v1/messages \
     -d '{"model":"claude-3-sonnet-20240229","max_tokens":10,"messages":[{"role":"user","content":"Hi"}]}'
```

### Debug Mode

Enable debug logging:

```bash
export DEBUG=fsc:*
node dist/main.js --debug https://github.com/user/repo.git
```

### Performance Tuning

#### Resource Optimization

```json
{
  "maxParallelDockerContainers": 2,
  "dockerTimeoutSeconds": 900,
  "dockerMemoryMB": 2048
}
```

#### Task Limiting

```json
{
  "maxTasks": 50,
  "minTasks": 5
}
```

## 🤝 Contributing

### Development Setup

1. **Fork and clone**
   ```bash
   git clone https://github.com/NO-CHATBOT-REVOLUTION/full-self-coding.git
   cd full-self-coding
   ```

2. **Install development dependencies**
   ```bash
   bun install
   ```

### Code Style

- **TypeScript**: Strict mode enabled
- **Pure TypeScript**: No build step required
- **Bun**: Fast JavaScript runtime

```bash
# Run tests
bun run test

# Run development server
bun run dev

# Start CLI
bun run start
```

### Testing Requirements

- **Coverage**: Minimum 90% coverage required
- **Unit Tests**: All public methods must have tests
- **Integration Tests**: Critical workflows must be tested

```bash
# Run tests
bun run test

# Run tests with timeout
bun run test --timeout 30000
```

### Pull Request Process

1. **Create feature branch**
   ```bash
   git checkout -b feature/new-feature
   ```

2. **Make changes and test**
   ```bash
   bun run test
   ```

3. **Commit and push**
   ```bash
   git commit -m "feat: add new feature"
   git push origin feature/new-feature
   ```

4. **Create pull request**
   - Include comprehensive description
   - Reference related issues
   - Include test results

## 📚 Advanced Topics

### Custom Agent Integration

To add a new agent type:

1. **Define enum value**
   ```typescript
   // src/config.ts
   export enum SWEAgentType {
     CLAUDE_CODE = 'claude-code',
     GEMINI_CLI = 'gemini-cli',
     CODEX = 'codex',
     CUSTOM_AGENT = 'custom-agent'
   }
   ```

2. **Implement agent commands**
   ```typescript
   // src/SWEAgent/customAgentCommands.ts
   export function customAgentCommands(
     config: Config,
     task: Task,
     gitUrl: string
   ): string[] {
     // Implementation
   }
   ```

3. **Update command builder**
   ```typescript
   // src/SWEAgent/SWEAgentTaskSolverCommands.ts
   switch (agentType) {
     case SWEAgentType.CUSTOM_AGENT:
       return customAgentCommands(config, task, gitUrl);
   }
   ```

### Custom Work Styles

Define custom work styles by extending the `WorkStyle` enum and implementing corresponding prompt generation logic.

### Monitoring and Observability

#### Metrics Collection

FSC supports integration with monitoring systems:

```typescript
// Add custom metrics
import { MetricsCollector } from './src/metrics';

const metrics = new MetricsCollector();
metrics.recordTaskExecution(task, duration, success);
metrics.recordResourceUsage(containerId, cpu, memory);
```

#### Logging

Configure logging levels and outputs:

```typescript
import { Logger } from './src/logger';

const logger = new Logger({
  level: 'debug',
  output: 'file',
  filename: 'fsc.log'
});
```

### Security Considerations

- **API Key Management**: Use environment variables or secure vault
- **Container Isolation**: Containers run with limited privileges
- **Network Access**: Control container network access
- **File System**: Limit file system access within containers

## 📄 License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **Anthropic** - For Claude Code integration
- **Google** - For Gemini CLI integration
- **Docker** - For containerization platform
- **Bun** - For fast JavaScript runtime

## 📞 Support

- **GitHub Issues**: [Report bugs and request features](https://github.com/NO-CHATBOT-REVOLUTION/full-self-coding/issues)
- **Discussions**: [Community discussions and Q&A](https://github.com/NO-CHATBOT-REVOLUTION/full-self-coding/discussions)
- **Documentation**: [Full documentation site](https://full-self-coding.docs.com) (Coming Soon)

---

**Built with ❤️ by the Full Self Coding team**
