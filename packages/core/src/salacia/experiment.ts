// packages/core/src/salacia/experiment.ts
// A/B experiment framework — deterministic split + metrics collection

import { createHash } from "crypto";
import fs from "fs";
import path from "path";

export type ExperimentGroup = "control" | "salacia";

export interface ExperimentMetrics {
  taskId: string;
  group: ExperimentGroup;
  filesChanged: number;
  outOfScopeFiles: number;
  qualityScore: number;
  driftScore: number;
  success: boolean;
  durationMs: number;
  postMergeTestPass?: boolean;  // merge 后测试是否通过
}

export interface AggregateStats {
  count: number;
  avgFilesChanged: number;
  avgOutOfScope: number;
  avgQualityScore: number;
  avgDriftScore: number;
  successRate: number;
  avgDurationMs: number;
}

export interface ExperimentReport {
  control: AggregateStats;
  salacia: AggregateStats;
  delta: {
    filesChanged: number;
    outOfScope: number;
    qualityScore: number;
    driftScore: number;
    successRate: number;
    durationMs: number;
  };
  totalTasks: number;
  timestamp: number;
}

/**
 * Deterministic group assignment via hash.
 * Same taskId always maps to same group (stable across retries).
 */
export function assignGroup(taskId: string, splitRatio: number = 0.5): ExperimentGroup {
  const hash = createHash("md5").update(taskId).digest();
  const value = hash.readUInt16BE(0) % 100;
  return value < splitRatio * 100 ? "salacia" : "control";
}

function aggregate(metrics: ExperimentMetrics[]): AggregateStats {
  if (metrics.length === 0) {
    return { count: 0, avgFilesChanged: 0, avgOutOfScope: 0, avgQualityScore: 0, avgDriftScore: 0, successRate: 0, avgDurationMs: 0 };
  }
  const n = metrics.length;
  return {
    count: n,
    avgFilesChanged:  metrics.reduce((s, m) => s + m.filesChanged, 0) / n,
    avgOutOfScope:    metrics.reduce((s, m) => s + m.outOfScopeFiles, 0) / n,
    avgQualityScore:  metrics.reduce((s, m) => s + m.qualityScore, 0) / n,
    avgDriftScore:    metrics.reduce((s, m) => s + m.driftScore, 0) / n,
    successRate:      metrics.filter(m => m.success).length / n,
    avgDurationMs:    metrics.reduce((s, m) => s + m.durationMs, 0) / n,
  };
}

export class ABExperiment {
  private metrics: ExperimentMetrics[] = [];
  private splitRatio: number;

  constructor(splitRatio: number = 0.5) {
    this.splitRatio = splitRatio;
  }

  assignGroup(taskId: string): ExperimentGroup {
    return assignGroup(taskId, this.splitRatio);
  }

  record(metrics: ExperimentMetrics): void {
    this.metrics.push(metrics);
  }

  report(): ExperimentReport {
    const control = this.metrics.filter(m => m.group === "control");
    const salacia = this.metrics.filter(m => m.group === "salacia");
    const cStats = aggregate(control);
    const sStats = aggregate(salacia);

    return {
      control: cStats,
      salacia: sStats,
      delta: {
        filesChanged:  sStats.avgFilesChanged - cStats.avgFilesChanged,
        outOfScope:    sStats.avgOutOfScope - cStats.avgOutOfScope,
        qualityScore:  sStats.avgQualityScore - cStats.avgQualityScore,
        driftScore:    sStats.avgDriftScore - cStats.avgDriftScore,
        successRate:   sStats.successRate - cStats.successRate,
        durationMs:    sStats.avgDurationMs - cStats.avgDurationMs,
      },
      totalTasks: this.metrics.length,
      timestamp: Date.now(),
    };
  }

  /**
   * Write experiment results to disk.
   */
  save(outputDir: string): string {
    fs.mkdirSync(outputDir, { recursive: true });
    const filename = `experiment-${Date.now()}.json`;
    const filePath = path.resolve(outputDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(this.report(), null, 2));
    return filePath;
  }
}
