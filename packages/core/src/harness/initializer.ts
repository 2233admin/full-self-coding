/**
 * Harness Initializer Agent
 *
 * 分析项目 → 生成标准化 feature list + progress.txt
 * 在 host 机运行，直接 fetch Anthropic Messages API，不走 Docker。
 */

import { trimJSONSingleObject } from "../utils/trimJSON";

// ─── 类型 ───

export interface Feature {
  id: string;                                              // e.g. "feat-001"
  title: string;
  description: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "done" | "failed";
  estimatedComplexity: "simple" | "medium" | "complex";
}

export interface Progress {
  projectName: string;
  initAt: string;                                         // ISO 8601
  lastUpdatedAt: string;
  features: Feature[];
  completedCount: number;
  totalCount: number;
}

type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

// ─── 内部 helpers ───

function countCompleted(features: Feature[]): number {
  return features.filter(f => f.status === "done").length;
}

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
      max_tokens: 4096,
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

function buildAnalyzerPrompt(context: string): string {
  return `You are a senior software architect analyzing a codebase to generate an actionable feature improvement list.

Analyze the provided project context and output a JSON object with the following structure:

{
  "projectName": "<inferred project name>",
  "features": [
    {
      "id": "feat-001",
      "title": "<short imperative title>",
      "description": "<1-2 sentences: what to implement and why>",
      "priority": "high|medium|low",
      "status": "pending",
      "estimatedComplexity": "simple|medium|complex"
    }
  ]
}

Rules:
- Generate 5-15 meaningful, concrete features based on actual gaps in the code
- Order by priority descending (high first)
- IDs are zero-padded sequential: feat-001, feat-002, ...
- Do NOT wrap in markdown fences — return raw JSON only
- status must always be "pending" for all generated features`;
}

// ─── 公开 API ───

/**
 * 读取 repoPath 下的 README/AGENTS.md/package.json，调用 Claude 生成 Progress。
 *
 * @param repoPath  本地仓库根目录
 * @param apiKey    Anthropic API key
 * @param baseUrl   可选自定义 base URL（中转站）
 * @param config    可选 harness 配置子集。
 *                  - `progressDir`       — progress.txt 和锁文件的保存目录，默认 './'
 *                  - `maxParallelAgents` — 并行 agent 数量，>1 时调用方应启用文件锁，默认 1
 *
 * 注意：analyzeProject 只生成 Progress 对象，不写文件。
 * 调用方应用 saveProgress(progress, path.join(config.progressDir, 'progress.txt')) 保存。
 */
export async function analyzeProject(
  repoPath: string,
  apiKey: string,
  baseUrl?: string,
  config?: Pick<import("../config").Config, "progressDir" | "maxParallelAgents">,
): Promise<Result<Progress>> {
  // progressDir 供调用方确定 progress.txt 保存位置，analyzeProject 本身不写文件。
  void config; // used by caller: saveProgress(progress, path.join(config?.progressDir ?? './', 'progress.txt'))

  const fs = await import("fs");
  const path = await import("path");

  const candidates = ["AGENTS.md", "README.md", "package.json", "Cargo.toml", "pyproject.toml"];
  const chunks: string[] = [];

  for (const name of candidates) {
    const full = path.join(repoPath, name);
    if (fs.existsSync(full)) {
      const content = fs.readFileSync(full, "utf8").slice(0, 4000);
      chunks.push(`### ${name}\n${content}`);
    }
  }

  if (chunks.length === 0) {
    return { ok: false, error: `No project files found in ${repoPath}` };
  }

  const context = chunks.join("\n\n");
  const systemPrompt = buildAnalyzerPrompt(context);
  const userMessage = `Project context:\n\n${context}\n\nGenerate the feature list JSON now.`;

  const llmResult = await callClaude(apiKey, systemPrompt, userMessage, baseUrl);
  if (!llmResult.ok) return llmResult;

  const raw = trimJSONSingleObject(llmResult.value);
  if (!raw) {
    return { ok: false, error: `LLM returned no parseable JSON. Raw: ${llmResult.value.slice(0, 200)}` };
  }

  let parsed: { projectName: string; features: Feature[] };
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `JSON.parse failed: ${e}` };
  }

  const now = new Date().toISOString();
  const progress: Progress = {
    projectName: parsed.projectName ?? "unknown",
    initAt: now,
    lastUpdatedAt: now,
    features: parsed.features ?? [],
    completedCount: 0,
    totalCount: parsed.features?.length ?? 0,
  };

  return { ok: true, value: progress };
}

/** 从 progress.txt 读取 Progress（JSON 格式）。 */
export async function loadProgress(progressPath: string): Promise<Result<Progress>> {
  const fs = await import("fs");
  if (!fs.existsSync(progressPath)) {
    return { ok: false, error: `progress file not found: ${progressPath}` };
  }
  try {
    const raw = fs.readFileSync(progressPath, "utf8");
    const progress: Progress = JSON.parse(raw);
    progress.completedCount = countCompleted(progress.features);
    progress.totalCount = progress.features.length;
    return { ok: true, value: progress };
  } catch (e) {
    return { ok: false, error: `Failed to parse progress file: ${e}` };
  }
}

/** 将 Progress 序列化写入 progress.txt。 */
export async function saveProgress(progress: Progress, progressPath: string): Promise<Result<void>> {
  const fs = await import("fs");
  const path = await import("path");
  try {
    progress.lastUpdatedAt = new Date().toISOString();
    progress.completedCount = countCompleted(progress.features);
    progress.totalCount = progress.features.length;
    fs.mkdirSync(path.dirname(progressPath), { recursive: true });
    fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2), "utf8");
    return { ok: true, value: undefined };
  } catch (e) {
    return { ok: false, error: `Failed to write progress: ${e}` };
  }
}

/** 返回下一个 pending feature，无则返回 null。 */
export function nextPendingFeature(progress: Progress): Feature | null {
  // 按 priority 权重排序: high=3, medium=2, low=1
  const weight: Record<Feature["priority"], number> = { high: 3, medium: 2, low: 1 };
  const pending = progress.features
    .filter(f => f.status === "pending")
    .sort((a, b) => weight[b.priority] - weight[a.priority]);
  return pending[0] ?? null;
}

/** 将某 feature 标记为 in_progress 并保存。 */
export async function markInProgress(
  progress: Progress,
  featureId: string,
  progressPath: string,
): Promise<Result<void>> {
  const feat = progress.features.find(f => f.id === featureId);
  if (!feat) return { ok: false, error: `Feature ${featureId} not found` };
  feat.status = "in_progress";
  return saveProgress(progress, progressPath);
}

const LOCK_TTL_MS = 30 * 60 * 1000;

interface LockFile {
  agentId: string;
  claimedAt: string;
}

/**
 * 尝试为 agentId 抢占某个 pending feature 的文件锁。
 * 锁文件写在 progress.txt 同目录下: {featureId}.lock
 * 若锁存在且未过期（<30min），返回 null（被其他 agent 持有）。
 * 成功则把 feature 标记为 in_progress，写锁文件，保存 progress，返回 feature。
 */
export async function claimFeature(
  progress: Progress,
  progressPath: string,
  agentId: string,
): Promise<Result<Feature | null>> {
  const fs = await import("fs");
  const path = await import("path");
  const progressDir = path.dirname(progressPath);

  const weight: Record<Feature["priority"], number> = { high: 3, medium: 2, low: 1 };
  const candidates = progress.features
    .filter(f => f.status === "pending")
    .sort((a, b) => weight[b.priority] - weight[a.priority]);

  for (const feature of candidates) {
    const lockPath = path.join(progressDir, `${feature.id}.lock`);

    if (fs.existsSync(lockPath)) {
      try {
        const lock: LockFile = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        const age = Date.now() - new Date(lock.claimedAt).getTime();
        if (age < LOCK_TTL_MS) continue;
      } catch {
        // 锁文件损坏，视为过期，继续抢占
      }
    }

    try {
      const lock: LockFile = { agentId, claimedAt: new Date().toISOString() };
      fs.writeFileSync(lockPath, JSON.stringify(lock), "utf8");
    } catch (e) {
      return { ok: false, error: `Failed to write lock for ${feature.id}: ${e}` };
    }

    feature.status = "in_progress";
    const saved = await saveProgress(progress, progressPath);
    if (!saved.ok) return saved;

    return { ok: true, value: feature };
  }

  return { ok: true, value: null };
}

/**
 * 删除 featureId 对应的锁文件。
 */
export async function releaseLock(featureId: string, progressDir: string): Promise<Result<void>> {
  const fs = await import("fs");
  const path = await import("path");
  const lockPath = path.join(progressDir, `${featureId}.lock`);
  try {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    return { ok: true, value: undefined };
  } catch (e) {
    return { ok: false, error: `Failed to release lock for ${featureId}: ${e}` };
  }
}

/** 将某 feature 标记为 done/failed 并保存。 */
export async function markFeatureDone(
  progress: Progress,
  featureId: string,
  passed: boolean,
  progressPath: string,
): Promise<Result<void>> {
  const feat = progress.features.find(f => f.id === featureId);
  if (!feat) return { ok: false, error: `Feature ${featureId} not found` };
  feat.status = passed ? "done" : "failed";
  return saveProgress(progress, progressPath);
}
