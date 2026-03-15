// packages/core/src/execution/remote.ts
//
// Phase 2 stub — RemoteExecution will dispatch WorkUnits to remote nodes via a pluggable Transport.
// RedisTransport will reuse DistributedScheduler's Redis Streams infrastructure (see claw-mesh).

import type { WorkUnit, ExecutionResult } from "./types";

/**
 * Pluggable transport for remote execution.
 * Phase 2 implementations: RedisTransport (Redis Streams), HttpTransport (REST).
 */
export interface Transport {
  /** Send a WorkUnit to a remote worker. Returns a job ID. */
  send(unit: WorkUnit): Promise<string>;
  /** Poll for result by job ID. Resolves when complete or rejects on timeout. */
  poll(jobId: string, timeoutMs: number): Promise<ExecutionResult>;
  /** Cancel a dispatched job. */
  cancel(jobId: string): Promise<void>;
}

/**
 * Remote execution engine — Phase 2 placeholder.
 * Dispatches WorkUnits to remote worker nodes via a Transport.
 */
export class RemoteExecution {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_transport?: Transport) {
    // Transport injection point for Phase 2
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async execute(_unit: WorkUnit): Promise<ExecutionResult> {
    throw new Error("not implemented - Phase 2");
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async cancel(_jobId: string): Promise<void> {
    throw new Error("not implemented - Phase 2");
  }
}
