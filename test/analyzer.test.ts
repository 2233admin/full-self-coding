import { expect, test } from "bun:test";
import { analyzeCodebase } from "../src/analyzer";
import { type Config, SWEAgentType } from "../src/config";
import type { Task } from "../src/task";
import { WorkStyle } from "../src/workStyle";

test("analyzeCodebase generates tasks correctly with GEMINI_CLI agent in real Docker", async () => {
    const config: Config = {
        agentType: SWEAgentType.GEMINI_CLI,
        dockerImageRef: "node:latest", // Use a real Docker image
        dockerTimeoutSeconds: 600, // Increased timeout for real Docker operations
        maxDockerContainers: 5,
        maxParallelDockerContainers: 1,
        maxTasks: 100,
        minTasks: 1,
        dockerMemoryMB: 512,
        dockerCpuCores: 1,
        workStyle: WorkStyle.DEFAULT, // WorkStyle is imported from workStyle.ts in analyzer.ts
        codingStyleLevel: 0,
        googleGeminiApiKey: "dummy-key",
    };
    const gitRemoteUrl = "https://github.com/TinyCC/tinycc"; // Real Git repo

    // This test will actually run Docker commands.
    // Ensure Docker is running and you have network access.
    // The 'gemini' CLI needs to be installed in the 'node:latest' image
    // and configured to generate a tasks.json file.
    // For this test, we assume the gemini CLI will write a valid tasks.json
    // to /app/repo/fsc/tasks.json inside the container.

    const tasks = await analyzeCodebase(config, gitRemoteUrl);

    // Assertions
    expect(tasks).toBeArray();
    expect(tasks.length).toBeGreaterThan(0); // Expect at least one task
    // Further assertions can be added if the exact output of gemini CLI is predictable
    expect(tasks[0]).toHaveProperty("ID");
    expect(tasks[0]).toHaveProperty("title");
    expect(tasks[0]).toHaveProperty("description");
});

test("analyzeCodebase throws error for unsupported agent type", async () => {
    const config: Config = {
        agentType: SWEAgentType.CLAUDE_CODE, // Unsupported agent type
        dockerImageRef: "node:latest",
        dockerTimeoutSeconds: 300,
        maxDockerContainers: 1,
        maxParallelDockerContainers: 1,
        maxTasks: 10,
        minTasks: 1,
        dockerMemoryMB: 512,
        dockerCpuCores: 1,
        workStyle: WorkStyle.DEFAULT,
        codingStyleLevel: 0,
    };
    const gitRemoteUrl = "https://github.com/TinyCC/tinycc";

    await expect(analyzeCodebase(config, gitRemoteUrl)).rejects.toThrow("Agent type claude-code is not implemented yet.");
});
