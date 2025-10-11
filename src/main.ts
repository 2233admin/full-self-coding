import analyzeCodebase from "./analyzer";
import executeTasks from "./taskSolver";

import type { Task } from './task';

export async function main(): Promise<void> {
    // Step 1: analyze the codebase and get tasks
    const tasks: Task[] = await analyzeCodebase();

    // Step 2: execute tasks based on analysis
    await executeTasks(tasks);
}

if (import.meta && import.meta.main) {
	// When executed directly as a Bun script / terminal tool, run the two steps.
	void main();
}
