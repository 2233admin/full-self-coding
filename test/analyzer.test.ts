import { expect, test, mock } from "bun:test";
import { analyzeCodebase } from "../src/analyzer";
import { type Config, SWEAgentType } from "../src/config";
import type { Task } from "../src/task";
import { WorkStyle } from "../src/workStyle";
import { DockerInstance, DockerRunStatus } from "../src/dockerInstance";



test("analyzeCodebase generates tasks correctly with GEMINI_CLI agent in real Docker",  async () => {
    const config: Config = {
        agentType: SWEAgentType.GEMINI_CLI,
        dockerImageRef: "ubuntu_with_node_and_git", // Use a real Docker image
        dockerTimeoutSeconds: 10000, // Increased timeout for real Docker operations
        maxDockerContainers: 5,
        maxParallelDockerContainers: 1,
        maxTasks: 100,
        minTasks: 1,
        dockerMemoryMB: 512,
        dockerCpuCores: 1,
        workStyle: WorkStyle.DEFAULT, // WorkStyle is imported from workStyle.ts in analyzer.ts
        codingStyleLevel: 0,
    };
    const gitRemoteUrl = "https://github.com/TinyCC/tinycc"; // Real Git repo

    const tasks = await analyzeCodebase(config, gitRemoteUrl, true,
        'export GEMINI_API_KEY=AIzaSyBhoZfYrpmU8sLu6SmFrqF5IrdyCJsEDLI '
    );

    // Assertions
    expect(tasks).toBeArray();
    expect(tasks.length).toBeGreaterThan(0); // Expect at least one task
    // Further assertions can be added if the exact output of gemini CLI is predictable
    expect(tasks[0]).toHaveProperty("ID");
    expect(tasks[0]).toHaveProperty("title");
    expect(tasks[0]).toHaveProperty("description");
}, 100000000);
