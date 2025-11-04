import type { Task } from './task';
import { type Config, SWEAgentType } from './config';
import { DockerInstance, DockerRunStatus } from './dockerInstance';
import { analyzerPrompt } from './prompts/analyzerPrompt';
import { getCodingStyle } from './codingStyle';
import { getWorkStyleDescription, WorkStyle } from './workStyle';
import { trimJSONObjectArray } from './utils/trimJSON';

/**
 * Analyzes the codebase and generates a list of tasks to be executed
 * @returns Promise<Task[]> Array of tasks identified from the codebase analysis
 */
export async function analyzeCodebase(
    config: Config, 
    gitRemoteUrl: string, 
    shutdownContainer: boolean = true,
    extraComandsBeforeAnalysis?: string
): Promise<Task[]> {
    if (config.agentType !== SWEAgentType.GEMINI_CLI) {
        throw new Error(`Agent type ${config.agentType} is not implemented yet.`);
    }

    const docker = new DockerInstance();
    let containerName: string | undefined;
    let tasks: Task[] = [];

    try {
        const dockerImageRef = config.dockerImageRef || 'node:latest';
        containerName = await docker.startContainer(dockerImageRef);

        const allCommands: string[] = [];

        // 1. Clone the source code repository
        allCommands.push(`git clone ${gitRemoteUrl} /app/repo`);

        // 2. Setup necessary tools (curl, nodejs, npm)
        allCommands.push("apt-get update");
        allCommands.push("apt-get install -y curl");
        allCommands.push("curl -fsSL https://deb.nodesource.com/setup_20.x | bash -");
        allCommands.push("apt-get install -y nodejs");

        // 3. Install gemini-cli globally if agent type is GEMINI_CLI
        if (config.agentType === SWEAgentType.GEMINI_CLI) {
            allCommands.push(`npm install -g @google/gemini-cli`);
        }

        // 4. Create the fsc directory and prompt.txt
        const workStyleDescription = await getWorkStyleDescription(config.workStyle || WorkStyle.DEFAULT, { customLabel: config.customizedWorkStyle });
        const codingStyleDescription = getCodingStyle(config.codingStyleLevel || 0);
        const prompt = analyzerPrompt(workStyleDescription, codingStyleDescription, config);

        allCommands.push(`mkdir -p /app/repo/fsc`); // -p ensures parent directories are created if they don't exist
        allCommands.push(`echo "${prompt}" > /app/repo/fsc/prompt.txt`);
        allCommands.push(`ls -l /app/repo/fsc/prompt.txt`); // Verify prompt.txt creation

        // 5. Prepare API key export and gemini command
        let geminiCommand = `gemini -p "all the task descriptions are located at /app/repo/fsc/prompt.txt, please read and execute" --yolo`;
        let apiKeyExportCommand: string | undefined;

        if (config.googleGeminiApiKey && config.googleGeminiAPIKeyExportNeeded) {
            apiKeyExportCommand = `export GEMINI_API_KEY=${config.googleGeminiApiKey}`;
        } else if (config.anthropicApiKey && config.anthropicAPIKeyExportNeeded) {
            apiKeyExportCommand = `export ANTHROPIC_API_KEY=${config.anthropicApiKey}`;
        } else if (config.openAICodexApiKey && config.openAICodexAPIKeyExportNeeded) {
            apiKeyExportCommand = `export OPENAI_API_KEY=${config.openAICodexApiKey}`;
        }

        if (apiKeyExportCommand) {
            geminiCommand = `${apiKeyExportCommand} && ${geminiCommand}`;
        }

        if (extraComandsBeforeAnalysis) {
            allCommands.push(extraComandsBeforeAnalysis);
        }
        allCommands.push(geminiCommand);

        console.log("Commands to run in Docker:");
        for (const command of allCommands) {
            console.log(command);
        }

        // Execute all commands in a single run
        const dockerResult = await docker.runCommands(
            allCommands,
            config.dockerTimeoutSeconds? config.dockerTimeoutSeconds : 0
        );

        if (dockerResult.status !== DockerRunStatus.SUCCESS) {
            console.error("Docker command execution failed:", dockerResult.error);
            throw new Error(`Docker command execution failed: ${dockerResult.error || dockerResult.output}`);
        }

        // 6. Read the generated tasks.json
        const readTasksCommand = `cat /app/repo/fsc/tasks.json`;
        const readTasksResult = await docker.runCommands(
            [readTasksCommand],
            config.dockerTimeoutSeconds? config.dockerTimeoutSeconds : 0
        );

        if (readTasksResult.status !== DockerRunStatus.SUCCESS) {
            console.error("Failed to read tasks.json from Docker:", readTasksResult.error);
            throw new Error(`Failed to read tasks.json from Docker: ${readTasksResult.error || readTasksResult.output}`);
        }

        try {
            const outputTasksInString = trimJSONObjectArray(readTasksResult.output);
            console.log("***Output tasks in string:\n\n", outputTasksInString);
            tasks = JSON.parse(outputTasksInString);
        } catch (error) {
            console.error("Error parsing tasks.json:", error);
            throw new Error(`Error parsing tasks.json: ${error}`);
        }
    } finally {
        if (shutdownContainer) {
            await docker.shutdownContainer();
        }
    }
    return tasks;
}
export default analyzeCodebase;
