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
