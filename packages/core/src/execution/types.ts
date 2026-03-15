// packages/core/src/execution/types.ts

export interface AgentConfig {
  type: "claude" | "codex" | "gemini" | "custom";
  command: string;
  buildArgs(prompt: string, cwd: string): string[];
  env?: Record<string, string>;
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

export type ExecutionStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
  taskId: string;
}

// Pre-built agent arg builders
export const AGENT_BUILDERS = {
  claude: (prompt: string, cwd: string) =>
    ["-p", prompt, "--cwd", cwd, "--allowedTools", "Edit,Write,Bash,Read,Glob,Grep"],
  codex: (prompt: string, cwd: string) =>
    ["exec", "--approval-mode", "full-auto", "-w", cwd, prompt],
  gemini: (prompt: string, cwd: string) =>
    ["-p", prompt, "--cwd", cwd],
} satisfies Record<string, AgentConfig["buildArgs"]>;
