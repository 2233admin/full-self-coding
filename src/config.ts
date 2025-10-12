/**
 * Available types of Software Engineering agents
 */
export enum SWEAgentType {
    GEMINI_CLI = 'gemini-cli',
    CLAUDE_CODE = 'claude-code',
    CODEX = 'codex',
    // Add more agent types as needed
}

/**
 * Authentication configuration for SWE agents
 */
export interface AgentAuthentication {
    /**
     * API key or access token for the agent
     */
    apiKey?: string;

    /**
     * Optional organization ID (for agents like OpenAI)
     */
    orgId?: string;

    /**
     * Additional authentication parameters specific to each agent type
     */
    [key: string]: string | undefined;
}

/**
 * Main configuration interface for the application
 */
export interface Config {
    /**
     * The type of Software Engineering agent to use
     */
    agentType: SWEAgentType;

    /**
     * Optional authentication configuration for the agent
     */
    auth?: AgentAuthentication;

    /**
     * Maximum number of Docker containers that can run locally
     * @default 5 if not specified
     */
    maxDockerContainers?: number;

    /**
     * Docker image reference to use for containers
     * Format: repository/image:tag
     * @example "ubuntu:latest"
     */
    dockerImageRef?: string;

    /**
     * Max number of docker containers that can run in parallel
     * @default 2 if not specified
     */
    maxParallelDockerContainers?: number;

    /**
     * Timeout in seconds for Docker container operations
     * @default 300 if not specified
     */
    dockerTimeoutSeconds?: number;

    /**
     * Max number of tasks that analyzer can detect
     * @default 10 if not specified
     */
    maxTasks?: number;

    /**
     * Max amount of memory (in MB) that each Docker container can use
     * @default 512 if not specified
     */
    dockerMemoryMB?: number;

    /**
     * Number of CPU cores to assign to each Docker container
     * @default 1 if not specified
     */
    dockerCpuCores?: number;
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: Config = {
    agentType: SWEAgentType.GEMINI_CLI,
    maxDockerContainers: 5,
    dockerImageRef: 'ubuntu:latest'
};

/**
 * Validates and merges user config with default config
 * @param userConfig Partial configuration provided by the user
 * @returns Complete configuration with defaults applied
 */
export function createConfig(userConfig: Partial<Config>): Config {
    return {
        ...DEFAULT_CONFIG,
        ...userConfig,
    };
}
