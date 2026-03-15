// packages/core/src/execution/gitExec.ts
import { spawnSync } from "bun";

const GIT_TIMEOUT_MS = 30_000;

export interface GitExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function gitExec(
  args: string[],
  cwd: string,
  timeoutMs: number = GIT_TIMEOUT_MS,
): GitExecResult {
  const result = spawnSync({
    cmd: ["git", ...args],
    cwd,
    timeout: timeoutMs,
  });

  return {
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    exitCode: result.exitCode ?? 1,
  };
}
