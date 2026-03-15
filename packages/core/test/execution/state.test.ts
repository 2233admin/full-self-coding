import { describe, test, expect } from "bun:test";
import { TaskStateStore } from "../../src/execution/state";

describe("TaskStateStore", () => {
  test("create sets pending status", () => {
    const store = new TaskStateStore();
    const state = store.create("task-1", "local");
    expect(state.status).toBe("pending");
    expect(state.target).toBe("local");
    expect(state.retryCount).toBe(0);
  });

  test("transition updates status", () => {
    const store = new TaskStateStore();
    store.create("task-1");
    store.transition("task-1", "running");
    expect(store.get("task-1")!.status).toBe("running");
    expect(store.get("task-1")!.startedAt).toBeDefined();
  });

  test("transition with update merges fields", () => {
    const store = new TaskStateStore();
    store.create("task-1");
    store.transition("task-1", "completed", { commitHash: "abc123", agentType: "claude" });
    const s = store.get("task-1")!;
    expect(s.status).toBe("completed");
    expect(s.commitHash).toBe("abc123");
    expect(s.completedAt).toBeDefined();
  });

  test("transition throws for unknown task", () => {
    const store = new TaskStateStore();
    expect(() => store.transition("nope", "running")).toThrow("not found");
  });

  test("list with no filter returns all", () => {
    const store = new TaskStateStore();
    store.create("a"); store.create("b"); store.create("c");
    expect(store.list()).toHaveLength(3);
  });

  test("list filters by status", () => {
    const store = new TaskStateStore();
    store.create("a"); store.create("b"); store.create("c");
    store.transition("a", "running");
    store.transition("b", "completed");
    expect(store.list({ status: "pending" })).toHaveLength(1);
    expect(store.list({ status: "running" })).toHaveLength(1);
  });

  test("list filters by target", () => {
    const store = new TaskStateStore();
    store.create("a", "local");
    store.create("b", "remote");
    expect(store.list({ target: "local" })).toHaveLength(1);
    expect(store.list({ target: "remote" })).toHaveLength(1);
  });

  test("summary counts correctly", () => {
    const store = new TaskStateStore();
    store.create("a"); store.create("b"); store.create("c"); store.create("d");
    store.transition("a", "running");
    store.transition("b", "completed");
    store.transition("c", "failed", { error: "boom" });
    const s = store.summary();
    expect(s.total).toBe(4);
    expect(s.pending).toBe(1);
    expect(s.running).toBe(1);
    expect(s.completed).toBe(1);
    expect(s.failed).toBe(1);
  });

  test("markAborted sets aborted status", () => {
    const store = new TaskStateStore();
    store.create("a");
    store.transition("a", "running");
    store.markAborted("a");
    expect(store.get("a")!.status).toBe("aborted");
  });

  test("markForRetry resets state and increments retryCount", () => {
    const store = new TaskStateStore();
    store.create("a");
    store.transition("a", "failed", { error: "timeout" });
    store.markForRetry("a");
    const s = store.get("a")!;
    expect(s.status).toBe("pending");
    expect(s.retryCount).toBe(1);
    expect(s.error).toBeUndefined();
    expect(s.completedAt).toBeUndefined();
  });

  test("toJSON and fromJSON roundtrip", () => {
    const store = new TaskStateStore();
    store.create("a", "local");
    store.transition("a", "completed", { commitHash: "xyz" });
    store.create("b", "remote");

    const json = store.toJSON();
    const restored = TaskStateStore.fromJSON(json);
    expect(restored.get("a")!.commitHash).toBe("xyz");
    expect(restored.get("b")!.target).toBe("remote");
    expect(restored.list()).toHaveLength(2);
  });

  test("getFailedTasks returns only failed", () => {
    const store = new TaskStateStore();
    store.create("a"); store.create("b"); store.create("c");
    store.transition("a", "failed");
    store.transition("b", "completed");
    expect(store.getFailedTasks()).toHaveLength(1);
    expect(store.getFailedTasks()[0].taskId).toBe("a");
  });
});
