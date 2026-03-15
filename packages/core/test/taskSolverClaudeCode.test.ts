import { describe, it, expect, mock, test } from "bun:test";
import { TaskSolver } from "../src/taskSolver";
import {  TaskStatus } from "../src/task";
import {  SWEAgentType } from "../src/config";
import type { Task } from "../src/task";
import type { Config } from "../src/config";
import { WorkStyle } from "../src/workStyle";
import {CLAUDE_CODE_API_KEY, CLAUDE_CODE_API_URL} from "./apiKeySetup";
import { spawnSync } from "bun";

const dockerAvailable = (() => {
  try {
    const r = spawnSync({ cmd: ["docker", "info"], timeout: 5000 });
    return r.exitCode === 0;
  } catch { return false; }
})();

const testDocker = test.skipIf(!dockerAvailable || !process.env.ANTHROPIC_API_KEY);

testDocker("run a task with claude code agent", async () => {
    const config: Config = {
        agentType: SWEAgentType.CLAUDE_CODE,
        dockerImageRef: "node:latest",
        dockerTimeoutSeconds: 10000000,
        maxDockerContainers: 5,
        maxParallelDockerContainers: 1,
        maxTasks: 100,
        minTasks: 1,
        dockerMemoryMB: 512,
        dockerCpuCores: 1,
        workStyle: WorkStyle.DEFAULT,
        codingStyleLevel: 0,
        anthropicAPIKeyExportNeeded: true,
        anthropicAPIBaseUrl: CLAUDE_CODE_API_URL,
        anthropicAPIKey: CLAUDE_CODE_API_KEY,
    };

    const gitRemoteUrl = "https://github.com/lidangzzz/tinycc";
    const randomNum = Math.floor(Math.random() * 1000000000);
    const task: Task = {
        ID: "test-task-1" + randomNum.toString(),
        title: "add more details to the README.",
        description: "For the tinycc project, add more details to the README.",
        priority: 3,
    };

    const taskSolverInstance  = new TaskSolver(config, task , SWEAgentType.GEMINI_CLI, gitRemoteUrl);
    await taskSolverInstance.solve();
    const result = taskSolverInstance.getResult();
    console.log("Below is the result of the task solver:")
    console.log(result.report);
    console.log(result.gitDiff);
}, 100000000);
