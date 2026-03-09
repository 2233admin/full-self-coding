/**
 * FSC Agent — 单个 Agent 实例的生命周期管理
 *
 * 一个 Agent = 一个 git worktree + bubblewrap 沙箱
 *
 * 生命周期:
 *   IDLE → BUSY → IDLE (复用)
 *   IDLE → DEAD (超时回收)
 *
 * 与 Docker 的区别:
 * - worktree 创建: O(1)，硬链接 git objects
 * - 内存开销: 0 (没有额外进程)
 * - 启动: 即时
 * - 沙箱: bwrap 包裹每次命令执行
 */

import { execInSandbox, checkSandboxAvailable, type SandboxConfig } from "./sandbox";
import { runApiAgent } from "./api-agent";

export type AgentState = "idle" | "busy" | "dead";

export interface AgentOptions {
  /** Agent 唯一标识 */
  id: string;
  /** 工作空间根目录 */
  workspaceRoot: string;
  /** 是否启用 bwrap 沙箱 (不可用时自动降级) */
  enableSandbox?: boolean;
  /** 网络访问 (Agent 需要调 LLM API) */
  allowNetwork?: boolean;
  /** 沙箱环境变量 */
  env?: Record<string, string>;
  /** 空闲超时秒数 (超过则回收, 默认 600) */
  idleTimeoutSeconds?: number;
}

export interface TaskPayload {
  id: string;
  title?: string;
  description?: string;
  gitUrl?: string;
  branch?: string;
  commands?: string[];
  agentType?: "claude" | "gemini" | "codex" | "bash" | "api";
  apiKey?: string;
  timeoutSeconds?: number;
  /** 额外环境变量 */
  env?: Record<string, string>;
}

export interface TaskResult {
  taskId: string;
  agentId: string;
  status: "success" | "failure";
  output: string;
  error: string;
  gitDiff: string;
  durationMs: number;
  failureClass: string;
  timestamp: number;
}

export class Agent {
  readonly id: string;
  private state: AgentState = "idle";
  private workDir: string;
  private sandboxEnabled: boolean;
  private allowNetwork: boolean;
  private baseEnv: Record<string, string>;
  private lastActiveAt: number = Date.now();
  private idleTimeout: number;
  private currentTaskId: string | null = null;
  private repoCloned = false;
  private lastGitUrl: string | null = null;

  constructor(options: AgentOptions) {
    this.id = options.id;
    this.workDir = `${options.workspaceRoot}/${options.id}`;
    this.sandboxEnabled = options.enableSandbox ?? true;
    this.allowNetwork = options.allowNetwork ?? true;
    this.baseEnv = options.env || {};
    this.idleTimeout = (options.idleTimeoutSeconds || 600) * 1000;
  }

  getState(): AgentState { return this.state; }
  getCurrentTaskId(): string | null { return this.currentTaskId; }
  getLastActiveAt(): number { return this.lastActiveAt; }

  isExpired(): boolean {
    return this.state === "idle" && (Date.now() - this.lastActiveAt > this.idleTimeout);
  }

  /** 初始化 Agent 工作目录 */
  async init(): Promise<void> {
    await this.execHost(`mkdir -p ${this.workDir}`);

    // 检测沙箱
    if (this.sandboxEnabled) {
      const available = await checkSandboxAvailable();
      if (!available) {
        console.warn(`[agent:${this.id}] bwrap not available, falling back to bare exec`);
        this.sandboxEnabled = false;
      }
    }

    console.log(`[agent:${this.id}] initialized (sandbox=${this.sandboxEnabled})`);
  }

  /** 执行任务 */
  async execute(task: TaskPayload): Promise<TaskResult> {
    if (this.state !== "idle") {
      throw new Error(`Agent ${this.id} is ${this.state}, cannot accept task`);
    }

    this.state = "busy";
    this.currentTaskId = task.id;
    this.lastActiveAt = Date.now();
    const startTime = Date.now();

    try {
      // 1. 准备代码库
      await this.prepareRepo(task);

      // 2. 写入 task prompt
      const prompt = this.buildPrompt(task);
      await this.writeFile("task_prompt.md", prompt);

      // 3. 执行
      const execResult = await this.executeTask(task);

      // 3.5 自动 commit + push (LLM 可能忘记或搞坏 git)
      if (task.gitUrl) {
        await this.autoCommitAndPush(task);
      }

      // 4. 收集 diff
      const diff = await this.getDiff();

      const result: TaskResult = {
        taskId: task.id,
        agentId: this.id,
        status: execResult.success ? "success" : "failure",
        output: execResult.output.slice(0, 20000),
        error: execResult.success ? "" : execResult.output.slice(-3000),
        gitDiff: diff,
        durationMs: Date.now() - startTime,
        failureClass: execResult.success ? "" : classifyFailure(execResult.output),
        timestamp: Date.now(),
      };

      return result;
    } catch (e: any) {
      return {
        taskId: task.id,
        agentId: this.id,
        status: "failure",
        output: "",
        error: e.message,
        gitDiff: "",
        durationMs: Date.now() - startTime,
        failureClass: classifyFailure(e.message),
        timestamp: Date.now(),
      };
    } finally {
      this.state = "idle";
      this.currentTaskId = null;
      this.lastActiveAt = Date.now();
    }
  }

  /** 清理并标记为 dead */
  async destroy(): Promise<void> {
    this.state = "dead";
    await this.execHost(`rm -rf ${this.workDir}`);
    console.log(`[agent:${this.id}] destroyed`);
  }

  // ─── 内部方法 ───

  private async prepareRepo(task: TaskPayload): Promise<void> {
    const gitUrl = task.gitUrl;

    if (!gitUrl) {
      // 无 git repo，直接用空工作目录
      await this.execHost(`mkdir -p ${this.workDir}/repo`);
      return;
    }

    // 智能复用: 同一个 repo 不重新 clone
    if (this.repoCloned && this.lastGitUrl === gitUrl) {
      // 重置到最新
      await this.exec("cd repo && git fetch origin && git reset --hard origin/HEAD && git clean -fd");
      if (task.branch) {
        await this.exec(`cd repo && git checkout -B ${task.branch} origin/${task.branch} 2>/dev/null || git checkout -b ${task.branch}`);
      }
      return;
    }

    // 清理旧 repo
    await this.execHost(`rm -rf ${this.workDir}/repo`);

    // 浅克隆
    const cloneCmd = `git clone --depth 1 ${task.branch ? `-b ${task.branch}` : ""} ${gitUrl} ${this.workDir}/repo`;
    const { success } = await this.execHost(cloneCmd, 120000);
    if (!success) {
      throw new Error(`Failed to clone ${gitUrl}`);
    }

    // 设置 git user (避免 agent 自己 git init)
    await this.execHost(`cd ${this.workDir}/repo && git config user.name "FSC Agent" && git config user.email "agent@fsc-mesh.local"`);

    this.repoCloned = true;
    this.lastGitUrl = gitUrl;

    // 自动创建任务分支 (避免并行冲突)
    const taskBranch = `fsc/${task.id}`;
    await this.execHost(`cd ${this.workDir}/repo && git checkout -b ${taskBranch}`, 10000);
    console.log(`[agent:${this.id}] Created branch ${taskBranch}`);
  }

  private buildPrompt(task: TaskPayload): string {
    return [
      `# Task: ${task.title || task.id}`,
      "",
      "## Description",
      task.description || "(no description)",
      "",
      "## Constraints",
      "- Work in /workspace/repo/",
      "- Commit your changes with a descriptive message",
      "- Write a summary to /workspace/finalReport.json",
      "",
      "## Output Format",
      '```json',
      '{ "taskId": "...", "status": "success|failure", "report": "..." }',
      '```',
    ].join("\n");
  }

  private async executeTask(task: TaskPayload): Promise<{ output: string; success: boolean }> {
    const timeout = task.timeoutSeconds || 300;
    const env = { ...this.baseEnv, ...(task.env || {}) };

    if (task.commands && task.commands.length > 0) {
      // 命令模式: 逐条执行
      let output = "";
      for (const cmd of task.commands) {
        const result = await this.exec(cmd, timeout * 1000, env);
        output += `$ ${cmd}\n${result.output}\n`;
        if (!result.success) {
          return { output, success: false };
        }
      }
      return { output, success: true };
    }

    // Agent 模式
    const agentType = task.agentType || "api";

    // API agent: 内置 TypeScript loop，不需要外部 CLI
    if (agentType === "api") {
      return runApiAgent(task, {
        miniClawUrl: env.MINICLAW_URL || this.baseEnv.MINICLAW_URL || "http://127.0.0.1:18795",
        model: env.DEFAULT_MODEL || this.baseEnv.DEFAULT_MODEL || "doubao-seed-2.0-code",
        maxTurns: 30,
        maxTokensPerTurn: 4096,
        sandboxConfig: {
          workDir: this.workDir,
          allowNetwork: this.allowNetwork,
          timeoutSeconds: 60,
          env: { ...this.baseEnv, ...env },
        },
      });
    }

    const agentCmd = this.buildAgentCommand(agentType, task, env);
    return this.exec(agentCmd, timeout * 1000, env);
  }

  private buildAgentCommand(
    type: string,
    task: TaskPayload,
    env: Record<string, string>,
  ): string {
    const repoDir = "/workspace/repo";
    const promptFile = "/workspace/task_prompt.md";

    switch (type) {
      case "claude":
        return [
          task.apiKey ? `export ANTHROPIC_API_KEY="${task.apiKey}"` : "",
          env.ANTHROPIC_BASE_URL ? `export ANTHROPIC_BASE_URL="${env.ANTHROPIC_BASE_URL}"` : "",
          `cd ${repoDir}`,
          `claude -p "${promptFile}" --allowedTools "Bash,Read,Edit,Glob,Grep,Write" --permission-mode bypassPermissions`,
        ].filter(Boolean).join(" && ");

      case "gemini":
        return [
          task.apiKey ? `export GEMINI_API_KEY="${task.apiKey}"` : "",
          `cd ${repoDir}`,
          `gemini -p "${promptFile}"`,
        ].filter(Boolean).join(" && ");

      case "codex":
        return [
          task.apiKey ? `export OPENAI_API_KEY="${task.apiKey}"` : "",
          `cd ${repoDir}`,
          `codex -p "${promptFile}"`,
        ].filter(Boolean).join(" && ");

      default:
        // bash fallback: 执行 description 作为脚本
        return `cd ${repoDir} && bash -c '${(task.description || "echo ok").replace(/'/g, "'\\''")}'`;
    }
  }

  /** 自动 commit 未提交的修改并 push (在宿主机执行，不受沙箱限制) */
  private async autoCommitAndPush(task: TaskPayload): Promise<void> {
    const repoDir = `${this.workDir}/repo`;
    try {
      // 确保 git user 配置
      await this.execHost(`cd ${repoDir} && git config user.name "FSC Agent" && git config user.email "agent@fsc-mesh.local"`, 5000);
      // 如果 agent 跑了 git init 破坏了 remote，重新添加
      const { output: remotes } = await this.execHost(`cd ${repoDir} && git remote -v`, 5000);
      if (!remotes.includes("origin")) {
        await this.execHost(`cd ${repoDir} && git remote add origin ${task.gitUrl}`, 5000);
      }
      // Commit 未提交的修改
      await this.execHost(`cd ${repoDir} && git add -A && git diff --cached --quiet || git commit -m "agent: ${task.title || task.id}"`, 10000);
      // Push
      const { success, output } = await this.execHost(`cd ${repoDir} && git push origin HEAD 2>&1`, 30000);
      if (success) {
        console.log(`[agent:${this.id}] git push success`);
      } else {
        console.warn(`[agent:${this.id}] git push failed: ${output.slice(0, 200)}`);
      }
    } catch (e: any) {
      console.warn(`[agent:${this.id}] autoCommitAndPush error: ${e.message}`);
    }
  }

  private async getDiff(): Promise<string> {
    // 先尝试未提交的 diff，若为空则尝试最新 commit 的 diff
    const { output: uncommitted } = await this.execHost(
      `cd ${this.workDir}/repo 2>/dev/null && git diff HEAD 2>/dev/null || echo ""`,
      10000,
    );
    if (uncommitted.trim()) return uncommitted.trim();

    // Agent 可能已经 commit 了，拿最新 commit 的 diff
    const { output: committed } = await this.execHost(
      `cd ${this.workDir}/repo 2>/dev/null && git diff HEAD~1..HEAD 2>/dev/null || echo ""`,
      10000,
    );
    return committed.trim();
  }

  /** 在沙箱内执行 */
  private async exec(
    command: string,
    timeoutMs = 300000,
    extraEnv?: Record<string, string>,
  ): Promise<{ output: string; success: boolean; exitCode: number }> {
    if (this.sandboxEnabled) {
      const sandboxConfig: SandboxConfig = {
        workDir: this.workDir,
        allowNetwork: this.allowNetwork,
        timeoutSeconds: Math.ceil(timeoutMs / 1000),
        env: { ...this.baseEnv, ...(extraEnv || {}) },
        // SSH keys 只读挂载 (Agent 需要 git 操作)
        // .ssh 和 .gitconfig 用 sandbox 层的 ro-bind-try 处理
      readonlyBinds: [],
      };
      return execInSandbox(command, sandboxConfig);
    }

    // 降级: 裸执行
    return this.execHost(`cd ${this.workDir} && ${command}`, timeoutMs);
  }

  /** 宿主机直接执行 (用于 setup/cleanup) */
  private async execHost(
    command: string,
    timeoutMs = 30000,
  ): Promise<{ output: string; success: boolean; exitCode: number }> {
    try {
      const proc = Bun.spawn(["/usr/bin/bash", "-c", command], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...this.baseEnv },
      });

      const timeout = setTimeout(() => proc.kill(), timeoutMs);
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      clearTimeout(timeout);

      return {
        output: stdout + (stderr ? `\n[stderr] ${stderr}` : ""),
        success: exitCode === 0,
        exitCode,
      };
    } catch (e: any) {
      return { output: e.message, success: false, exitCode: -1 };
    }
  }

  private async writeFile(relativePath: string, content: string): Promise<void> {
    const fullPath = `${this.workDir}/${relativePath}`;
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    await this.execHost(`mkdir -p ${dir}`);
    await Bun.write(fullPath, content);
  }
}

// ─── 失败分类 ───

function classifyFailure(error: string): string {
  if (/OOM|out of memory|killed|ENOMEM/i.test(error)) return "RESOURCE";
  if (/timeout|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(error)) return "TRANSIENT";
  if (/permission denied|EACCES|EPERM/i.test(error)) return "PERMANENT";
  if (/lint|test.*fail|type.*error|compilation/i.test(error)) return "QUALITY";
  return "UNKNOWN";
}
