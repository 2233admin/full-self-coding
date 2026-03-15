import { expect, test, mock, describe } from "bun:test";
import { analyzeCodebase } from "../src/analyzer";
import { type Config, SWEAgentType } from "../src/config";
import type { Task } from "../src/task";
import { WorkStyle } from "../src/workStyle";
import { DockerInstance, DockerRunStatus } from "../src/dockerInstance";
import {CLAUDE_CODE_API_KEY, CLAUDE_CODE_API_URL} from "./apiKeySetup";

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("analyzerClaudeCode integration", () => {
    test("analyzeCodebase generates tasks correctly with claude code agent in real Docker",  async () => {
        const config: Config = {
            agentType: SWEAgentType.CLAUDE_CODE,
            dockerImageRef: "node:latest",
            dockerTimeoutSeconds: 10000,
            maxDockerContainers: 5,
            maxParallelDockerContainers: 1,
            maxTasks: 5,
            minTasks: 1,
            dockerMemoryMB: 512,
            dockerCpuCores: 1,
            workStyle: WorkStyle.DEFAULT,
            anthropicAPIKeyExportNeeded: true,
            anthropicAPIBaseUrl: CLAUDE_CODE_API_URL,
            anthropicAPIKey: CLAUDE_CODE_API_KEY,
            codingStyleLevel: 0,
        };
        const gitRemoteUrl = "https://github.com/TinyCC/tinycc";

        const tasks = await analyzeCodebase(config, gitRemoteUrl, true,);

        expect(tasks).toBeArray();
        expect(tasks.length).toBeGreaterThan(0);
        expect(tasks[0]).toHaveProperty("ID");
        expect(tasks[0]).toHaveProperty("title");
        expect(tasks[0]).toHaveProperty("description");
    }, 100000000);
});
