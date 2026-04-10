/**
 * FSC Harness — Anthropic best-practice agent loop
 *
 * 导出三个角色:
 *   Initializer — 分析项目，生成 progress.txt + feature list
 *   Evaluator   — 独立严格评估 coding agent 输出
 *
 * 典型用法:
 *
 *   import { analyzeProject, nextPendingFeature, evaluate } from '@full-self-coding/core/harness';
 *
 *   const progress = await analyzeProject(repoPath, apiKey);
 *   const feature  = nextPendingFeature(progress);
 *   // ... run coding agent ...
 *   const evalResult = await evaluate(feature, diff, testOutput, apiKey);
 */

// Initializer
export type { Feature, Progress } from "./initializer";
export {
  analyzeProject,
  loadProgress,
  saveProgress,
  nextPendingFeature,
  markInProgress,
  markFeatureDone,
} from "./initializer";

// Evaluator
export type { EvalResult, DiyAdvisorConfig, BenchmarkResult, PassKResult } from "./evaluator";
export { evaluate, evaluateBatch, evaluateWithAdvisor, advisorBenchmark } from "./evaluator";
