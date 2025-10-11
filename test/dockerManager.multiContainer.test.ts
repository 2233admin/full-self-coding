import { expect, test } from "bun:test";
import { DockerManager } from "../src/dockerManager";
import { DockerRunStatus } from "../src/dockerInstance";
import type { Task } from "../src/task";
import { TaskStatus } from "../src/task";

// Create a helper function to create tasks
function createTask(id: string, title: string, description: string): Task {
  return {
    ID: id,
    title,
    description,
    followingTasks: [],
    relatedFiles: [],
    priority: 1,
  };
}

test("DockerManager can run 5 hello world containers simultaneously", async () => {
  // Create 5 independent tasks
  const tasks: Task[] = [];
  for (let i = 1; i <= 5; i++) {
    tasks.push(createTask(
      `hello-world-${i}`,
      `Hello World Task ${i}`,
      `node -e "setTimeout(() => console.log('Hello, World!'), 1000)"`
    ));
  }

  // Create DockerManager with capacity of 5
  const dockerManager = new DockerManager(tasks, {
    maxCapacity: 5,
    dockerImage: "node:20-alpine",
    maxTimeoutSeconds: 300
  });

  // Start the Docker manager with all tasks
  await dockerManager.start();

  // Wait for all tasks to complete
  await dockerManager.waitForAllTasks();

  // Get task results
  const taskResults = dockerManager.getTaskResults();
  
  // Verify that all 5 tasks were processed
  expect(taskResults.length).toBe(5);
  
  // Verify that all tasks were completed successfully
  for (const result of taskResults) {
    expect(result.status).toBe(TaskStatus.SUCCESS);
    // Verify that each task output contains "Hello, World!"
    expect(result.report).toContain("Hello, World!");
  }

  // Stop all containers (should already be stopped, but just to be sure)
  await dockerManager.stopAll();
}, 10000);

test("DockerManager can run 5 hello world containers with JS script simultaneously", async () => {
  // Create 5 independent tasks
  const tasks: Task[] = [];
  for (let i = 1; i <= 5; i++) {
    tasks.push(createTask(
      `hello-world-js-${i}`,
      `Hello World JS Task ${i}`,
      `echo "console.log('Hello, World from JS!')" > /tmp/hello.js && node /tmp/hello.js`
    ));
  }

  // Create DockerManager with capacity of 5
  const dockerManager = new DockerManager(tasks, {
    maxCapacity: 5,
    dockerImage: "node:20-alpine",
    maxTimeoutSeconds: 30
  });

  // Start the Docker manager with all tasks
  await dockerManager.start();

  // Wait for all tasks to complete
  await dockerManager.waitForAllTasks();

  // Get task results
  const taskResults = dockerManager.getTaskResults();
  
  // Verify that all 5 tasks were processed
  expect(taskResults.length).toBe(5);
  
  // Verify that all tasks were completed successfully
  for (const result of taskResults) {
    expect(result.status).toBe(TaskStatus.SUCCESS);
    // Verify that each task output contains "Hello, World from JS!"
    expect(result.report).toContain("Hello, World from JS!");
  }

  // Stop all containers (should already be stopped, but just to be sure)
  await dockerManager.stopAll();
});