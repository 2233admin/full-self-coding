import { expect, test, mock, describe } from "bun:test";
import { analyzeCodebase } from "../src/analyzer";
import { type Config, SWEAgentType } from "../src/config";
import type { Task } from "../src/task";
import { WorkStyle } from "../src/workStyle";
import { DockerInstance, DockerRunStatus } from "../src/dockerInstance";
import { GEMINI_API_KEY } from "./apiKeySetup";

describe.skipIf(!process.env.GEMINI_API_KEY)("analyzerGemini integration", () => {
    test("analyzeCodebase generates tasks correctly with GEMINI_CLI agent in real Docker",  async () => {
        const config: Config = {
            agentType: SWEAgentType.GEMINI_CLI,
            dockerImageRef: "node:latest",
            dockerTimeoutSeconds: 10000,
            maxDockerContainers: 5,
            maxParallelDockerContainers: 1,
            maxTasks: 100,
            minTasks: 1,
            dockerMemoryMB: 512,
            dockerCpuCores: 1,
            workStyle: WorkStyle.DEFAULT,
            codingStyleLevel: 0,
            googleGeminiAPIKeyExportNeeded: true,
            googleGeminiApiKey: GEMINI_API_KEY
        };
        const gitRemoteUrl = "https://github.com/TinyCC/tinycc";

        const tasks = await analyzeCodebase(config, gitRemoteUrl, true);

        expect(tasks).toBeArray();
        expect(tasks.length).toBeGreaterThan(0);
        expect(tasks[0]).toHaveProperty("ID");
        expect(tasks[0]).toHaveProperty("title");
        expect(tasks[0]).toHaveProperty("description");
    }, 100000000);
});
