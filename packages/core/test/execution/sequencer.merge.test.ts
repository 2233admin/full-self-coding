import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { CommitSequencer } from "../../src/execution/sequencer";
import { gitExec } from "../../src/execution/gitExec";
import type { ExecutionResult } from "../../src/execution/types";
import fs from "fs";
import path from "path";
import os from "os";

function makeExecResult(id: string, hash: string, branch: string): ExecutionResult {
  return {
    workUnitId: id, status: "success", commitHash: hash, branch,
    worktreePath: "", startedAt: 0, completedAt: 0,
    agent: { type: "test" }, filesChanged: [], logs: [],
  };
}

describe("CommitSequencer — 4-tier merge resolution", () => {
  let testRepo: string;

  beforeAll(() => {
    testRepo = path.resolve(os.tmpdir(), `fsc-merge-test-${Date.now()}`);
    fs.mkdirSync(testRepo, { recursive: true });
    gitExec(["init"], testRepo);
    gitExec(["checkout", "-b", "main"], testRepo);
    fs.writeFileSync(path.resolve(testRepo, "shared.txt"), "line1\nline2\nline3\n");
    gitExec(["add", "-A"], testRepo);
    gitExec(["commit", "--author", "Test <t@t>", "-m", "initial"], testRepo);
  });

  afterAll(() => {
    fs.rmSync(testRepo, { recursive: true, force: true });
  });

  test("Tier 1: clean cherry-pick (no conflict)", async () => {
    gitExec(["checkout", "-b", "fsc/tier1-test"], testRepo);
    fs.writeFileSync(path.resolve(testRepo, "new-file.txt"), "no conflict");
    gitExec(["add", "-A"], testRepo);
    gitExec(["commit", "--author", "Test <t@t>", "-m", "tier1 commit"], testRepo);
    const hash = gitExec(["rev-parse", "HEAD"], testRepo).stdout.trim();
    gitExec(["checkout", "main"], testRepo);

    const seq = new CommitSequencer(testRepo, "main");
    const result = await seq.apply(makeExecResult("tier1", hash, "fsc/tier1-test"));

    expect(result.success).toBe(true);
    expect(result.resolvedTier).toBe(1);
  });

  test("resolvedTier is undefined for no-conflict commits", async () => {
    const seq = new CommitSequencer(testRepo, "main");
    const result = await seq.apply(makeExecResult("no-change", null as any, "fsc/none"));
    expect(result.success).toBe(true);
    expect(result.resolvedTier).toBeUndefined();
  });

  test("Tier 2 blocked: contentful canonical triggers escalation", async () => {
    // Create a scenario where both sides modify the same line with real content
    const branchBase = "fsc/tier2block-base";
    gitExec(["checkout", "-b", branchBase, "main"], testRepo);
    fs.writeFileSync(path.resolve(testRepo, "conflict.txt"), "original content\n");
    gitExec(["add", "-A"], testRepo);
    gitExec(["commit", "--author", "Test <t@t>", "-m", "add conflict.txt"], testRepo);

    // Main side changes the line
    fs.writeFileSync(path.resolve(testRepo, "conflict.txt"), "main's important change\n");
    gitExec(["add", "-A"], testRepo);
    gitExec(["commit", "--author", "Test <t@t>", "-m", "main changes conflict.txt"], testRepo);
    const baseHead = gitExec(["rev-parse", "HEAD"], testRepo).stdout.trim();

    // Agent branch from before main's change
    gitExec(["checkout", "-b", "fsc/tier2block-agent", baseHead + "~1"], testRepo);
    fs.writeFileSync(path.resolve(testRepo, "conflict.txt"), "agent's different change\n");
    gitExec(["add", "-A"], testRepo);
    gitExec(["commit", "--author", "Test <t@t>", "-m", "agent changes conflict.txt"], testRepo);
    const agentHash = gitExec(["rev-parse", "HEAD"], testRepo).stdout.trim();

    gitExec(["checkout", branchBase], testRepo);

    const seq = new CommitSequencer(testRepo, branchBase);
    const result = await seq.apply(makeExecResult("tier2block", agentHash, "fsc/tier2block-agent"));

    // Should fail — both sides have contentful changes, Tier 2 can't auto-resolve
    // Tier 3/4 not yet wired, so falls through to failure
    expect(result.success).toBe(false);
    expect(result.error).toContain("MERGE_CONFLICT");
    expect(result.error).toContain("tier2 blocked");
  });
});

describe("conflictParser utils", () => {
  const { parseConflictMarkers, hasContentfulCanonical, resolveKeepIncoming } = require("../../src/utils/conflictParser");

  test("parseConflictMarkers extracts ours and theirs", () => {
    const content = [
      "before",
      "<<<<<<< HEAD",
      "ours line",
      "=======",
      "theirs line",
      ">>>>>>> branch",
      "after",
    ].join("\n");

    const chunks = parseConflictMarkers(content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].ours).toBe("ours line");
    expect(chunks[0].theirs).toBe("theirs line");
  });

  test("hasContentfulCanonical detects non-empty ours", () => {
    expect(hasContentfulCanonical({ ours: "real code", theirs: "x", startLine: 0 })).toBe(true);
    expect(hasContentfulCanonical({ ours: "  \n  ", theirs: "x", startLine: 0 })).toBe(false);
    expect(hasContentfulCanonical({ ours: "", theirs: "x", startLine: 0 })).toBe(false);
  });

  test("resolveKeepIncoming keeps theirs side", () => {
    const content = [
      "before",
      "<<<<<<< HEAD",
      "ours",
      "=======",
      "theirs",
      ">>>>>>> branch",
      "after",
    ].join("\n");

    const resolved = resolveKeepIncoming(content);
    expect(resolved).toBe("before\ntheirs\nafter");
  });
});

describe("proseDetector", () => {
  const { looksLikeProse } = require("../../src/utils/proseDetector");

  test("detects conversational openers", () => {
    expect(looksLikeProse("Here is the merged file:\ncode")).toBe(true);
    expect(looksLikeProse("I have merged the two versions")).toBe(true);
  });

  test("passes through raw code", () => {
    expect(looksLikeProse("import { foo } from 'bar';\nexport const x = 1;")).toBe(false);
    expect(looksLikeProse("function merge() {\n  return true;\n}")).toBe(false);
  });

  test("detects multiple prose indicators", () => {
    expect(looksLikeProse("The code I would suggest here is important.\nI recommend using this approach.")).toBe(true);
  });

  test("empty string is not prose", () => {
    expect(looksLikeProse("")).toBe(false);
  });
});
