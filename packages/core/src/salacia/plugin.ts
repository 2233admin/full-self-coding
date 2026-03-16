// packages/core/src/salacia/plugin.ts
// SalaciaPlugin — orchestrates Contract + Drift + Journal as 3 hooks into FSC

import type { Task } from "../task";
import type { WorkUnit, ExecutionResult } from "../execution/types";
import type { QualityGateHook } from "../codeCommitter";
import { generateContract, contractToPromptSuffix, type ExecutionContract } from "./contract";
import { detectDrift, isFatalDrift, exceedsThreshold, type DriftReport } from "./drift";
import { EvidenceJournal } from "./journal";
import path from "path";

export interface SalaciaConfig {
  enabled: boolean;
  driftThreshold?: number;       // default 30
  contractSource?: "heuristic" | "gitnexus";
  journalPath?: string;         // default ".fsc/journal"
}

const DEFAULT_CONFIG: SalaciaConfig = {
  enabled: false,
  driftThreshold: 30,
  contractSource: "heuristic",
};

export class SalaciaPlugin {
  private config: SalaciaConfig;
  private journal: EvidenceJournal;
  private contracts: Map<string, ExecutionContract> = new Map();

  constructor(config: Partial<SalaciaConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.journal = new EvidenceJournal(this.config.journalPath || ".fsc/journal");
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  // ─── Hook 1: Enrich WorkUnit before execution ───

  enrichWorkUnit(unit: WorkUnit, task: Task, repoPath?: string): WorkUnit {
    if (!this.config.enabled) return unit;

    const contract = generateContract(task, repoPath ? { repoPath } : undefined);
    this.contracts.set(task.ID, contract);
    this.journal.logContract(task.ID, contract);

    return {
      ...unit,
      taskPrompt: unit.taskPrompt + contractToPromptSuffix(contract),
      constraints: {
        ...unit.constraints,
        allowedPaths: contract.allowedPaths,
      },
    };
  }

  // ─── Hook 2: Post-execution drift check ───

  checkDrift(
    taskId: string,
    filesChanged: string[],
    worktreePath: string,
  ): { blocked: boolean; report: DriftReport | null } {
    if (!this.config.enabled) return { blocked: false, report: null };

    const contract = this.contracts.get(taskId);
    if (!contract) return { blocked: false, report: null };

    const report = detectDrift(contract, filesChanged, worktreePath);
    this.journal.logDrift(taskId, report);
    this.journal.logFingerprints(taskId, report.fingerprints);

    if (isFatalDrift(report)) {
      this.journal.logBlocked(taskId, "protected path violation", report.protectedViolations);
      return { blocked: true, report };
    }

    return { blocked: false, report };
  }

  // ─── Hook 3: Wrap QualityGateHook with contract-aware scoring ───

  wrapQualityGate(gate?: QualityGateHook): QualityGateHook | undefined {
    if (!this.config.enabled) return gate;

    const plugin = this;
    const threshold = this.config.driftThreshold ?? 30;

    return {
      async evaluate(input) {
        // Run original gate first (if exists)
        const baseResult = gate
          ? await gate.evaluate(input)
          : { allowed: true, score: 100, decision: "APPROVE" as const, reason: undefined };

        // Get drift report for this task
        const contract = plugin.contracts.get(input.taskId);
        if (!contract) return baseResult;

        const report = detectDrift(contract, input.touchedFiles, "");

        // Adjust score: subtract drift penalty
        const adjustedScore = Math.max(0, baseResult.score - report.score);
        const driftExceeded = exceedsThreshold(report, threshold);

        const decision = driftExceeded
          ? "REJECT" as const
          : baseResult.decision;
        const allowed = driftExceeded ? false : baseResult.allowed;
        const reason = driftExceeded
          ? `drift score ${report.score} exceeds threshold ${threshold} (out-of-scope: ${report.outOfScopeFiles.join(", ")})`
          : baseResult.reason;

        plugin.journal.logGateResult(input.taskId, decision, adjustedScore, reason);

        return { allowed, score: adjustedScore, decision, reason };
      },
    };
  }

  /**
   * Get contract for a task (for experiment metrics).
   */
  getContract(taskId: string): ExecutionContract | undefined {
    return this.contracts.get(taskId);
  }
}
