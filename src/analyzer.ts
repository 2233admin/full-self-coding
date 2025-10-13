import type { Task } from './task';
import { type Config, SWEAgentType } from './config';
import { DockerInstance, DockerRunStatus } from './dockerInstance';
import { analyzerPrompt } from './prompts/analyzerPrompt';
import { getCodingStyle } from './codingStyle';
import { getWorkStyleDescription, WorkStyle } from './workStyle';

/**
 * Analyzes the codebase and generates a list of tasks to be executed
 * @returns Promise<Task[]> Array of tasks identified from the codebase analysis
 */
export async function analyzeCodebase(config: Config, gitRemoteUrl: string): Promise<Task[]> {
    if (config.agentType !== SWEAgentType.GEMINI_CLI) {
        throw new Error(`Agent type ${config.agentType} is not implemented yet.`);
    }

    const docker = new DockerInstance();
    let containerName: string | undefined;
    let tasks: Task[] = [];

    try {
        // Start the Docker container once
        const dockerImageRef = config.dockerImageRef || 'node:latest';
        containerName = await docker.startContainer(dockerImageRef);

        const commandsToRunInDocker: string[] = [];

        // 3. In the docker, run "git clone" to clone the source code repo
        commandsToRunInDocker.push(`git clone ${gitRemoteUrl} /app/repo`);
        commandsToRunInDocker.push(`cd /app/repo`);

        // 4. Based on the config object, check if api key needs to be export in terminal for gemini cli, codex or claude code
        if (config.googleGeminiApiKey) {
            commandsToRunInDocker.push(`export GEMINI_API_KEY=${config.googleGeminiApiKey}`);
        }
        if (config.claudeApiKey) {
            commandsToRunInDocker.push(`export ANTHROPIC_API_KEY=${config.claudeApiKey}`);
        }
        if (config.openAICodexApiKey) {
            commandsToRunInDocker.push(`export OPENAI_API_KEY=${config.openAICodexApiKey}`);
        }

        // 5. Based on the config object, run npm install to install google gemini cli globally;
        if (config.agentType === SWEAgentType.GEMINI_CLI) {
            commandsToRunInDocker.push(`npm install -g @google/gemini-cli`);
        }

        // If swe agent is gemini-cli, create the analyzer prompt, start the gemini cli in headeless mode and yolo mode, gemini -p "ANALYZER_PROMPT" --yolo;
        const workStyleDescription = await getWorkStyleDescription(config.workStyle || WorkStyle.DEFAULT, { customLabel: config.customizedWorkStyle });
        const codingStyleDescription = getCodingStyle(config.codingStyleLevel || 0);

        const prompt = analyzerPrompt(workStyleDescription, codingStyleDescription, config);
        commandsToRunInDocker.push(`mkdir -p ./fsc`);
        commandsToRunInDocker.push(`echo "${prompt}" > ./fsc/prompt.txt`);
        commandsToRunInDocker.push(`gemini -p "all the task descriptions are located at ./fsc/prompt.txt, please read and execute" --yolo`);

        // Execute all commands in Docker
        const dockerResult = await docker.runCommands(
            containerName,
            commandsToRunInDocker,
            config.dockerTimeoutSeconds || 300
        );

        if (dockerResult.status !== DockerRunStatus.SUCCESS) {
            console.error("Docker command execution failed:", dockerResult.error);
            throw new Error(`Docker command execution failed: ${dockerResult.error || dockerResult.output}`);
        }

        // 7. After the gemini cli finish the task, read the "./fsc/task.json" file in the terminal and send the json string back to the analyzer
        // Assuming gemini cli writes to /app/repo/fsc/tasks.json inside the container
        const readTasksCommand = `cat /app/repo/fsc/tasks.json`;
        const readTasksResult = await docker.runCommands(
            containerName,
            [readTasksCommand],
            60 // Short timeout for reading a file
        );

        if (readTasksResult.status !== DockerRunStatus.SUCCESS) {
            console.error("Failed to read tasks.json from Docker:", readTasksResult.error);
            throw new Error(`Failed to read tasks.json from Docker: ${readTasksResult.error || readTasksResult.output}`);
        }

        try {
            tasks = JSON.parse(readTasksResult.output);
        } catch (error) {
            console.error("Error parsing tasks.json:", error);
            throw new Error(`Error parsing tasks.json: ${error}`);
        }
    } finally {
        // Ensure the Docker container is shut down
        if (containerName) {
            await docker.shutdownContainer(containerName);
        }
    }
    return tasks;
}
export default analyzeCodebase;
