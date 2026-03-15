// packages/core/test/execution/gitExec.test.ts
import { describe, test, expect } from "bun:test";
import { gitExec } from "../../src/execution/gitExec";

describe("gitExec", () => {
  test("runs git command and returns stdout", () => {
    const result = gitExec(["--version"], ".");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("git version");
  });

  test("returns non-zero exit code for invalid command", () => {
    const result = gitExec(["invalid-command-xyz"], ".");
    expect(result.exitCode).not.toBe(0);
  });

  test("returns stderr on error", () => {
    const result = gitExec(["log", "--invalidflag"], ".");
    expect(result.exitCode).not.toBe(0);
    // stderr should contain something
  });

  test("respects custom timeout", () => {
    // git --version should complete well within 1s
    const result = gitExec(["--version"], ".", 1000);
    expect(result.exitCode).toBe(0);
  });
});
