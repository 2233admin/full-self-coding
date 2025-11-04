import type { Task } from './task';
import type { Config } from './config';

export class TaskSolverManager {
    private config: Config;
    constructor(config: Config) {
        this.config = config;
    }
    async executeTasks(tasks: Task[]): Promise<void> {
        
    }
}

export default TaskSolverManager;
