export type SchedulerTaskStatus = "pending" | "dispatched" | "running" | "waiting" | "completed" | "failed" | "aborted";

/**
 * Decision gate — agent declares it needs human input before proceeding.
 * Watchdog/scheduler should NOT kill agents in "waiting" status.
 */
export interface DecisionGate {
  question: string;
  options?: string[];
  context?: string;
  /** When the gate was raised */
  raisedAt: number;
  /** Max wait time in ms before auto-escalation (default: 10 min) */
  timeoutMs: number;
  /** Human's response, set when resolved */
  response?: string;
}

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
  /** Active decision gate — agent is paused waiting for human input */
  decisionGate?: DecisionGate;
}

export interface TaskStateSummary {
  total: number;
  pending: number;
  dispatched: number;
  running: number;
  waiting: number;
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
      waiting: all.filter(s => s.status === "waiting").length,
      completed: all.filter(s => s.status === "completed").length,
      failed: all.filter(s => s.status === "failed").length,
      aborted: all.filter(s => s.status === "aborted").length,
    };
  }

  markAborted(taskId: string): void {
    this.transition(taskId, "aborted");
  }

  /**
   * Raise a decision gate — agent needs human input.
   * Transitions status to "waiting" so watchdog won't kill it.
   */
  raiseDecisionGate(taskId: string, question: string, options?: string[], timeoutMs: number = 600_000): void {
    const gate: DecisionGate = { question, options, raisedAt: Date.now(), timeoutMs };
    this.transition(taskId, "waiting", { decisionGate: gate });
  }

  /**
   * Resolve a decision gate — human responded.
   * Transitions back to "running" so agent can continue.
   */
  resolveDecisionGate(taskId: string, response: string): void {
    const state = this.states.get(taskId);
    if (!state?.decisionGate) throw new Error(`Task ${taskId} has no active decision gate`);
    state.decisionGate.response = response;
    state.status = "running";
  }

  /**
   * Check for expired decision gates.
   * Returns tasks whose gates have exceeded their timeout.
   */
  getExpiredGates(): TaskState[] {
    const now = Date.now();
    return [...this.states.values()].filter(s =>
      s.status === "waiting" && s.decisionGate &&
      (now - s.decisionGate.raisedAt) > s.decisionGate.timeoutMs
    );
  }

  /** Check if a task is waiting for human decision (watchdog should skip it) */
  isWaitingForDecision(taskId: string): boolean {
    const state = this.states.get(taskId);
    return state?.status === "waiting" && !!state.decisionGate;
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
