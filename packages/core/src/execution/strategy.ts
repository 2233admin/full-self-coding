// packages/core/src/execution/strategy.ts
import type { WorkUnit, ExecutionResult, ExecutionStatus } from "./types";

export interface ExecutionStrategy {
  execute(unit: WorkUnit): Promise<ExecutionResult>;
  abort(unitId: string): Promise<void>;
  getStatus(unitId: string): ExecutionStatus;
}
