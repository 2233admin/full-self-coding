/**
 * FSC Distributed Scheduler — Redis Streams 分布式任务分发
 *
 * 本地模式: TaskSolverManager (单机并行)
 * 分布式模式: DistributedScheduler (Redis Streams → 多节点消费)
 *
 * 数据流:
 *   submitTask → XADD fsc:tasks → Worker XREADGROUP → 执行 → XADD fsc:results
 *
 * 环境变量:
 *   FSC_REDIS_URL — Redis 连接 (默认 redis://:fsc-mesh-2026@10.10.0.1:6379)
 *   FSC_CONSUMER_GROUP — 消费组名 (默认 fsc-workers)
 */

import type { Task, TaskResult } from './task';
import { TaskStatus } from './task';

const TASK_STREAM = 'fsc:tasks';
const RESULT_STREAM = 'fsc:results';
const DEFAULT_REDIS_URL = 'redis://:fsc-mesh-2026@10.10.0.1:6379';

export interface DistributedSchedulerOptions {
  redisUrl?: string;
  consumerGroup?: string;
  /** 提交后等待结果的最大时间 (ms) */
  resultTimeoutMs?: number;
}

export class DistributedScheduler {
  private redisUrl: string;
  private consumerGroup: string;
  private resultTimeoutMs: number;
  private redis: any = null;

  constructor(options: DistributedSchedulerOptions = {}) {
    this.redisUrl = options.redisUrl || process.env.FSC_REDIS_URL || DEFAULT_REDIS_URL;
    this.consumerGroup = options.consumerGroup || process.env.FSC_CONSUMER_GROUP || 'fsc-workers';
    this.resultTimeoutMs = options.resultTimeoutMs || 600_000; // 10 minutes
  }

  async connect(): Promise<void> {
    const { createClient } = await import('redis');
    this.redis = createClient({ url: this.redisUrl });
    this.redis.on('error', (err: Error) => console.error('[DistScheduler] Redis:', err.message));
    await this.redis.connect();

    // Ensure consumer group exists
    try {
      await this.redis.xGroupCreate(TASK_STREAM, this.consumerGroup, '0', { MKSTREAM: true });
    } catch (e: any) {
      if (!e.message?.includes('BUSYGROUP')) throw e;
    }

    console.log(`[DistScheduler] Connected to ${this.redisUrl}`);
  }

  async disconnect(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
  }

  /** 提交任务到 Redis Stream */
  async submitTask(task: Task): Promise<string> {
    if (!this.redis) throw new Error('Not connected');

    const id = await this.redis.xAdd(TASK_STREAM, '*', {
      task_id: task.ID,
      title: task.title,
      description: task.description,
      priority: String(task.priority),
      risk_level: task.riskLevel || 'low',
      estimated_tokens: String(task.estimatedTokens || 2000),
      required_trust_score: String(task.requiredTrustScore || 0),
      depends_on: JSON.stringify(task.dependsOn || []),
      max_execution_time_ms: String(task.maxExecutionTimeMs || 300_000),
      assigned_agent: task.assignedAgent || '',
      submitted_at: String(Date.now()),
    });

    console.log(`[DistScheduler] Submitted task ${task.ID} → ${id}`);
    return id;
  }

  /** 批量提交任务 */
  async submitTasks(tasks: Task[]): Promise<string[]> {
    const ids: string[] = [];
    for (const task of tasks) {
      ids.push(await this.submitTask(task));
    }
    return ids;
  }

  /** 等待所有任务结果 (轮询 fsc:results) */
  async waitForResults(taskIds: string[], timeoutMs?: number): Promise<TaskResult[]> {
    if (!this.redis) throw new Error('Not connected');

    const timeout = timeoutMs || this.resultTimeoutMs;
    const deadline = Date.now() + timeout;
    const pending = new Set(taskIds);
    const results: TaskResult[] = [];
    let lastResultId = '$';

    while (pending.size > 0 && Date.now() < deadline) {
      const entries = await this.redis.xRead(
        [{ key: RESULT_STREAM, id: lastResultId }],
        { BLOCK: 2000, COUNT: 50 },
      );

      if (!entries) continue;

      for (const { messages } of entries) {
        for (const { id, message } of messages) {
          lastResultId = id;
          const taskId = message.task_id;

          if (pending.has(taskId)) {
            pending.delete(taskId);
            results.push({
              ID: taskId,
              title: message.title || taskId,
              description: message.description || '',
              priority: parseInt(message.priority || '1'),
              status: message.status === 'success' ? TaskStatus.SUCCESS : TaskStatus.FAILURE,
              report: message.result_preview || message.report || '',
              completedAt: parseInt(message.completed_at || String(Date.now())),
              gitDiff: message.git_diff || undefined,
            });
          }
        }
      }
    }

    // Mark timed-out tasks
    for (const taskId of pending) {
      results.push({
        ID: taskId,
        title: taskId,
        description: '',
        priority: 1,
        status: TaskStatus.FAILURE,
        report: `Timed out waiting for result (${timeout}ms)`,
        completedAt: Date.now(),
      });
    }

    return results;
  }

  /** 一键提交 + 等待结果 */
  async submitAndWait(tasks: Task[]): Promise<TaskResult[]> {
    const taskIds = tasks.map(t => t.ID);
    await this.submitTasks(tasks);
    return this.waitForResults(taskIds);
  }

  /** 获取队列状态 */
  async getQueueInfo(): Promise<{ pending: number; consumers: number }> {
    if (!this.redis) throw new Error('Not connected');

    try {
      const info = await this.redis.xInfoGroups(TASK_STREAM);
      const group = info.find((g: any) => g.name === this.consumerGroup);
      return {
        pending: group?.pending ?? 0,
        consumers: group?.consumers ?? 0,
      };
    } catch {
      return { pending: 0, consumers: 0 };
    }
  }
}
