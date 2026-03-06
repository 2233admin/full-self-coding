import { spawnSync, spawn } from "bun";

/**
 * FSC Task Executor — 统一执行抽象层
 *
 * 支持两种模式:
 * - docker: 原 DockerInstance，容器隔离
 * - bare: WorktreeExecutor，git clone + Bun.spawn，零开销
 */

export enum RunStatus {
	SUCCESS = "success",
	FAILURE = "failure",
	TIMEOUT = "timeout",
}

export interface RunResult {
	output: string;
	success: boolean;
	status: RunStatus;
	error?: string;
}

// ─── 抽象基类 ───

export abstract class TaskExecutor {
	abstract startContainer(image: string, name?: string, options?: { memoryMB?: number; cpuCores?: number }): Promise<string>;
	abstract runCommands(commands: string[], timeoutSeconds?: number): Promise<RunResult>;
	abstract runCommandAsync(command: string, timeoutSeconds?: number): Promise<RunResult>;
	abstract shutdownContainer(): Promise<void>;
	abstract copyFileFromContainer(containerPath: string): Promise<string>;
	abstract copyFileToContainer(fileContent: string, containerFileName: string): Promise<void>;
	abstract copyFilesToContainer(localPath: string, containerTargetPath: string): Promise<void>;
}

// ─── Bare Worker (WorktreeExecutor) ───

function streamToText(stream: Uint8Array | null | undefined): string {
	if (!stream) return "";
	return new TextDecoder().decode(stream);
}

export class WorktreeExecutor extends TaskExecutor {
	private worktreePath: string | null = null;
	private taskId: string | null = null;
	private static ROOT = "/workspace";

	async startContainer(
		_image: string,
		name?: string,
		_options?: { memoryMB?: number; cpuCores?: number }
	): Promise<string> {
		this.taskId = name || `bare-${Math.random().toString(36).slice(2, 10)}`;
		this.worktreePath = `${WorktreeExecutor.ROOT}/${this.taskId}`;
		spawnSync(["mkdir", "-p", this.worktreePath]);
		console.log(`[bare] Created workspace ${this.worktreePath}`);
		return this.taskId;
	}

	async runCommands(commands: string[], timeoutSeconds?: number): Promise<RunResult> {
		if (!this.worktreePath) throw new Error("Workspace not initialized");

		let output = "";
		let error = "";
		let success = true;
		let status = RunStatus.SUCCESS;

		try {
			for (const cmd of commands) {
				const execResult = spawnSync({
					cmd: ["/usr/bin/bash", "-c", cmd],
					cwd: this.worktreePath,
					timeout: timeoutSeconds ? timeoutSeconds * 1000 : undefined,
					env: { ...process.env, HOME: this.worktreePath },
				});

				const cmdOut = streamToText(execResult.stdout);
				output += `\n$ ${cmd}\n${cmdOut}`;

				if (execResult.exitCode !== 0) {
					const errText = streamToText(execResult.stderr);
					error += `\nError running '${cmd}': ${errText || "Unknown error"}`;
					success = false;
					status = RunStatus.FAILURE;
					break;
				}
			}
		} catch (e: any) {
			if (e?.message?.includes("timeout")) {
				status = RunStatus.TIMEOUT;
				error += `\nTimeout: exceeded ${timeoutSeconds}s`;
			} else {
				status = RunStatus.FAILURE;
				error += `\nException: ${e?.message || e}`;
			}
			success = false;
		}

		return { output, success, status, error: error || undefined };
	}

	async runCommandAsync(command: string, timeoutSeconds?: number): Promise<RunResult> {
		if (!this.worktreePath) throw new Error("Workspace not initialized");

		let output = "";
		let error = "";
		let success = true;
		let status = RunStatus.SUCCESS;

		try {
			const proc = spawn({
				cmd: ["/usr/bin/bash", "-c", command],
				cwd: this.worktreePath,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, HOME: this.worktreePath },
			});

			const timeoutId = timeoutSeconds
				? setTimeout(() => proc.kill(), timeoutSeconds * 1000)
				: null;

			const [stdoutText, stderrText] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);

			await proc.exited;
			if (timeoutId) clearTimeout(timeoutId);

			output += `\n$ ${command}\n${stdoutText}`;

			if (proc.exitCode !== 0) {
				error += `\nError running '${command}': ${stderrText || "Unknown error"}`;
				success = false;
				status = RunStatus.FAILURE;
			}
		} catch (e: any) {
			if (e?.message?.includes("timeout") || e?.name === "TimeoutError") {
				status = RunStatus.TIMEOUT;
				error += `\nTimeout: exceeded ${timeoutSeconds || "default"}s`;
			} else {
				status = RunStatus.FAILURE;
				error += `\nException: ${e?.message || e}`;
			}
			success = false;
		}

		return { output, success, status, error: error || undefined };
	}

	async shutdownContainer(): Promise<void> {
		if (this.worktreePath) {
			spawnSync(["rm", "-rf", this.worktreePath]);
			console.log(`[bare] Cleaned up ${this.worktreePath}`);
		}
	}

	async copyFileFromContainer(containerPath: string): Promise<string> {
		if (!this.worktreePath) throw new Error("Workspace not initialized");
		const fullPath = containerPath.startsWith("/")
			? `${this.worktreePath}${containerPath}`
			: `${this.worktreePath}/${containerPath}`;
		try {
			return await Bun.file(fullPath).text();
		} catch {
			throw new Error(`File not found: ${fullPath}`);
		}
	}

	async copyFileToContainer(fileContent: string, containerFileName: string): Promise<void> {
		if (!this.worktreePath) throw new Error("Workspace not initialized");
		const fullPath = containerFileName.startsWith("/")
			? `${this.worktreePath}${containerFileName}`
			: `${this.worktreePath}/${containerFileName}`;

		// Ensure directory exists
		const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
		if (dir) spawnSync(["mkdir", "-p", dir]);

		await Bun.write(fullPath, fileContent);
	}

	async copyFilesToContainer(localPath: string, containerTargetPath: string): Promise<void> {
		if (!this.worktreePath) throw new Error("Workspace not initialized");
		const fullTarget = containerTargetPath.startsWith("/")
			? `${this.worktreePath}${containerTargetPath}`
			: `${this.worktreePath}/${containerTargetPath}`;

		spawnSync(["mkdir", "-p", fullTarget]);
		spawnSync(["cp", "-a", `${localPath}/.`, fullTarget]);
	}
}

// ─── 工厂函数 ───

export type ExecutionMode = "docker" | "bare";

export function createTaskExecutor(mode: ExecutionMode): TaskExecutor {
	if (mode === "bare") {
		return new WorktreeExecutor();
	}
	// Docker mode: 动态导入原 DockerInstance 并包装为 TaskExecutor
	// 为了保持向后兼容，DockerInstance 本身已经实现了所有方法
	const { DockerInstance } = require("./dockerInstance");
	return new DockerInstance() as unknown as TaskExecutor;
}
