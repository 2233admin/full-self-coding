#!/usr/bin/env bun
/**
 * bench-advisor — DIY advisor 三路对比 benchmark runner
 *
 * 用法:
 *   bun run script/bench-advisor.ts --diff <file> --feature <json>
 *
 * 环境变量:
 *   MINICLAW_URL     — MiniClaw 地址 (默认 http://127.0.0.1:18795)
 *   EXECUTOR_MODEL   — executor 模型 (默认 volcengine/doubao-seed-2.0-code)
 *   ADVISOR_MODEL    — advisor 模型  (默认 kimi/kimi-k2.5)
 *   CLAUDE_API_KEY   — 可选, 有则跑 Claude solo 作对照
 *   CLAUDE_BASE_URL  — 可选, Claude API base
 */

import { advisorBenchmark } from "../packages/core/src/harness/evaluator";
import type { DiyAdvisorConfig } from "../packages/core/src/harness/evaluator";
import type { Feature } from "../packages/core/src/harness/initializer";
import { readFileSync } from "fs";

// ─── CLI args ───
const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const diffFile    = flag("diff");
const featureFile = flag("feature");
const testFile    = flag("test");

if (!diffFile || !featureFile) {
  console.error("Usage: bun run script/bench-advisor.ts --diff <file> --feature <json> [--test <file>]");
  process.exit(1);
}

const commitDiff  = readFileSync(diffFile, "utf-8");
const feature     = JSON.parse(readFileSync(featureFile, "utf-8")) as Feature;
const testOutput  = testFile ? readFileSync(testFile, "utf-8") : "";

// ─── Config ───
const config: DiyAdvisorConfig = {
  executorModel:  Bun.env.EXECUTOR_MODEL  ?? "volcengine/doubao-seed-2.0-code",
  advisorModel:   Bun.env.ADVISOR_MODEL   ?? "kimi/kimi-k2.5",
  miniClawUrl:    Bun.env.MINICLAW_URL    ?? "http://127.0.0.1:18795",
  maxUses:        3,
  scoreThreshold: 70,
};

console.log(`[bench] executor=${config.executorModel} advisor=${config.advisorModel}`);
console.log(`[bench] miniclaw=${config.miniClawUrl}`);
console.log(`[bench] feature="${feature.title}"`);
console.log("─".repeat(60));

// ─── Run ───
const result = await advisorBenchmark(
  feature,
  commitDiff,
  testOutput,
  config,
  Bun.env.CLAUDE_API_KEY,
  Bun.env.CLAUDE_BASE_URL,
);

if (!result.ok) {
  console.error(`[bench] ERROR: ${result.error}`);
  process.exit(1);
}

const { executorSolo, withAdvisor, claudeSolo, advisorCallsUsed, costSavingNote } = result.value;

// ─── Report ───
console.log("\n=== BENCHMARK RESULTS ===\n");

console.log("[ Executor Solo ]");
console.log(`  score:  ${executorSolo.score}`);
console.log(`  passed: ${executorSolo.passed}`);
if (executorSolo.issues.length) executorSolo.issues.forEach(i => console.log(`  - ${i}`));

console.log("\n[ Executor + Advisor ]");
console.log(`  score:  ${withAdvisor.score}`);
console.log(`  passed: ${withAdvisor.passed}`);
console.log(`  advisor calls: ${advisorCallsUsed}`);
if (withAdvisor.issues.length) withAdvisor.issues.forEach(i => console.log(`  - ${i}`));

if (claudeSolo) {
  console.log("\n[ Claude Solo ]");
  console.log(`  score:  ${claudeSolo.score}`);
  console.log(`  passed: ${claudeSolo.passed}`);
  if (claudeSolo.issues.length) claudeSolo.issues.forEach(i => console.log(`  - ${i}`));
}

console.log(`\n[cost] ${costSavingNote}`);

const delta = withAdvisor.score - executorSolo.score;
console.log(`[delta] executor→advisor: ${delta >= 0 ? "+" : ""}${delta} pts`);
if (claudeSolo) {
  const gap = claudeSolo.score - withAdvisor.score;
  console.log(`[delta] advisor→claude:   ${gap >= 0 ? "+" : ""}${gap} pts`);
}
