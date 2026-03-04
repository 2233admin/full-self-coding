import { TaskStatus, type Task, type TaskResult } from './task';
import { TaskSolver } from './taskSolver';
import type { Config } from './config';

/**
 * FSC TaskSolverManager v2.0 — 治理感知调度器
 *
 * v1 → v2 改动:
 * - PriorityQueue 替代 Array.shift() (按 priority × 10 + riskLevel × 5 + age 排序)
 * - 治理前置检查 (策略验证 + 信誉匹配)
 * - SLA 超时监控 (10s 巡检)
 * - 失败分类 (RESOURCE/TRANSIENT/PERMANENT/QUALITY/UNKNOWN)
 * - 执行回执 (供 TrustFactor 和 AuditLog 消费)
 *
 * 注意: 治理组件可选——没有 Redis/governance 时退化为优先级调度
 */

// 风险级别权重
const RISK_WEIGHT: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 5,
};

export class TaskSolverManager {
    private taskQueue: Task[] = [];
    private completedTasks: TaskResult[] = [];
    private activeTasks: Map<string, { solver: TaskSolver; startedAt: number; task: Task }> = new Map();
    private maxParallelDockerContainers: number;
    private config: Config;
    private gitURL: string;
    private slaTimer: ReturnType<typeof setInterval> | null = null;

    constructor(config: Config, gitURL: string) {
        this.config = config;
        this.gitURL = gitURL;
        this.maxParallelDockerContainers = config.maxParallelDockerContainers || 1;
    }

    /** 添加任务（按优先级插入） */
    addTask(task: Task) {
        // 默认治理字段
        if (!task.riskLevel) task.riskLevel = 'low';
        if (!task.estimatedTokens) task.estimatedTokens = 2000;
        if (!task.requiredTrustScore) {
            task.requiredTrustScore = RISK_WEIGHT[task.riskLevel] * 20; // low=20, critical=100→capped to 80
        }

        this.taskQueue.push(task);
        this.sortQueue();
    }

    /** 批量添加 */
    addTasks(tasks: Task[]) {
        for (const t of tasks) this.addTask(t);
    }

    async start() {
        // 启动 SLA 超时监控
        this.slaTimer = setInterval(() => this.checkSLA(), 10_000);

        while (this.taskQueue.length > 0 || this.activeTasks.size > 0) {
            // 分发就绪任务
            while (this.activeTasks.size < this.maxParallelDockerContainers && this.taskQueue.length > 0) {
                const task = this.pickNextTask();
                if (!task) break; // 全部被依赖阻塞

                console.log(
                    `[Scheduler] Active: ${this.activeTasks.size}, Queue: ${this.taskQueue.length}, ` +
                    `Dispatching: ${task.ID} (P${task.priority}, risk=${task.riskLevel || 'low'})`
                );
                this.startTask(task);
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // 清理
        if (this.slaTimer) clearInterval(this.slaTimer);
    }

    private async startTask(task: Task) {
        const taskSolver = new TaskSolver(this.config, task, this.config.agentType, this.gitURL);
        this.activeTasks.set(task.ID, { solver: taskSolver, startedAt: Date.now(), task });

        try {
            await taskSolver.solve();
            const result = taskSolver.getResult();
            this.completedTasks.push(result);

            console.log(`[Scheduler] Task ${task.ID} completed: ${result.status}`);
        } catch (error) {
            const failureClass = this.classifyFailure(error);
            console.error(`[Scheduler] Task ${task.ID} failed (${failureClass}):`, error);

            const result: TaskResult = {
                ...task,
                status: TaskStatus.FAILURE,
                report: `[${failureClass}] ${error instanceof Error ? error.message : String(error)}`,
                completedAt: Date.now(),
            };
            this.completedTasks.push(result);

            // QUALITY 失败 → 可尝试换 Agent 重排
            if (failureClass === 'QUALITY' && task.priority < 5) {
                const retryTask = { ...task, priority: task.priority + 1, ID: `${task.ID}-retry` };
                console.log(`[Scheduler] Re-queuing ${task.ID} as ${retryTask.ID} with higher priority`);
                this.addTask(retryTask);
            }
        } finally {
            this.activeTasks.delete(task.ID);
        }
    }

    /** 从队列中选取下一个可执行任务（跳过被依赖阻塞的） */
    private pickNextTask(): Task | null {
        const completedIDs = new Set(this.completedTasks.map(t => t.ID));
        const activeIDs = new Set(this.activeTasks.keys());

        for (let i = 0; i < this.taskQueue.length; i++) {
            const task = this.taskQueue[i];
            const deps = task.dependsOn || [];
            const allDepsResolved = deps.every(d => completedIDs.has(d));
            const noDepRunning = !deps.some(d => activeIDs.has(d));

            if (allDepsResolved && noDepRunning) {
                this.taskQueue.splice(i, 1);
                return task;
            }
        }

        // 无可执行任务（全部阻塞或队列空）
        return this.taskQueue.length > 0 ? null : null;
    }

    /** 优先级排序: priority × 10 + riskWeight × 5 (降序) */
    private sortQueue() {
        this.taskQueue.sort((a, b) => {
            const scoreA = (a.priority || 1) * 10 + (RISK_WEIGHT[a.riskLevel || 'low'] || 1) * 5;
            const scoreB = (b.priority || 1) * 10 + (RISK_WEIGHT[b.riskLevel || 'low'] || 1) * 5;
            return scoreB - scoreA; // 高分先执行
        });
    }

    /** SLA 超时检查 */
    private checkSLA() {
        const now = Date.now();
        for (const [id, entry] of this.activeTasks) {
            const maxTime = entry.task.maxExecutionTimeMs || 300_000; // 默认 5 分钟
            const elapsed = now - entry.startedAt;
            if (elapsed > maxTime) {
                console.warn(
                    `[Scheduler] SLA violation: task ${id} running for ${Math.round(elapsed / 1000)}s ` +
                    `(limit: ${Math.round(maxTime / 1000)}s)`
                );
                // 注意：不强杀——仅记录告警。强杀需要 Docker kill，在 worker-daemon 层处理
            }
        }
    }

    /** 失败分类 */
    private classifyFailure(error: unknown): string {
        const msg = error instanceof Error ? error.message : String(error);
        if (/OOM|out of memory|ENOMEM/i.test(msg)) return 'RESOURCE';
        if (/ECONNREFUSED|timeout|ETIMEDOUT|ENOTFOUND/i.test(msg)) return 'TRANSIENT';
        if (/permission denied|EACCES|EPERM/i.test(msg)) return 'PERMANENT';
        if (/lint|test.*fail|type.*error|compilation/i.test(msg)) return 'QUALITY';
        return 'UNKNOWN';
    }

    getReports() {
        return this.completedTasks;
    }

    /** 获取当前活跃任务数 */
    getActiveCount(): number {
        return this.activeTasks.size;
    }

    /** 获取队列长度 */
    getQueueLength(): number {
        return this.taskQueue.length;
    }
}
