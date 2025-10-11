import { expect, test, mock } from "bun:test";
import { DockerManager } from "../src/dockerManager";
import { DockerRunStatus } from "../src/dockerInstance";
import type { Task, TaskResult } from "../src/task";
import { TaskStatus } from "../src/task";

// Create a helper function to create tasks
function createTask(id: string, title: string, description: string): Task {
  return {
    ID: id,
    title,
    description,
    followingTasks: [],
    createdAt: Date.now()
  };
}

// Track Docker instances created
let runningInstances = 0;
let maxRunningInstances = 0;

// Create a mock for DockerInstance with tracking
const mockRunCommandsInDocker = mock(async () => {
  // Track instance usage
  runningInstances++;
  maxRunningInstances = Math.max(maxRunningInstances, runningInstances);
  
  // Simulate a delay to mimic Docker execution
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Simulate instance being destroyed after task completion
  runningInstances--;
  
  return {
    status: DockerRunStatus.SUCCESS,
    output: "Task executed successfully",
    error: null
  };
});

// Mock the entire module
mock.module("../src/dockerInstance", () => {
  // Create a mock DockerInstance class
  class MockDockerInstance {
    runCommandsInDocker = mockRunCommandsInDocker;
  }

  return {
    DockerInstance: MockDockerInstance,
    DockerRunStatus
  };
});

test("DockerManager respects capacity limit with multiple tasks", async () => {
  // Reset counters before test
  runningInstances = 0;
  maxRunningInstances = 0;
  
  // Create 7 tasks with dependencies
  const task1 = createTask("1", "Task 1", "First task");
  const task2 = createTask("2", "Task 2", "Second task");
  const task3 = createTask("3", "Task 3", "Third task");
  const task4 = createTask("4", "Task 4", "Fourth task");
  const task5 = createTask("5", "Task 5", "Fifth task");
  const task6 = createTask("6", "Task 6", "Sixth task");
  const task7 = createTask("7", "Task 7", "Seventh task");

  // Set up task dependencies
  task1.followingTasks = [task3, task4];
  task2.followingTasks = [task5];
  task3.followingTasks = [task6];
  task4.followingTasks = [task7];

  // Create a list of all tasks for verification
  const allTasks = [task1, task2, task3, task4, task5, task6, task7];
  
  // Initial tasks to start with
  const initialTasks = [task1, task2];

  // Create DockerManager with capacity of 3
  const dockerManager = new DockerManager(allTasks, {
    maxCapacity: 3,
    dockerImage: "node:20-alpine",
    maxTimeoutSeconds: 30
  });

  // Start the Docker manager with the initial tasks
  await dockerManager.start();

  // Wait for all tasks to complete (adjust timeout as needed)
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Verify that the maximum number of running instances never exceeded the capacity
  expect(maxRunningInstances).toBeLessThanOrEqual(3);
  
  // Verify that all tasks were processed
  const taskResults = dockerManager.getTaskResults();
  expect(taskResults.length).toBe(7);
  
  // Verify that all tasks were completed successfully
  for (const result of taskResults) {
    expect(result.status).toBe(TaskStatus.SUCCESS);
  }
});