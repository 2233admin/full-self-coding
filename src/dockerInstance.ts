// Helper to read all text from a Uint8Array synchronously
function streamToTextSync(stream: Uint8Array | null | undefined): string {
	if (!stream) return "";
	return new TextDecoder().decode(stream);
}
import { spawnSync } from "bun";

/**
 * Status of Docker command execution
 */
export enum DockerRunStatus {
	SUCCESS = 'success',
	FAILURE = 'failure',
	TIMEOUT = 'timeout'
}

export interface DockerRunOptions {
	image: string; // Docker image tag or ID
	commands: string[]; // List of commands to run inside the container
	timeoutSeconds?: number; // Max seconds to allow for all commands
}

export class DockerInstance {
	/**
	 * Starts a Docker container, runs commands, and returns all outputs
	 */
	async runCommandsInDocker(options: DockerRunOptions): Promise<{ 
		output: string; 
		success: boolean; 
		status: DockerRunStatus;
		error?: string 
	}> {
		const { image, commands, timeoutSeconds = 300 } = options;
		// Generate a random container name for isolation
		const containerName = `copilot-docker-${Math.random().toString(36).slice(2, 10)}`;
		let output = "";
		let error = "";
		let success = true;
		let status = DockerRunStatus.SUCCESS;
		
		try {
			// Start the container in detached mode
			const startResult = spawnSync([
				"docker", "run", "-d", "--name", containerName, image, "sleep", `${timeoutSeconds}`
			]);
			const containerId = streamToTextSync(startResult.stdout);
			if (startResult.exitCode !== 0) {
				const errText = streamToTextSync(startResult.stderr);
				throw new Error(`Failed to start container: ${errText || "Unknown error"}`);
			}

			// Run each command inside the container
			for (const cmd of commands) {
				const execResult = spawnSync([
					"docker", "exec", containerName, "sh", "-c", cmd
				], { timeout: timeoutSeconds * 1000 });
				
				// Check for timeout
				if (execResult.signal === "SIGTERM") {
					error += `\nTimeout running '${cmd}': Command exceeded ${timeoutSeconds} seconds`;
					success = false;
					status = DockerRunStatus.TIMEOUT;
					break;
				}
				
				const cmdOut = streamToTextSync(execResult.stdout);
				output += `\n$ ${cmd}\n${cmdOut}`;
				if (execResult.exitCode !== 0) {
					const errText = streamToTextSync(execResult.stderr);
					error += `\nError running '${cmd}': ${errText || "Unknown error"}`;
					success = false;
					status = DockerRunStatus.FAILURE;
				}
			}

			// Stop and remove the container
			spawnSync(["docker", "rm", "-f", containerName]);
		} catch (e: any) {
			error += `\nException: ${e?.message || e}`;
			success = false;
			status = DockerRunStatus.FAILURE;
		}
		
		return { 
			output, 
			success, 
			status,
			error: error || undefined 
		};
	}
}
