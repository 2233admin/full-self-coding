// Used by local.test.ts: run one mock agent through LocalExecution, print the status, return.
import { LocalExecution } from "../../../src/execution/local";
import { WorktreeManager } from "../../../src/execution/worktree";

const repo = process.argv[2];
const execution = new LocalExecution(new WorktreeManager());
const result = await execution.execute({
  id: "timer-test",
  repoPath: repo,
  baseBranch: "main",
  taskPrompt: "x",
  agentConfig: {
    type: "custom",
    command: process.platform === "win32" ? "bash" : "/bin/sh",
    buildArgs: () => ["-c", "echo hi > timer.txt"],
    costTier: "free",
    memoryMB: 50,
  },
  constraints: { timeoutMs: 600_000 },
});
console.log(result.status);
