/**
 * FSC Model Router v1.0 — 按任务特征自动选择最优 Agent 后端
 *
 * 借鉴:
 * - Claude Octopus: 贝叶斯信誉评分 + 角色分类
 * - myclaude: 静态角色映射 + 信号路由
 *
 * 路由策略:
 * - 分析/架构类任务 → Claude (深度推理)
 * - 批量代码生成 → Codex (速度+成本)
 * - 前端/UI 任务 → Gemini (广度+多模态)
 * - 低风险常规任务 → 按成本最优选择
 * - 高风险任务 → 多模型并行验证 (返回数组)
 */

import { SWEAgentType } from './config';
import type { Config } from './config';
import type { Task } from './task';

/** 任务分类 */
export type TaskCategory =
  | 'analysis'      // 代码分析、架构设计
  | 'implementation' // 代码实现、bug修复
  | 'frontend'      // UI/UX、样式、组件
  | 'testing'       // 测试编写、修复
  | 'refactoring'   // 重构、优化
  | 'documentation' // 文档、注释
  | 'unknown';

/** 路由结果 */
export interface RouteResult {
  /** 主 Agent */
  primary: SWEAgentType;
  /** 需要交叉验证时的备选 Agent（高风险任务） */
  crossVerify?: SWEAgentType[];
  /** 路由原因 */
  reason: string;
  /** 分类 */
  category: TaskCategory;
}

/** 分类关键词映射 */
const CATEGORY_PATTERNS: Record<TaskCategory, RegExp> = {
  analysis: /architect|design|analyz|review|assess|evaluat|investigat|refactor.*plan|system.*design/i,
  implementation: /implement|build|create|add|fix|bug|feature|develop|code|write.*function|endpoint/i,
  frontend: /ui|ux|component|style|css|layout|page|view|render|frontend|react|vue|html|svg/i,
  testing: /test|spec|coverage|assert|mock|stub|e2e|integration.*test|unit.*test/i,
  refactoring: /refactor|clean|simplif|extract|reorganiz|restructur|dedup|consolidat/i,
  documentation: /doc|readme|comment|changelog|guide|tutorial|api.*doc/i,
  unknown: /./,
};

/** 分类 → 默认 Agent 映射 (premium tier) */
const CATEGORY_AGENT_MAP: Record<TaskCategory, SWEAgentType> = {
  analysis: SWEAgentType.CLAUDE_CODE,
  implementation: SWEAgentType.CODEX,
  frontend: SWEAgentType.GEMINI_CLI,
  testing: SWEAgentType.CODEX,
  refactoring: SWEAgentType.CLAUDE_CODE,
  documentation: SWEAgentType.GEMINI_CLI,
  unknown: SWEAgentType.CLAUDE_CODE,
};

/**
 * Cost-tier routing: 按任务复杂度选最便宜的能干的agent
 *
 * premium: 架构/高风险/复杂分析 → claude, codex
 * budget:  标准实现/前端 → gemini, aider (via FreeClaw)
 * free:    测试/文档/lint/简单任务 → opencode, ollama
 */
import type { CostTier, AgentType } from './execution/types';

export type CostTierStrategy = "minimize-cost" | "maximize-quality" | "balanced";

const TIER_AGENT_MAP: Record<CostTier, Record<TaskCategory, AgentType>> = {
  premium: {
    analysis: "claude",
    implementation: "codex",
    frontend: "gemini",
    testing: "codex",
    refactoring: "claude",
    documentation: "gemini",
    unknown: "claude",
  },
  budget: {
    analysis: "gemini",
    implementation: "aider",
    frontend: "gemini",
    testing: "aider",
    refactoring: "aider",
    documentation: "aider",
    unknown: "aider",
  },
  free: {
    analysis: "opencode",
    implementation: "opencode",
    frontend: "opencode",
    testing: "opencode",
    refactoring: "opencode",
    documentation: "opencode",
    unknown: "opencode",
  },
};

/**
 * Assess risk from task content when riskLevel is not explicitly set.
 * Signals: priority, keyword density, estimated scope.
 */
export function assessRisk(task: Task): 'low' | 'medium' | 'high' | 'critical' {
  const text = `${task.title} ${task.description}`.toLowerCase();
  let score = 0;

  // Priority signal: high priority tasks are likely higher risk
  if (task.priority >= 5) score += 3;
  else if (task.priority >= 3) score += 1;

  // Security/concurrency keywords in task description
  const highRiskPatterns = /auth|secur|password|token|session|encrypt|permission|rbac|sql|inject|exec\(|eval\(/i;
  const concurrencyPatterns = /concurren|parallel|race|deadlock|lock|mutex|atomic|thread|async.*shared/i;
  const architecturePatterns = /architect|migrat|schema.*change|breaking.*change|api.*contract|cross.*module/i;

  if (highRiskPatterns.test(text)) score += 2;
  if (concurrencyPatterns.test(text)) score += 2;
  if (architecturePatterns.test(text)) score += 2;

  // Scope signal: long descriptions suggest complex tasks
  if (text.length > 500) score += 1;
  if (text.length > 1000) score += 1;

  // Token estimate signal
  if (task.estimatedTokens && task.estimatedTokens > 50_000) score += 1;
  if (task.estimatedTokens && task.estimatedTokens > 100_000) score += 2;

  // Multi-dependency signal
  if (task.dependsOn && task.dependsOn.length >= 3) score += 1;

  if (score >= 6) return 'critical';
  if (score >= 4) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

/**
 * Route task by cost tier.
 * For "minimize-cost": use free for low-risk, budget for medium, premium only for critical.
 * For "maximize-quality": always premium.
 * For "balanced": free for testing/docs, budget for impl, premium for analysis/refactor.
 *
 * When task.riskLevel is not set, auto-assesses from task content (Think-Anywhere pattern:
 * spend compute budget where uncertainty is highest).
 */
export function routeTaskByTier(
  task: Task,
  strategy: CostTierStrategy = "minimize-cost",
): { agentType: AgentType; tier: CostTier; reason: string } {
  const category = classifyTask(task);
  const risk = task.riskLevel ?? assessRisk(task);

  let tier: CostTier;

  if (strategy === "maximize-quality") {
    tier = "premium";
  } else if (strategy === "minimize-cost") {
    // Only use premium for critical tasks
    if (risk === "critical") tier = "premium";
    else if (risk === "high") tier = "budget";
    else tier = "free";
  } else {
    // balanced: route by category nature
    if (category === "analysis" || category === "refactoring") tier = "premium";
    else if (category === "implementation" || category === "frontend") tier = "budget";
    else tier = "free"; // testing, documentation, unknown
  }

  const agentType = TIER_AGENT_MAP[tier][category];

  return {
    agentType,
    tier,
    reason: `strategy=${strategy}, category=${category}, risk=${risk} → tier=${tier} → ${agentType}`,
  };
}

/**
 * 对任务文本做分类
 */
export function classifyTask(task: Task): TaskCategory {
  const text = `${task.title} ${task.description}`;

  // 按优先级匹配（排除 unknown）
  const categories: TaskCategory[] = [
    'analysis', 'frontend', 'testing', 'documentation', 'refactoring', 'implementation',
  ];

  for (const cat of categories) {
    if (CATEGORY_PATTERNS[cat].test(text)) {
      return cat;
    }
  }

  return 'unknown';
}

/**
 * 检查某个 Agent 后端是否在 config 中有可用的 API key
 */
function isAgentAvailable(agent: SWEAgentType, config: Config): boolean {
  switch (agent) {
    case SWEAgentType.CLAUDE_CODE:
      return !config.anthropicAPIKeyExportNeeded || !!config.anthropicAPIKey;
    case SWEAgentType.GEMINI_CLI:
      return !config.googleGeminiAPIKeyExportNeeded || !!config.googleGeminiApiKey;
    case SWEAgentType.CODEX:
      return !config.openAICodexAPIKeyExportNeeded || !!config.openAICodexApiKey;
    case SWEAgentType.CURSOR:
      return !config.cursorAPIKeyExportNeeded || !!config.cursorAPIKey;
    default:
      return false;
  }
}

/**
 * 获取所有可用的 Agent 后端
 */
export function getAvailableAgents(config: Config): SWEAgentType[] {
  const all = [SWEAgentType.CLAUDE_CODE, SWEAgentType.CODEX, SWEAgentType.GEMINI_CLI, SWEAgentType.CURSOR];
  return all.filter(a => isAgentAvailable(a, config));
}

/**
 * 路由核心：根据任务特征选择最优 Agent
 *
 * 优先级:
 * 1. task.preferredAgent (用户/分析器显式指定)
 * 2. 高风险 → 多模型交叉验证
 * 3. 分类匹配
 * 4. fallback 到全局 config.agentType
 */
export function routeTask(task: Task, config: Config): RouteResult {
  const available = getAvailableAgents(config);
  const category = classifyTask(task);

  // 1. 用户显式指定
  if (task.preferredAgent) {
    const preferred = task.preferredAgent as SWEAgentType;
    if (available.includes(preferred)) {
      return {
        primary: preferred,
        reason: `explicit: task.preferredAgent=${preferred}`,
        category,
      };
    }
    // 指定的不可用，继续走自动路由
  }

  // 2. 高风险/critical → 多模型交叉验证
  if ((task.riskLevel === 'high' || task.riskLevel === 'critical') && available.length >= 2) {
    const primary = CATEGORY_AGENT_MAP[category];
    const crossVerify = available.filter(a => a !== primary).slice(0, 2);

    if (available.includes(primary)) {
      return {
        primary,
        crossVerify: crossVerify.length > 0 ? crossVerify : undefined,
        reason: `high-risk(${task.riskLevel}): primary=${primary}, cross-verify=${crossVerify.join(',')}`,
        category,
      };
    }
  }

  // 3. 按分类选择
  const mapped = CATEGORY_AGENT_MAP[category];
  if (available.includes(mapped)) {
    return {
      primary: mapped,
      reason: `category=${category} → ${mapped}`,
      category,
    };
  }

  // 4. Fallback: 全局配置
  return {
    primary: config.agentType,
    reason: `fallback to config.agentType=${config.agentType}`,
    category,
  };
}
