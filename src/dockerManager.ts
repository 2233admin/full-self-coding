import { DockerInstance, DockerRunStatus } from './dockerInstance';
import type { DockerRunOptions } from './dockerInstance';
import type { Task, TaskResult } from './task';
import { TaskStatus } from './task';

/**
 * Configuration options for the DockerManager
 */
export interface DockerManagerOptions {
  /**
   * Maximum number of Docker instances that can run simultaneously
   */
  maxCapacity: number;
  
  /**
   * Docker image name or hash to use for all tasks
   */
  dockerImage: string;
  
  /**
   * Maximum timeout in seconds for each Docker task
   */
  maxTimeoutSeconds: number;
}

/**
 * Manages multiple Docker instances for executing tasks
 */
export class DockerManager {
  private tasks: Task[];
  private taskQueue: Task[];
  private runningTasks: Map<string, { task: Task, instance: DockerInstance }>;
  private taskResults: Map<string, TaskResult>;
  private options: DockerManagerOptions;
  
  /**
   * Creates a new DockerManager
   * 
   * @param tasks Array of tasks to be executed
   * @param options Configuration options for the DockerManager
   */
  constructor(tasks: Task[], options: DockerManagerOptions) {
    this.tasks = [...tasks];
    this.taskQueue = [...tasks];
    this.runningTasks = new Map();
    this.taskResults = new Map();
    this.options = options;
    
    // Initialize task results for all tasks
    this.initializeTaskResults();
  }
  
  /**
   * Initializes task results for all tasks with NOT_STARTED status
   */
  private initializeTaskResults(): void {
    for (const task of this.tasks) {
      this.taskResults.set(task.ID, {
        ...task,
        status: TaskStatus.NOT_STARTED,
        report: '',
        completedAt: 0
      });
    }
  }
  
  /**
   * Starts processing the task queue
   */
  public async start(): Promise<void> {
    // Start as many tasks as allowed by maxCapacity
    while (this.runningTasks.size < this.options.maxCapacity && this.taskQueue.length > 0) {
      await this.startNextTask();
    }
  }
  
  /**
   * Starts the next task from the queue
   */
  private async startNextTask(): Promise<void> {
    if (this.taskQueue.length === 0) return;
    
    const task = this.taskQueue.shift()!;
    
    // Update task status to ONGOING
    this.updateTaskStatus(task.ID, TaskStatus.ONGOING, 'Task execution started');
    
    // Create a new Docker instance for the task
    const dockerInstance = new DockerInstance();
    this.runningTasks.set(task.ID, { task, instance: dockerInstance });
    
    // Execute the task in the Docker instance
    this.executeTask(task, dockerInstance);
  }
  
  /**
   * Executes a task in a Docker instance
   */
  private async executeTask(task: Task, dockerInstance: DockerInstance): Promise<void> {
    try {
      // Prepare Docker run options
      const options: DockerRunOptions = {
        image: this.options.dockerImage,
        commands: [
          // Here you would convert the task to actual commands
          // This is a placeholder - you would need to implement the actual command generation
          `echo "Executing task: ${task.title}"`,
          `echo "Description: ${task.description}"`
        ],
        timeoutSeconds: this.options.maxTimeoutSeconds
      };
      
      // Run the commands in Docker
      const result = await dockerInstance.runCommandsInDocker(options);
      
      if (result.status === DockerRunStatus.SUCCESS) {
        // Task completed successfully
        this.handleTaskSuccess(task, result.output);
      } else if (result.status === DockerRunStatus.TIMEOUT) {
        // Task timed out
        this.handleTaskFailure(task, result.output, `Task timed out after ${this.options.maxTimeoutSeconds} seconds. ${result.error || ''}`);
      } else {
        // Task failed
        this.handleTaskFailure(task, result.output, result.error || 'Unknown error');
      }
    } catch (error) {
      // Handle any exceptions
      this.handleTaskFailure(task, '', `Exception: ${error}`);
    } finally {
      // Remove the task from running tasks
      this.runningTasks.delete(task.ID);
      
      // Start the next task if available
      if (this.taskQueue.length > 0 && this.runningTasks.size < this.options.maxCapacity) {
        await this.startNextTask();
      }
    }
  }
  
  /**
   * Handles successful task completion
   */
  private handleTaskSuccess(task: Task, output: string): void {
    // Update task status
    this.updateTaskStatus(
      task.ID, 
      TaskStatus.SUCCESS, 
      `Task completed successfully.\nOutput: ${output}`,
      // You would get the actual commit hash from your version control system
      'dummy-commit-hash'
    );
    
    // Add following tasks to the queue
    for (const followingTask of task.followingTasks) {
      this.taskQueue.push(followingTask);
    }
  }
  
  /**
   * Handles task failure
   */
  private handleTaskFailure(task: Task, output: string, error: string): void {
    // Update task status
    this.updateTaskStatus(
      task.ID,
      TaskStatus.FAILURE,
      `Task failed.\nOutput: ${output}\nError: ${error}`
    );
    
    // Remove all following tasks and their following tasks recursively
    this.removeFollowingTasksRecursively(task);
  }
  
  /**
   * Recursively removes all following tasks from the queue
   */
  private removeFollowingTasksRecursively(task: Task): void {
    for (const followingTask of task.followingTasks) {
      // Remove from queue if present
      const index = this.taskQueue.findIndex(t => t.ID === followingTask.ID);
      if (index !== -1) {
        this.taskQueue.splice(index, 1);
      }
      
      // Update status to NOT_STARTED (task was removed before it started)
      this.updateTaskStatus(
        followingTask.ID,
        TaskStatus.NOT_STARTED,
        'Task was removed from queue because a prerequisite task failed'
      );
      
      // Recursively remove following tasks
      this.removeFollowingTasksRecursively(followingTask);
    }
  }
  
  /**
   * Updates the status of a task
   */
  private updateTaskStatus(
    taskId: string, 
    status: TaskStatus, 
    report: string, 
    commitHash?: string
  ): void {
    const taskResult = this.taskResults.get(taskId);
    if (taskResult) {
      taskResult.status = status;
      taskResult.report = report;
      taskResult.completedAt = status === TaskStatus.SUCCESS || status === TaskStatus.FAILURE 
        ? Date.now() 
        : taskResult.completedAt;
      
      if (commitHash) {
        taskResult.commitHash = commitHash;
      }
      
      this.taskResults.set(taskId, taskResult);
    }
  }
  
  /**
   * Gets the results of all tasks
   */
  public getTaskResults(): TaskResult[] {
    return Array.from(this.taskResults.values());
  }
  
  /**
   * Gets the result of a specific task
   */
  public getTaskResult(taskId: string): TaskResult | undefined {
    return this.taskResults.get(taskId);
  }
  
  /**
   * Stops all running Docker instances
   */
  public async stopAll(): Promise<void> {
    // This would need to be implemented to stop all running Docker instances
    // For now, we'll just clear the running tasks
    this.runningTasks.clear();
    this.taskQueue = [];
  }
}