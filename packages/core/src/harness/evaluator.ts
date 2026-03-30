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

async function callClaude(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  baseUrl = "https://api.anthropic.com",
): Promise<Result<string>> {
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    return { ok: false, error: `Anthropic API ${res.status}: ${body}` };
  }

  const json = await res.json() as { content: Array<{ type: string; text: string }> };
  const text = json.content.find(c => c.type === "text")?.text ?? "";
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
