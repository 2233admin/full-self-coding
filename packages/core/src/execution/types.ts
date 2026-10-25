// packages/core/src/execution/types.ts

export type AgentType =
  | "claude" | "codex" | "gemini"           // Premium ($$$)
  | "aider"                                  // Flexible (model-dependent)
  | "opencode" | "openclaw"                  // Free (国产模型)
  | "ollama"                                 // Free (本地)
  | "custom";

export type CostTier = "premium" | "budget" | "free";

export interface AgentConfig {
  type: AgentType;
  command: string;
  buildArgs(prompt: string, cwd: string): string[];
  env?: Record<string, string>;
  costTier: CostTier;
  /** Estimated memory per process in MB (for resource-aware scheduling) */
  memoryMB: number;
}

export interface WorkUnit {
  id: string;
  repoPath: string;
  baseBranch: string;
  taskPrompt: string;
  agentConfig: AgentConfig;
  constraints: {
    timeoutMs: number;
    maxTokens?: number;
    allowedPaths?: string[];
  };
  context?: {
    memorixUri?: string;
    codeRAGContext?: string;
    taskDeps?: string[];
  };
}

export interface ExecutionResult {
  workUnitId: string;
  status: "success" | "failure" | "timeout" | "error";
  commitHash: string | null;
  branch: string;
  worktreePath: string;
  startedAt: number;
  completedAt: number;
  agent: { type: string; version?: string };
  filesChanged: string[];
  logs: string[];
  error?: {
    message: string;
    category: "RESOURCE" | "TRANSIENT" | "PERMANENT" | "QUALITY" | "MERGE_CONFLICT" | "UNKNOWN";
  };
}

export type ExecutionStatus = "pending" | "running" | "waiting" | "completed" | "failed" | "aborted";

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
  taskId: string;
}

// Pre-built agent arg builders
/**
 * Agents must not inherit the operator's personal Claude Code setup: user-level hooks (a Stop hook
 * can block or slow a headless run) and the user's global CLAUDE.md both apply by default. Measured
 * on a trivial prompt: default 22 s and the agent recited the operator's tracker rules; with
 * `--setting-sources project,local` 9 s and none of it. Project and local settings still apply.
 * Set FSC_CLAUDE_USER_SETTINGS=1 to opt back in.
 */
export function claudeIsolationArgs(): string[] {
  return process.env.FSC_CLAUDE_USER_SETTINGS === "1" ? [] : ["--setting-sources", "project,local"];
}

export const AGENT_BUILDERS: Record<string, AgentConfig["buildArgs"]> = {
  claude: (prompt: string, _cwd: string) => [
    "-p", prompt,
    "--allowedTools", "Edit,Write,Bash,Read,Glob,Grep",
    "--permission-mode", "bypassPermissions",
    ...claudeIsolationArgs(),
  ],
  codex: (prompt: string, cwd: string) =>
    ["exec", "--approval-mode", "full-auto", "-w", cwd, prompt],
  gemini: (prompt: string, cwd: string) =>
    ["-p", prompt, "--cwd", cwd],
  opencode: (prompt: string, cwd: string) =>
    ["run", "--cwd", cwd, prompt],
  aider: (prompt: string, cwd: string) =>
    ["--yes-always", "--no-git", "--message", prompt],
  ollama: (prompt: string, _cwd: string) =>
    ["run", "qwen2.5:3b", prompt],
};

/** Agent catalog with cost + resource metadata */
export const AGENT_CATALOG: Record<string, { costTier: CostTier; memoryMB: number; command: string }> = {
  claude:   { costTier: "premium", memoryMB: 200, command: "claude" },
  codex:    { costTier: "premium", memoryMB: 200, command: "codex" },
  gemini:   { costTier: "budget",  memoryMB: 150, command: "gemini" },
  aider:    { costTier: "budget",  memoryMB: 100, command: "aider" },
  opencode: { costTier: "free",    memoryMB: 80,  command: "opencode" },
  openclaw: { costTier: "free",    memoryMB: 120, command: "openclaw" },
  ollama:   { costTier: "free",    memoryMB: 50,  command: "ollama" },
};

/**
 * Resource-aware concurrency calculator.
 * Given available RAM and agent type, compute max parallel agents.
 */
export function computeMaxParallel(
  availableMemoryMB: number,
  agentType: AgentType,
  overhead: number = 500, // OS + git overhead MB
): number {
  const catalog = AGENT_CATALOG[agentType] ?? AGENT_CATALOG.opencode;
  const usable = Math.max(0, availableMemoryMB - overhead);
  return Math.max(1, Math.floor(usable / catalog.memoryMB));
}
