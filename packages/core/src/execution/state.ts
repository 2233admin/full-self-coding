export type SchedulerTaskStatus = "pending" | "dispatched" | "running" | "completed" | "failed" | "aborted";

export interface TaskState {
  taskId: string;
  status: SchedulerTaskStatus;
  target: "local" | "remote";
  worktreePath?: string;
  agentType?: string;
  startedAt?: number;
  completedAt?: number;
  commitHash?: string;
  error?: string;
  retryCount: number;
}

export interface TaskStateSummary {
  total: number;
  pending: number;
  dispatched: number;
  running: number;
  completed: number;
  failed: number;
  aborted: number;
}

export class TaskStateStore {
  private states: Map<string, TaskState> = new Map();

  create(taskId: string, target: "local" | "remote" = "local"): TaskState {
    const state: TaskState = { taskId, status: "pending", target, retryCount: 0 };
    this.states.set(taskId, state);
    return state;
  }

  transition(taskId: string, status: SchedulerTaskStatus, update?: Partial<TaskState>): void {
    const state = this.states.get(taskId);
    if (!state) throw new Error(`Task ${taskId} not found`);
    state.status = status;
    if (update) Object.assign(state, update);
    // Auto-set timestamps
    if (status === "running" && !state.startedAt) state.startedAt = Date.now();
    if ((status === "completed" || status === "failed" || status === "aborted") && !state.completedAt) {
      state.completedAt = Date.now();
    }
  }

  get(taskId: string): TaskState | undefined {
    return this.states.get(taskId);
  }

  list(filter?: { status?: SchedulerTaskStatus; target?: string }): TaskState[] {
    let results = [...this.states.values()];
    if (filter?.status) results = results.filter(s => s.status === filter.status);
    if (filter?.target) results = results.filter(s => s.target === filter.target);
    return results;
  }

  summary(): TaskStateSummary {
    const all = [...this.states.values()];
    return {
      total: all.length,
      pending: all.filter(s => s.status === "pending").length,
      dispatched: all.filter(s => s.status === "dispatched").length,
      running: all.filter(s => s.status === "running").length,
      completed: all.filter(s => s.status === "completed").length,
      failed: all.filter(s => s.status === "failed").length,
      aborted: all.filter(s => s.status === "aborted").length,
    };
  }

  markAborted(taskId: string): void {
    this.transition(taskId, "aborted");
  }

  markForRetry(taskId: string): void {
    const state = this.states.get(taskId);
    if (!state) throw new Error(`Task ${taskId} not found`);
    state.status = "pending";
    state.retryCount++;
    state.error = undefined;
    state.completedAt = undefined;
    state.startedAt = undefined;
    state.commitHash = undefined;
  }

  getFailedTasks(): TaskState[] {
    return this.list({ status: "failed" });
  }

  toJSON(): Record<string, TaskState> {
    return Object.fromEntries(this.states);
  }

  static fromJSON(data: Record<string, TaskState>): TaskStateStore {
    const store = new TaskStateStore();
    for (const [id, state] of Object.entries(data)) {
      store.states.set(id, { ...state });
    }
    return store;
  }
}
