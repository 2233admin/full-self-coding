/**
 * FSC Agent Pool — Agent 实例池管理
 *
 * 类比 CUDA:
 * - Pool = SM (Streaming Multiprocessor)
 * - Agent = CUDA Core
 * - Task = Thread
 *
 * 与 Docker 的对比:
 * - Docker: 每次任务 docker run → 执行 → docker rm (3-5s 开销)
 * - Agent Pool: 预热 Agent → 分配任务 → 复用 (0ms 开销)
 *
 * 特性:
 * - 预热 N 个 Agent，空闲时复用
 * - 自动扩缩: 忙时创建，闲时回收
 * - 过期回收: 超过 idleTimeout 的 Agent 被销毁
 * - 健康检查: 30s 巡检
 */

import { Agent, type AgentOptions, type TaskPayload, type TaskResult } from "./agent";

export interface PoolConfig {
  /** 最小常驻 Agent 数 */
  minAgents: number;
  /** 最大 Agent 数 */
  maxAgents: number;
  /** 内存保护: 可用内存低于此值 (MB) 时停止扩容 (默认 200) */
  memoryFloorMb?: number;
  /** Agent 工作空间根目录 */
  workspaceRoot: string;
  /** 是否启用沙箱 */
  enableSandbox?: boolean;
  /** 允许网络访问 */
  allowNetwork?: boolean;
  /** Agent 空闲超时秒数 */
  agentIdleTimeoutSeconds?: number;
  /** 池巡检间隔秒数 (默认 30) */
  healthCheckIntervalSeconds?: number;
  /** 基础环境变量 (所有 Agent 共享) */
  baseEnv?: Record<string, string>;
}

export class AgentPool {
  private agents: Map<string, Agent> = new Map();
  private config: PoolConfig;
  private nextAgentNum = 0;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private taskQueue: Array<{
    task: TaskPayload;
    resolve: (result: TaskResult) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(config: PoolConfig) {
    this.config = {
      enableSandbox: true,
      allowNetwork: true,
      agentIdleTimeoutSeconds: 600,
      healthCheckIntervalSeconds: 30,
      ...config,
    };
  }

  /** 启动 Pool，预热最小数量的 Agent */
  async start(): Promise<void> {
    console.log(
      `[pool] Starting with min=${this.config.minAgents}, max=${this.config.maxAgents}, ` +
      `sandbox=${this.config.enableSandbox}`
    );

    // 预热
    const warmupPromises: Promise<void>[] = [];
    for (let i = 0; i < this.config.minAgents; i++) {
      warmupPromises.push(this.createAgent());
    }
    await Promise.all(warmupPromises);

    // 健康巡检
    const interval = (this.config.healthCheckIntervalSeconds || 30) * 1000;
    this.healthCheckTimer = setInterval(() => this.healthCheck(), interval);

    console.log(`[pool] Ready with ${this.agents.size} agents`);
  }

  /** 提交任务，返回结果 */
  async submit(task: TaskPayload): Promise<TaskResult> {
    // 尝试找空闲 Agent
    const agent = this.findIdleAgent();

    if (agent) {
      return agent.execute(task);
    }

    // 没有空闲的，尝试扩容 (内存保护)
    if (this.agents.size < this.config.maxAgents && await this.hasMemoryHeadroom()) {
      await this.createAgent();
      const newAgent = this.findIdleAgent();
      if (newAgent) {
        return newAgent.execute(task);
      }
    }

    // 全满，排队等待
    return new Promise<TaskResult>((resolve, reject) => {
      this.taskQueue.push({ task, resolve, reject });
      console.log(`[pool] Task ${task.id} queued (queue=${this.taskQueue.length})`);
    });
  }

  /** 获取 Pool 状态 */
  getStats(): {
    total: number;
    idle: number;
    busy: number;
    queued: number;
  } {
    let idle = 0;
    let busy = 0;
    for (const agent of this.agents.values()) {
      if (agent.getState() === "idle") idle++;
      else if (agent.getState() === "busy") busy++;
    }
    return {
      total: this.agents.size,
      idle,
      busy,
      queued: this.taskQueue.length,
    };
  }

  /** 优雅关闭 */
  async shutdown(): Promise<void> {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    // 拒绝排队的任务
    for (const queued of this.taskQueue) {
      queued.reject(new Error("Pool shutting down"));
    }
    this.taskQueue = [];

    // 等待 busy agent 完成，然后销毁所有
    const destroyPromises: Promise<void>[] = [];
    for (const agent of this.agents.values()) {
      destroyPromises.push(agent.destroy());
    }
    await Promise.allSettled(destroyPromises);
    this.agents.clear();

    console.log("[pool] Shutdown complete");
  }

  // ─── 内部方法 ───

  private async hasMemoryHeadroom(): Promise<boolean> {
    const floorMb = this.config.memoryFloorMb ?? 200;
    try {
      const meminfo = await Bun.file("/proc/meminfo").text();
      const total = parseInt(meminfo.match(/MemTotal:\s+(\d+)/)?.[1] || "0");
      const available = parseInt(meminfo.match(/MemAvailable:\s+(\d+)/)?.[1] || "0");
      const totalMb = Math.round(total / 1024);
      const availableMb = Math.round(available / 1024);
      // 双重保护: 绝对值 + 百分比 (busy agents 运行时会消耗更多)
      const usedPct = totalMb > 0 ? Math.round((1 - available / total) * 100) : 0;
      if (availableMb < floorMb || usedPct > 60) {
        console.warn(`[pool] Memory guard: ${availableMb}MB available (${usedPct}% used), refusing scale-up`);
        return false;
      }
      return true;
    } catch {
      return true; // 读不到就放行
    }
  }

  private async createAgent(): Promise<void> {
    const id = `agent-${this.nextAgentNum++}`;
    const options: AgentOptions = {
      id,
      workspaceRoot: this.config.workspaceRoot,
      enableSandbox: this.config.enableSandbox,
      allowNetwork: this.config.allowNetwork,
      env: this.config.baseEnv,
      idleTimeoutSeconds: this.config.agentIdleTimeoutSeconds,
    };

    const agent = new Agent(options);
    await agent.init();
    this.agents.set(id, agent);
  }

  private findIdleAgent(): Agent | null {
    for (const agent of this.agents.values()) {
      if (agent.getState() === "idle") {
        return agent;
      }
    }
    return null;
  }

  private async healthCheck(): Promise<void> {
    const stats = this.getStats();

    // 回收过期 Agent (保留最小数量)
    const expiredIds: string[] = [];
    for (const [id, agent] of this.agents) {
      if (agent.isExpired() && this.agents.size - expiredIds.length > this.config.minAgents) {
        expiredIds.push(id);
      }
    }
    for (const id of expiredIds) {
      const agent = this.agents.get(id)!;
      await agent.destroy();
      this.agents.delete(id);
      console.log(`[pool] Reclaimed expired agent ${id}`);
    }

    // 处理排队任务
    while (this.taskQueue.length > 0) {
      const agent = this.findIdleAgent();
      if (!agent) {
        // 尝试扩容 (内存保护)
        if (this.agents.size < this.config.maxAgents && await this.hasMemoryHeadroom()) {
          await this.createAgent();
          continue;
        }
        break;
      }

      const queued = this.taskQueue.shift()!;
      agent.execute(queued.task).then(queued.resolve).catch(queued.reject);
    }

    if (expiredIds.length > 0 || this.taskQueue.length > 0) {
      console.log(
        `[pool] Health: ${this.agents.size} agents (${stats.idle} idle, ${stats.busy} busy), ` +
        `${this.taskQueue.length} queued, ${expiredIds.length} reclaimed`
      );
    }
  }
}
