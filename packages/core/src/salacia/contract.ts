// packages/core/src/salacia/contract.ts
// Execution Contract — scope definition + auto-generation from task description

import type { Task } from "../task";

export interface ExecutionContract {
  taskId: string;
  allowedPaths: string[];    // glob patterns agent CAN modify
  softAllowedPaths: string[]; // co-change zone: no penalty, but tracked
  excludedPaths: string[];   // glob patterns agent MUST NOT modify
  protectedPaths: string[];  // instant REJECT if touched
  maxFilesChanged: number;
  generatedAt: number;
  generatedBy: "heuristic" | "gitnexus";
}

const DEFAULT_PROTECTED = [
  ".env", ".env.*",
  "package-lock.json", "bun.lockb", "yarn.lock", "pnpm-lock.yaml",
  "*.pem", "*.key", "*.cert",
];

const KEYWORD_PATH_MAP: Record<string, string[]> = {
  execution:   ["packages/core/src/execution/**"],
  scheduler:   ["packages/core/src/execution/scheduler.ts", "packages/core/src/execution/**"],
  agent:       ["packages/core/src/execution/**", "packages/core/src/modelRouter.ts"],
  commit:      ["packages/core/src/codeCommitter.ts", "packages/core/src/execution/sequencer.ts"],
  task:        ["packages/core/src/task.ts", "packages/core/src/taskSolver*.ts"],
  config:      ["packages/core/src/config*.ts"],
  test:        ["packages/core/tests/**", "tests/**"],
  docker:      ["packages/core/src/dockerInstance.ts"],
  cli:         ["packages/cli/**"],
  prompt:      ["packages/core/src/prompts/**"],
  worktree:    ["packages/core/src/execution/worktree.ts", "packages/core/src/execution/pool.ts"],
  quality:     ["packages/core/src/codeCommitter.ts"],
  trust:       ["packages/core/src/codeCommitter.ts"],
  style:       ["packages/core/src/codingStyle.ts", "packages/core/src/workStyle.ts"],
  rag:         ["packages/core/src/codeRAG.ts"],
  distributed: ["packages/core/src/distributedScheduler.ts"],
  docs:        ["README.md", "docs/**"],
  readme:      ["README.md"],
  document:    ["README.md", "docs/**"],
};

function extractPathHints(text: string): string[] {
  const hints: string[] = [];
  const quotedRe = /['"`]([a-zA-Z0-9_./-]+\.[a-zA-Z]+)['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = quotedRe.exec(text)) !== null) {
    hints.push(m[1]);
  }
  const slashRe = /\b([a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+){2,})\b/g;
  while ((m = slashRe.exec(text)) !== null) {
    if (!hints.includes(m[1])) hints.push(m[1]);
  }
  const lower = text.toLowerCase();
  for (const [keyword, paths] of Object.entries(KEYWORD_PATH_MAP)) {
    if (lower.includes(keyword)) {
      for (const p of paths) {
        if (!hints.includes(p)) hints.push(p);
      }
    }
  }
  return hints;
}

function maxFilesForRisk(risk: Task["riskLevel"]): number {
  switch (risk) {
    case "critical": return 30;
    case "high":     return 20;
    case "medium":   return 10;
    case "low":
    default:         return 5;
  }
}

// Always allowed — barrel re-exports and tests are natural companions
const ALWAYS_ALLOWED = [
  "packages/core/src/index.ts",    // barrel re-exports, touched by almost every feat
  "packages/core/test/**",         // tests should follow source changes
  "packages/*/test/**",
  "tests/**",
  ".gitignore",                     // touched by most feat/fix commits
];

export interface GenerateContractOptions {
  repoPath?: string;      // enable co-change coupling when provided
  couplingDays?: number;   // lookback window (default 90)
}

export function generateContract(task: Task, options?: GenerateContractOptions): ExecutionContract {
  const hints = extractPathHints(`${task.title} ${task.description}`);
  const allowedPaths = [
    ...ALWAYS_ALLOWED,
    ...(hints.length > 0 ? hints : ["packages/core/src/**"]),
  ];

  // Soft scope: co-change coupling + sibling directory inference
  let softAllowedPaths: string[] = [];

  // 1. Co-change coupling (git history)
  if (options?.repoPath) {
    const { expandWithCoupling } = require("./coupling") as typeof import("./coupling");
    const coreFiles = hints.filter(h => !h.includes("*"));
    softAllowedPaths = expandWithCoupling(coreFiles, options.repoPath, options.couplingDays);
  }

  // 2. Sibling directory inference: if we allow a specific file, soft-allow its siblings
  const concreteFiles = hints.filter(h => !h.includes("*") && h.includes("/"));
  const siblingDirs = new Set<string>();
  for (const f of concreteFiles) {
    const dir = f.substring(0, f.lastIndexOf("/"));
    if (dir && !siblingDirs.has(dir)) {
      siblingDirs.add(dir);
      const siblingPattern = dir + "/**";
      if (!allowedPaths.includes(siblingPattern) && !softAllowedPaths.includes(siblingPattern)) {
        softAllowedPaths.push(siblingPattern);
      }
    }
  }

  return {
    taskId: task.ID,
    allowedPaths,
    softAllowedPaths,
    excludedPaths: ["node_modules/**", ".git/**", "dist/**", ".fsc/**"],
    protectedPaths: [...DEFAULT_PROTECTED],
    maxFilesChanged: maxFilesForRisk(task.riskLevel),
    generatedAt: Date.now(),
    generatedBy: "heuristic",
  };
}

export function contractToPromptSuffix(contract: ExecutionContract): string {
  return [
    "\n\n## Scope Contract (enforced)",
    `- Allowed paths: ${contract.allowedPaths.join(", ")}`,
    `- Do NOT modify: ${contract.excludedPaths.join(", ")}`,
    `- PROTECTED (will cause rejection): ${contract.protectedPaths.join(", ")}`,
    `- Max files to change: ${contract.maxFilesChanged}`,
  ].join("\n");
}
