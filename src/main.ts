import analyzeCodebase from "./analyzer";
import TaskSolverManager from "./taskSolverManager";
import { createConfig, type Config } from './config';
import { getGitRemoteUrls } from './utils/git'; // New import

import type { Task } from './task';

export async function main(): Promise<void> {
    let userConfig: Partial<Config> = {};
    const configFilePathIndex = process.argv.indexOf('--config');
    if (configFilePathIndex > -1) {
        const configFilePath = process.argv[configFilePathIndex + 1];
        if (configFilePath) {
            try {
                const configFileContent = await Bun.file(configFilePath).text();
                userConfig = JSON.parse(configFileContent);
                console.log(`Loaded configuration from ${configFilePath}`);
            } catch (error) {
                console.error(`Error loading or parsing config file at ${configFilePath}:`, error);
                process.exit(1);
            }
        } else {
            console.error('Error: --config argument requires a path to a configuration file.');
            process.exit(1);
        }
    }

    const config = createConfig(userConfig);

    let gitRemoteUrl: string;
    try {
        const { fetchUrl } = await getGitRemoteUrls();
        gitRemoteUrl = fetchUrl || ''; // Use fetchUrl, or empty string if not found
        if (!gitRemoteUrl) {
            throw new Error("Could not determine git remote URL.");
        }
        console.log(`Detected Git remote URL: ${gitRemoteUrl}`);
    } catch (error) {
        console.error("Error getting git remote URL:", error);
        process.exit(1);
    }

    // Step 1: analyze the codebase and get tasks
    const tasks: Task[] = await analyzeCodebase(config, gitRemoteUrl);

    // Step 2: execute tasks based on analysis
    const taskSolverManager = new TaskSolverManager(config);
    await taskSolverManager.executeTasks(tasks);
}
