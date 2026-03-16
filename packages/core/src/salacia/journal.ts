// packages/core/src/salacia/journal.ts
// Evidence Journal — JSONL append-only log per task

import fs from "fs";
import path from "path";
import type { ExecutionContract } from "./contract";
import type { DriftReport } from "./drift";

export type JournalEvent =
  | { event: "contract"; data: ExecutionContract }
  | { event: "drift"; data: DriftReport }
  | { event: "gate"; data: { decision: string; score: number; reason?: string } }
  | { event: "fingerprints"; data: Record<string, string> }
  | { event: "blocked"; data: { reason: string; files: string[] } };

export class EvidenceJournal {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  private ensureDir(): void {
    fs.mkdirSync(this.basePath, { recursive: true });
  }

  private append(taskId: string, entry: JournalEvent): void {
    this.ensureDir();
    const filePath = path.resolve(this.basePath, `${taskId}.jsonl`);
    const line = JSON.stringify({ ts: Date.now(), ...entry }) + "\n";
    fs.appendFileSync(filePath, line);
  }

  logContract(taskId: string, contract: ExecutionContract): void {
    this.append(taskId, { event: "contract", data: contract });
  }

  logDrift(taskId: string, report: DriftReport): void {
    this.append(taskId, { event: "drift", data: report });
  }

  logGateResult(taskId: string, decision: string, score: number, reason?: string): void {
    this.append(taskId, { event: "gate", data: { decision, score, reason } });
  }

  logBlocked(taskId: string, reason: string, files: string[]): void {
    this.append(taskId, { event: "blocked", data: { reason, files } });
  }

  logFingerprints(taskId: string, fingerprints: Record<string, string>): void {
    this.append(taskId, { event: "fingerprints", data: fingerprints });
  }

  /**
   * Read all journal entries for a task.
   */
  read(taskId: string): JournalEvent[] {
    const filePath = path.resolve(this.basePath, `${taskId}.jsonl`);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return content.trim().split("\n").map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }
}
