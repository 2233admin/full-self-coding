// Regenerates crates/fsc-scope/tests/golden/*.json from the TypeScript salacia implementation.
// The Rust port (crates/fsc-scope) must reproduce these outputs exactly.
//
//   bun script/gen-golden.ts
//
// Run from the repo root. Only re-run when the TS reference intentionally changes.

import { writeFileSync } from "fs";
import { detectDrift } from "../packages/core/src/salacia/drift";
import { generateContract } from "../packages/core/src/salacia/contract";
import type { ExecutionContract } from "../packages/core/src/salacia/contract";

const WT = "crates/fsc-scope/tests/fixtures/wt";
const OUT = "crates/fsc-scope/tests/golden";

const base = (o: Partial<ExecutionContract>): ExecutionContract => ({
  taskId: "t",
  allowedPaths: [],
  softAllowedPaths: [],
  excludedPaths: [],
  protectedPaths: [],
  maxFilesChanged: 5,
  generatedAt: 0,
  generatedBy: "heuristic",
  ...o,
});

const driftCases = [
  // directory glob, exact match, prefix itself
  { contract: base({ allowedPaths: ["packages/core/src/execution/**"] }), files: ["packages/core/src/execution/local.ts", "packages/core/src/execution", "packages/core/src/executionX/a.ts", "README.md"] },
  // empty allowed => everything in scope
  { contract: base({}), files: ["a.txt", "sub/b.ts", "x/y/z.rs"] },
  // *.ext (extension) in protected and excluded
  { contract: base({ allowedPaths: ["**"], protectedPaths: ["*.pem", "*.key"], excludedPaths: ["*.log"] }), files: ["a.pem", "dir/b.key", "c.log", "d.txt"] },
  // .env.* dotfile variants
  { contract: base({ allowedPaths: ["src/**"], protectedPaths: [".env", ".env.*"] }), files: [".env", ".env.local", ".env.production.bak", ".envrc", "src/.env", "src/a.ts"] },
  // trailing slash directory pattern
  { contract: base({ allowedPaths: ["docs/"] }), files: ["docs/a.md", "docs", "docsX/a.md"] },
  // mid-pattern wildcard (crosses '/'), regex metachars in pattern
  { contract: base({ allowedPaths: ["packages/core/src/taskSolver*.ts", "a+b/(c).ts", "x/*/y.ts"] }), files: ["packages/core/src/taskSolver.ts", "packages/core/src/taskSolverManager.ts", "packages/core/src/taskSolverX/deep.ts", "a+b/(c).ts", "aab/c.ts", "x/q/r/y.ts", "x/y.ts"] },
  // soft scope + protected priority + excluded priority over allowed
  { contract: base({ allowedPaths: ["src/**"], softAllowedPaths: ["lib/**", "a.txt"], excludedPaths: ["src/gen/**"], protectedPaths: ["src/secret.ts"] }), files: ["src/a.ts", "src/gen/x.ts", "src/secret.ts", "lib/z.ts", "a.txt", "other/q.ts"] },
  // excess files and score
  { contract: base({ allowedPaths: ["a.txt", "sub/b.ts"], maxFilesChanged: 1, protectedPaths: ["bun.lockb"] }), files: ["a.txt", "sub/b.ts", "bun.lockb", "nope.txt", "zzz.md"] },
  // empty change set
  { contract: base({ allowedPaths: ["src/**"] }), files: [] },
];

const drift = driftCases.map((c) => ({
  contract: c.contract,
  files: c.files,
  expected: detectDrift(c.contract, c.files, WT),
}));

const tasks = [
  { ID: "g1", title: "Fix scheduler retry", description: "The scheduler drops tasks", priority: 3, riskLevel: "high" },
  { ID: "g2", title: "Touch 'packages/core/src/codeCommitter.ts'", description: "see packages/core/src/execution/sequencer.ts and \"docs/ops/notes.md\"", priority: 1 },
  { ID: "g3", title: "Plain title", description: "nothing special here", priority: 1, riskLevel: "critical" },
  { ID: "g4", title: "Docs and tests", description: "update README and add test coverage, also docker", priority: 2, riskLevel: "medium" },
  { ID: "g5", title: "Repeat", description: "'a/b/c.ts' 'a/b/c.ts' a/b/c.ts worktree worktree", priority: 1, riskLevel: "low" },
  { ID: "g6", title: "UPPERCASE CLI PROMPT", description: "Distributed Quality Trust Style RAG", priority: 1 },
];

const contract = tasks.map((t) => {
  const { generatedAt, ...rest } = generateContract(t as any);
  return { task: t, expected: rest };
});

writeFileSync(`${OUT}/drift.json`, JSON.stringify(drift, null, 2) + "\n");
writeFileSync(`${OUT}/contract.json`, JSON.stringify(contract, null, 2) + "\n");
console.log(`wrote ${drift.length} drift cases, ${contract.length} contract cases`);
