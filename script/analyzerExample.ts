
import { analyzeCodebase } from "../src/analyzer";
import { type Config, SWEAgentType } from "../src/config";
import { WorkStyle } from "../src/workStyle";

async function main() {
    const config: Config = {
        agentType: SWEAgentType.GEMINI_CLI,
        dockerImageRef: "node:latest",//"ubuntu_with_node_and_git",
        dockerTimeoutSeconds: 600,
        maxDockerContainers: 1,
        maxParallelDockerContainers: 1,
        maxTasks: 5,
        minTasks: 1,
        dockerMemoryMB: 512,
        dockerCpuCores: 1,
        workStyle: WorkStyle.DEFAULT,
        codingStyleLevel: 0,
    };
    const gitRemoteUrl = "https://github.com/TinyCC/tinycc";

    console.log(`Analyzing repository: ${gitRemoteUrl}`);

    try {
        const tasks = await analyzeCodebase(config, gitRemoteUrl, false,
           'export GEMINI_API_KEY=AIzaSyBhoZfYrpmU8sLu6SmFrqF5IrdyCJsEDLI ',
        );
        console.log("Generated Tasks:");
        console.log(JSON.stringify(tasks, null, 2));
    } catch (error) {
        console.error("An error occurred during analysis:", error);
    }
}

main();
