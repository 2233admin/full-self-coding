/**
 * Harness Evaluator Agent
 *
 * 独立严格评估 coding agent 的输出，防 self-praise-bias。
 * 评估视角: "假设这个实现是错的，找出所有问题。"
 *
 * 在 host 机运行，直接 fetch Anthropic Messages API，不走 Docker。
 */

import { trimJSONSingleObject } from "../utils/trimJSON";
import type { Feature } from "./initializer";

// ─── 类型 ───

export interface EvalResult {
  passed: boolean;
  score: number;       // 0-100
  issues: string[];    // 每条是具体问题描述
  suggestion: string;  // 一句话改进建议
  advisorCalls?: number; // DIY advisor 调用次数
}

export interface DiyAdvisorConfig {
  executorModel: string;   // e.g. "doubao-seed-2.0-code"
  advisorModel: string;    // e.g. "kimi-k2.5"
  proxyUrl: string;        // e.g. "http://127.0.0.1:18795" (MiniClaw) or any OpenAI-compat proxy
  apiFormat?: "anthropic-messages" | "openai"; // default "anthropic-messages"
  maxUses?: number;        // default 3
  scoreThreshold?: number; // call advisor if score < threshold (default 70)
}

export interface BenchmarkResult {
  executorSolo: EvalResult;
  withAdvisor: EvalResult;
  claudeSolo?: EvalResult;
  advisorCallsUsed: number;
  costSavingNote: string;
}

export interface PassKResult {
  passAtK: number;           // P(至少1次成功) = 1 - (1-p)^k
  passExpK: number;          // P(k次全部成功) = p^k
  sampleSize: number;        // k值
  individualResults: EvalResult[];
}

type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

// ─── 内部 helpers ───

// Direction 4: advisor usage tracker
interface AdvisorUsage { calls: number; inputTokens: number; outputTokens: number; }
function extractAdvisorUsage(json: any): AdvisorUsage | null {
  const u = json?.usage;
  if (!u?.advisor_input_tokens && !u?.advisor_output_tokens) return null;
  return {
    calls: u.advisor_calls ?? 1,
    inputTokens: u.advisor_input_tokens ?? 0,
    outputTokens: u.advisor_output_tokens ?? 0,
  };
}

// Direction 2: advisorModel param — set "claude-sonnet-4-6" for Haiku+Sonnet combo
async function callClaude(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  baseUrl = "https://api.anthropic.com",
  advisorModel?: string,
): Promise<Result<string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
  if (advisorModel) headers["anthropic-beta"] = "advisor-tool-2026-03-01";

  const body: Record<string, any> = {
    model: "claude-3-5-haiku-20241022",
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  };
  if (advisorModel) {
    body.tools = [{ type: "advisor_20260301", name: "advisor", model: advisorModel, max_uses: 3 }];
  }

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    return { ok: false, error: `Anthropic API ${res.status}: ${err}` };
  }

  const json = await res.json() as any;

  // Direction 4: log advisor usage if present
  const advisorUsage = extractAdvisorUsage(json);
  if (advisorUsage) {
    console.log(`[advisor] calls=${advisorUsage.calls} in=${advisorUsage.inputTokens} out=${advisorUsage.outputTokens}`);
  }

  const text = (json.content as Array<{ type: string; text: string }>).find(c => c.type === "text")?.text ?? "";
  return { ok: true, value: text };
}

function buildEvaluatorSystemPrompt(): string {
  return `You are a hostile code reviewer. Your job is to find every problem with the implementation.

Default assumption: THE IMPLEMENTATION IS WRONG. Prove it wrong or grudgingly accept it.

Scoring criteria (100 points total):
- Feature requirement coverage: 40 pts (does diff actually implement what was asked?)
- Test quality: 25 pts (do tests exist? do they test the right things? do they pass?)
- Code quality: 20 pts (readability, correctness, edge cases, error handling)
- No regressions: 15 pts (does testOutput show failures unrelated to this feature?)

Output a JSON object — no markdown fences, raw JSON only:
{
  "passed": <boolean — true only if score >= 70>,
  "score": <integer 0-100>,
  "issues": [
    "<concrete issue 1>",
    "<concrete issue 2>"
  ],
  "suggestion": "<single actionable sentence for next attempt>"
}

If issues list is empty and score >= 70, set passed: true.
Be specific. "tests are bad" is not an issue. "TestFoo does not assert the error case when input is nil" is an issue.`;
}

function buildEvaluatorUserMessage(
  feature: Feature,
  commitDiff: string,
  testOutput: string,
): string {
  const diffSnippet = commitDiff.slice(0, 6000);
  const testSnippet = testOutput.slice(0, 3000);

  return `## Feature Requirement
ID: ${feature.id}
Title: ${feature.title}
Description: ${feature.description}
Priority: ${feature.priority}
Complexity: ${feature.estimatedComplexity}

## Commit Diff (truncated to 6000 chars)
\`\`\`diff
${diffSnippet}
\`\`\`

## Test Output (truncated to 3000 chars)
\`\`\`
${testSnippet}
\`\`\`

Evaluate this implementation now. Remember: assume it's wrong until proven otherwise.`;
}

// ─── 公开 API ───

/**
 * 评估 coding agent 对某 feature 的实现。
 *
 * @param feature    被实现的 feature（来自 Initializer）
 * @param commitDiff `git diff HEAD~1..HEAD` 或类似的 diff 文本
 * @param testOutput 测试运行的 stdout/stderr
 * @param apiKey     Anthropic API key
 * @param baseUrl    可选自定义 base URL（中转站）
 */
export async function evaluate(
  feature: Feature,
  commitDiff: string,
  testOutput: string,
  apiKey: string,
  baseUrl?: string,
): Promise<Result<EvalResult>> {
  if (!commitDiff.trim()) {
    return {
      ok: true,
      value: {
        passed: false,
        score: 0,
        issues: ["No diff provided — coding agent produced no changes."],
        suggestion: "Ensure the coding agent commits its changes before evaluation.",
      },
    };
  }

  const systemPrompt = buildEvaluatorSystemPrompt();
  const userMessage = buildEvaluatorUserMessage(feature, commitDiff, testOutput);

  const llmResult = await callClaude(apiKey, systemPrompt, userMessage, baseUrl);
  if (!llmResult.ok) return llmResult;

  const raw = trimJSONSingleObject(llmResult.value);
  if (!raw) {
    return {
      ok: false,
      error: `Evaluator LLM returned no parseable JSON. Raw: ${llmResult.value.slice(0, 300)}`,
    };
  }

  let parsed: EvalResult;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `Evaluator JSON.parse failed: ${e}` };
  }

  // 规范化: 确保字段类型正确
  const result: EvalResult = {
    passed: Boolean(parsed.passed),
    score: Math.max(0, Math.min(100, Number(parsed.score) || 0)),
    issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
    suggestion: String(parsed.suggestion ?? ""),
  };

  // 强一致: score < 70 时强制 passed=false
  if (result.score < 70) result.passed = false;

  return { ok: true, value: result };
}

/**
 * 对同一 feature 并发跑 k 次评估，返回 pass@k 和 pass^k 指标。
 * - passExpK (pass^k): 生产场景，要求每次都过，p^k
 * - passAtK (pass@k): 实验场景，至少1次过，1-(1-p)^k
 */
export async function evaluatePassK(
  feature: Feature,
  commitDiff: string,
  testOutput: string,
  apiKey: string,
  k = 3,
  baseUrl?: string,
): Promise<Result<PassKResult>> {
  const runs = await Promise.all(
    Array.from({ length: k }, () => evaluate(feature, commitDiff, testOutput, apiKey, baseUrl)),
  );

  const failed = runs.find(r => !r.ok);
  if (failed && !failed.ok) return { ok: false, error: failed.error };

  const results = (runs as Array<{ ok: true; value: EvalResult }>).map(r => r.value);
  const passCount = results.filter(r => r.passed).length;
  const p = passCount / k;

  return {
    ok: true,
    value: {
      passAtK: 1 - Math.pow(1 - p, k),
      passExpK: Math.pow(p, k),
      sampleSize: k,
      individualResults: results,
    },
  };
}

/**
 * 批量评估多个 feature（并发执行）。
 * 返回 Map<featureId, Result<EvalResult>>。
 */
export async function evaluateBatch(
  items: Array<{ feature: Feature; commitDiff: string; testOutput: string }>,
  apiKey: string,
  baseUrl?: string,
): Promise<Map<string, Result<EvalResult>>> {
  const results = await Promise.all(
    items.map(async ({ feature, commitDiff, testOutput }) => {
      const result = await evaluate(feature, commitDiff, testOutput, apiKey, baseUrl);
      return [feature.id, result] as const;
    }),
  );
  return new Map(results);
}

// ─── DIY Advisor ───

// Generic LLM call — supports anthropic-messages and openai formats
async function callLLM(
  model: string,
  systemPrompt: string,
  userMessage: string,
  proxyUrl: string,
  apiFormat: "anthropic-messages" | "openai" = "anthropic-messages",
): Promise<Result<string>> {
  const base = proxyUrl.replace(/\/$/, "");

  let url: string;
  let headers: Record<string, string>;
  let bodyObj: unknown;

  if (apiFormat === "openai") {
    url = `${base}/v1/chat/completions`;
    headers = { "Content-Type": "application/json", "Authorization": "Bearer proxy-internal" };
    bodyObj = {
      model,
      max_tokens: 2048,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    };
  } else {
    url = `${base}/v1/messages`;
    headers = {
      "Content-Type": "application/json",
      "x-api-key": "proxy-internal",
      "anthropic-version": "2023-06-01",
    };
    bodyObj = {
      model,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    };
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(bodyObj),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    return { ok: false, error: `callLLM ${model} ${res.status}: ${await res.text()}` };
  }
  let json: any;
  try { json = await res.json(); } catch (e) {
    return { ok: false, error: `callLLM ${model} non-JSON response: ${e}` };
  }

  const text = apiFormat === "openai"
    ? (json.choices?.[0]?.message?.content ?? "")
    : (Array.isArray(json.content)
        ? (json.content as Array<{ type: string; text: string }>).find(c => c.type === "text")?.text ?? ""
        : "");

  return { ok: true, value: text };
}

function buildAdvisorSystemPrompt(): string {
  return `You are a meta-reviewer validating another evaluator's code assessment.
Your job: find flaws in the primary evaluator's reasoning. Be adversarial but fair.
If the primary evaluator was too harsh or too lenient, correct the score and issues list.
Output raw JSON only — same schema as the primary evaluator:
{"passed": bool, "score": int, "issues": [...], "suggestion": "..."}`;
}

function buildAdvisorUserMessage(originalContext: string, initialResult: EvalResult): string {
  return `## Original Evaluation Context
${originalContext}

## Primary Evaluator Assessment
Score: ${initialResult.score}/100
Passed: ${initialResult.passed}
Issues:
${initialResult.issues.map(i => `- ${i}`).join("\n")}
Suggestion: ${initialResult.suggestion}

Validate or correct this assessment. Output corrected JSON.`;
}

async function runAdvisorRound(
  initialResult: EvalResult,
  originalContext: string,
  config: DiyAdvisorConfig,
  usesLeft: number,
): Promise<{ result: EvalResult; callsUsed: number }> {
  const threshold = config.scoreThreshold ?? 70;
  // Only fire advisor if score is in the ambiguous zone
  if (initialResult.score >= threshold || usesLeft <= 0) {
    return { result: initialResult, callsUsed: 0 };
  }

  const llmResult = await callLLM(
    config.advisorModel,
    buildAdvisorSystemPrompt(),
    buildAdvisorUserMessage(originalContext, initialResult),
    config.proxyUrl,
    config.apiFormat,
  );
  if (!llmResult.ok) {
    console.warn(`[diy-advisor] advisor call failed: ${llmResult.error}`);
    return { result: initialResult, callsUsed: 1 };
  }

  const raw = trimJSONSingleObject(llmResult.value);
  if (!raw) return { result: initialResult, callsUsed: 1 };

  let corrected: EvalResult;
  try { corrected = JSON.parse(raw); } catch { return { result: initialResult, callsUsed: 1 }; }

  const merged: EvalResult = {
    passed: Boolean(corrected.passed),
    score: Math.max(0, Math.min(100, Number(corrected.score) || initialResult.score)),
    issues: Array.isArray(corrected.issues) ? corrected.issues.map(String) : initialResult.issues,
    suggestion: String(corrected.suggestion || initialResult.suggestion),
    advisorCalls: (initialResult.advisorCalls ?? 0) + 1,
  };
  if (merged.score < 70) merged.passed = false;

  // Recurse if still ambiguous — always review the original executor result (not advisor's own output)
  // to avoid telephone-game drift where advisor reviews its own previous answer
  if (merged.score < threshold && usesLeft - 1 > 0) {
    const { result: final, callsUsed: extra } = await runAdvisorRound(
      initialResult, originalContext, config, usesLeft - 1,
    );
    // Take whichever round produced higher score
    const best = final.score >= merged.score ? final : merged;
    best.advisorCalls = (merged.advisorCalls ?? 1) + extra;
    return { result: best, callsUsed: 1 + extra };
  }
  return { result: merged, callsUsed: 1 };
}

/**
 * 用 DIY advisor 策略评估。
 * executor (doubao) 先跑，score < threshold 时 advisor (kimi) 介入修正。
 */
export async function evaluateWithAdvisor(
  feature: Feature,
  commitDiff: string,
  testOutput: string,
  config: DiyAdvisorConfig,
): Promise<Result<EvalResult>> {
  if (!commitDiff.trim()) {
    return {
      ok: true,
      value: { passed: false, score: 0, issues: ["No diff provided."], suggestion: "Commit changes first.", advisorCalls: 0 },
    };
  }

  const systemPrompt = buildEvaluatorSystemPrompt();
  const userMessage = buildEvaluatorUserMessage(feature, commitDiff, testOutput);

  // Round 1: executor
  const execResult = await callLLM(config.executorModel, systemPrompt, userMessage, config.proxyUrl, config.apiFormat);
  if (!execResult.ok) return { ok: false, error: execResult.error };

  const raw = trimJSONSingleObject(execResult.value);
  if (!raw) return { ok: false, error: `Executor returned no JSON. Raw: ${execResult.value.slice(0, 300)}` };

  let initial: EvalResult;
  try { initial = JSON.parse(raw); } catch (e) { return { ok: false, error: `Executor JSON parse failed: ${e}` }; }

  initial = {
    passed: Boolean(initial.passed),
    score: Math.max(0, Math.min(100, Number(initial.score) || 0)),
    issues: Array.isArray(initial.issues) ? initial.issues.map(String) : [],
    suggestion: String(initial.suggestion ?? ""),
    advisorCalls: 0,
  };
  if (initial.score < 70) initial.passed = false;

  console.log(`[diy-advisor] executor=${config.executorModel} score=${initial.score}`);

  // Round 2+: advisor if needed
  const { result, callsUsed } = await runAdvisorRound(
    initial, userMessage, config, config.maxUses ?? 3,
  );
  if (callsUsed > 0) {
    console.log(`[diy-advisor] advisor=${config.advisorModel} calls=${callsUsed} final_score=${result.score}`);
  }

  return { ok: true, value: result };
}

/**
 * 三路对比 benchmark: executor solo / advisor combo / (可选) claude solo
 *
 * 关键设计: executor 只跑一次，solo 和 advisor 两路 fork 同一份 executor 结果。
 * 消除因 executor 随机性导致的 "solo vs +advisor" 分数差来自模型采样而非 advisor 贡献。
 */
export async function advisorBenchmark(
  feature: Feature,
  commitDiff: string,
  testOutput: string,
  config: DiyAdvisorConfig,
  claudeApiKey?: string,
  claudeBaseUrl?: string,
): Promise<Result<BenchmarkResult>> {
  const systemPrompt = buildEvaluatorSystemPrompt();
  const userMessage = buildEvaluatorUserMessage(feature, commitDiff, testOutput);

  // Executor + optional Claude run concurrently
  const [execLLMResult, claudeResult] = await Promise.all([
    callLLM(config.executorModel, systemPrompt, userMessage, config.proxyUrl, config.apiFormat),
    claudeApiKey
      ? evaluate(feature, commitDiff, testOutput, claudeApiKey, claudeBaseUrl)
      : Promise.resolve(null),
  ]);

  if (!execLLMResult.ok) return { ok: false, error: `executor: ${execLLMResult.error}` };

  const raw = trimJSONSingleObject(execLLMResult.value);
  if (!raw) return { ok: false, error: `Executor returned no JSON. Raw: ${execLLMResult.value.slice(0, 300)}` };

  let executorResult: EvalResult;
  try { executorResult = JSON.parse(raw); } catch (e) {
    return { ok: false, error: `Executor JSON parse failed: ${e}` };
  }
  executorResult = {
    passed: Boolean(executorResult.passed),
    score: Math.max(0, Math.min(100, Number(executorResult.score) || 0)),
    issues: Array.isArray(executorResult.issues) ? executorResult.issues.map(String) : [],
    suggestion: String(executorResult.suggestion ?? ""),
    advisorCalls: 0,
  };
  if (executorResult.score < 70) executorResult.passed = false;

  console.log(`[bench] executor=${config.executorModel} score=${executorResult.score}`);

  // Fork: advisor arm uses the SAME executor result — isolates advisor's actual contribution
  const { result: withAdvisor, callsUsed } = await runAdvisorRound(
    executorResult, userMessage, config, config.maxUses ?? 3,
  );

  const scoreDelta = withAdvisor.score - executorResult.score;
  return {
    ok: true,
    value: {
      executorSolo: executorResult,
      withAdvisor,
      claudeSolo: claudeResult?.ok ? claudeResult.value : undefined,
      advisorCallsUsed: callsUsed,
      costSavingNote: callsUsed === 0
        ? "Advisor not triggered (executor confident)"
        : `Advisor fired ${callsUsed}x, score delta: ${scoreDelta >= 0 ? "+" : ""}${scoreDelta}`,
    },
  };
}
