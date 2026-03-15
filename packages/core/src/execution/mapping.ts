// packages/core/src/execution/mapping.ts
import type { Task, TaskResult } from "../task";
import { TaskStatus } from "../task";
import type { ExecutionResult, WorkUnit, AgentConfig, AgentType, CostTier } from "./types";
import { AGENT_BUILDERS, AGENT_CATALOG } from "./types";
import type { Config } from "../config";
import { routeTask, routeTaskByTier, type CostTierStrategy } from "../modelRouter";
import { gitExec } from "./gitExec";

export function toTaskResult(er: ExecutionResult, originalTask: Task): TaskResult {
  const statusMap: Record<ExecutionResult["status"], TaskStatus> = {
    success: TaskStatus.SUCCESS,
    failure: TaskStatus.FAILURE,
    timeout: TaskStatus.FAILURE,
    error: TaskStatus.FAILURE,
  };

  return {
    ...originalTask,
    status: statusMap[er.status],
    report: er.error
      ? `[${er.error.category}] ${er.error.message}`
      : "Completed",
    completedAt: er.completedAt,
    gitDiff: undefined,
    commitHash: er.commitHash ?? undefined,
    worktreeBranch: er.branch,
  };
}

export function buildTaskPrompt(task: Task): string {
  let prompt = `# Task: ${task.title}\n\n${task.description}`;
  prompt += `\n\n## Constraints`;
  prompt += `\n- Only modify files relevant to this task`;
  prompt += `\n- Commit your changes when done`;
  prompt += `\n- Write tests if applicable`;
  return prompt;
}

export function toWorkUnit(
  task: Task,
  config: Config,
  repoPath: string,
): WorkUnit {
  const route = routeTask(task, config);
  const agentType = (route.primary || config.agentType || "claude") as AgentConfig["type"];

  return {
    id: task.ID,
    repoPath,
    baseBranch: getCurrentBranch(repoPath),
    taskPrompt: buildTaskPrompt(task),
    agentConfig: getAgentConfig(agentType, config),
    constraints: {
      timeoutMs: task.maxExecutionTimeMs ?? 300_000,
      maxTokens: task.estimatedTokens,
    },
    context: {
      memorixUri: (config as any).memorix?.uri,
      taskDeps: task.dependsOn,
    },
  };
}

function getCurrentBranch(repoPath: string): string {
  const result = gitExec(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
  return result.stdout.trim() || "main";
}

function getAgentConfig(type: AgentConfig["type"], config: Config): AgentConfig {
  const catalog = AGENT_CATALOG[type as string] ?? AGENT_CATALOG.opencode;
  const command = type === "custom"
    ? (config as any).customAgentCommand
    : catalog.command;
  const buildArgs = AGENT_BUILDERS[type as string] ?? AGENT_BUILDERS.claude;

  return {
    type,
    command,
    buildArgs,
    costTier: catalog.costTier,
    memoryMB: catalog.memoryMB,
  };
}

/**
 * Convert Task to WorkUnit using cost-tier routing.
 * Use this for bulk/free execution (100-1000 agents).
 */
export function toWorkUnitByTier(
  task: Task,
  repoPath: string,
  strategy: CostTierStrategy = "minimize-cost",
  freeclawBase?: string,
): WorkUnit {
  const { agentType, tier } = routeTaskByTier(task, strategy);
  const catalog = AGENT_CATALOG[agentType] ?? AGENT_CATALOG.opencode;

  // For aider with FreeClaw, inject API base
  const env: Record<string, string> = {};
  if (agentType === "aider" && freeclawBase) {
    env.OPENAI_API_BASE = freeclawBase;
  }

  return {
    id: task.ID,
    repoPath,
    baseBranch: getCurrentBranch(repoPath),
    taskPrompt: buildTaskPrompt(task),
    agentConfig: {
      type: agentType,
      command: catalog.command,
      buildArgs: AGENT_BUILDERS[agentType] ?? AGENT_BUILDERS.opencode,
      env,
      costTier: catalog.costTier as CostTier,
      memoryMB: catalog.memoryMB,
    },
    constraints: {
      timeoutMs: task.maxExecutionTimeMs ?? 300_000,
      maxTokens: task.estimatedTokens,
    },
  };
}

// ─── Result Validator ───

const VALID_STATUSES = new Set(["success", "failure", "timeout", "error"]);
const REQUIRED_FIELDS = ["workUnitId", "status", "branch", "worktreePath", "startedAt", "completedAt"];

export function validateResult(data: unknown): ExecutionResult {
  if (!data || typeof data !== "object") {
    throw new Error("result.json: not an object");
  }

  const r = data as Record<string, unknown>;

  for (const key of REQUIRED_FIELDS) {
    if (!(key in r)) {
      throw new Error(`result.json: missing required field '${key}'`);
    }
  }

  if (!VALID_STATUSES.has(r.status as string)) {
    throw new Error(`result.json: invalid status '${r.status}'`);
  }

  if (r.commitHash !== null && r.commitHash !== undefined && typeof r.commitHash !== "string") {
    throw new Error(`result.json: commitHash must be string or null`);
  }

  return data as ExecutionResult;
}
