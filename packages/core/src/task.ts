/**
 * Represents a task to be executed by the system
 */
export interface Task {
    /**
     * The title of the task
     */
    title: string;

    /**
     * Detailed description of what the task should accomplish
     */
    description: string;

    /**
     * Priority level of the task. Higher number means higher priority
     * @example
     * 1 = Low priority
     * 2 = Medium priority
     * 3 = High priority
     * 4 = Critical priority
     * 5 = Immediate priority
     */
    priority: number;

    /**
     * The ID of the task
     */
    ID: string;

    // ============ 治理扩展字段 ============
    /** 风险级别 (默认 low) */
    riskLevel?: 'low' | 'medium' | 'high' | 'critical';
    /** 预估 token 消耗 */
    estimatedTokens?: number;
    /** 依赖的前置任务 ID */
    dependsOn?: string[];
    /** 最低信誉要求 */
    requiredTrustScore?: number;
    /** 最大执行时间 (ms) */
    maxExecutionTimeMs?: number;
    /** 指定 Agent (空则自动匹配) */
    assignedAgent?: string;
}

/**
 * Status of a completed task
 */
export enum TaskStatus {
    SUCCESS = 'success',
    FAILURE = 'failure',
    ONGOING = 'ongoing',
    NOT_STARTED = 'not_started',
    SKIPPED = 'skipped',
}

/**
 * Represents the result of an executed task, including the original task properties
 * and execution outcomes
 */
export interface TaskResult extends Task {

    /**
     * The title of the task
     */
    title: string;

    /**
     * Detailed description of what the task should accomplish
     */
    description: string;

    /**
     * The status of the task execution
     */
    status: TaskStatus;

    /**
     * Detailed report of what was done, any issues encountered,
     * and the final outcome
     */
    report: string;

    /**
     * Unix timestamp (in milliseconds) when the task completed
     */
    completedAt?: number;

    /**
     * 
     * The git diff of the changes made by this task
     */
    gitDiff?: string;
}
