#!/usr/bin/env bun
/**
 * bench-advisor — DIY advisor 三路对比 benchmark runner
 *
 * 用法:
 *   bun run script/bench-advisor.ts --diff <file> --feature <json> [--test <file>]
 *
 * 环境变量 (executor):
 *   EXECUTOR_MODEL      — 模型名 (默认 doubao-seed-2.0-code)
 *   EXECUTOR_BASE_URL   — API base (默认 https://ark.cn-beijing.volces.com/api/v3)
 *   EXECUTOR_API_KEY    — API key (必填)
 *   EXECUTOR_FORMAT     — anthropic-messages | openai (默认 openai)
 *
 * 环境变量 (advisor):
 *   ADVISOR_MODEL       — 模型名 (默认 moonshot-v1-8k)
 *   ADVISOR_BASE_URL    — API base (默认 https://api.moonshot.cn)
 *   ADVISOR_API_KEY     — API key (必填)
 *   ADVISOR_FORMAT      — anthropic-messages | openai (默认 openai)
 *
 * 可选 Claude solo 对照:
 *   CLAUDE_API_KEY      — 有则跑 Claude solo
 *   CLAUDE_BASE_URL     — Claude API base
 */

import { advisorBenchmark } from "../packages/core/src/harness/evaluator";
import type { DiyAdvisorConfig, LLMEndpoint } from "../packages/core/src/harness/evaluator";
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

if (!Bun.env.EXECUTOR_API_KEY || !Bun.env.ADVISOR_API_KEY) {
  console.error("Missing required env: EXECUTOR_API_KEY and ADVISOR_API_KEY must be set");
  process.exit(1);
}

const commitDiff = readFileSync(diffFile, "utf-8");
const feature    = JSON.parse(readFileSync(featureFile, "utf-8")) as Feature;
const testOutput = testFile ? readFileSync(testFile, "utf-8") : "";

// ─── Config ───
const executor: LLMEndpoint = {
  model:     Bun.env.EXECUTOR_MODEL    ?? "doubao-seed-2.0-code",
  baseUrl:   Bun.env.EXECUTOR_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3",
  apiKey:    Bun.env.EXECUTOR_API_KEY,
  apiFormat: (Bun.env.EXECUTOR_FORMAT  ?? "openai") as "anthropic-messages" | "openai",
};

const advisor: LLMEndpoint = {
  model:     Bun.env.ADVISOR_MODEL    ?? "moonshot-v1-8k",
  baseUrl:   Bun.env.ADVISOR_BASE_URL ?? "https://api.moonshot.cn",
  apiKey:    Bun.env.ADVISOR_API_KEY,
  apiFormat: (Bun.env.ADVISOR_FORMAT  ?? "openai") as "anthropic-messages" | "openai",
};

const config: DiyAdvisorConfig = {
  executor,
  advisor,
  maxUses:        3,
  scoreThreshold: 70,
};

console.log(`[bench] executor=${executor.model} @ ${executor.baseUrl}`);
console.log(`[bench] advisor=${advisor.model} @ ${advisor.baseUrl}`);
console.log(`[bench] feature="${feature.title}"`);
console.log("-".repeat(60));

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
console.log(`[delta] executor->advisor: ${delta >= 0 ? "+" : ""}${delta} pts`);
if (claudeSolo) {
  const gap = claudeSolo.score - withAdvisor.score;
  console.log(`[delta] advisor->claude:   ${gap >= 0 ? "+" : ""}${gap} pts`);
}
