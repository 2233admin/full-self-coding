// Regenerates crates/fsc-merge/tests/golden/merge.json from the TypeScript CommitSequencer.
// The Rust port (crates/fsc-merge) must reproduce these outcomes exactly.
//
//   bun script/gen-merge-golden.ts
//
// Scenarios live in crates/fsc-merge/tests/scenarios.json and are interpreted by both sides.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { CommitSequencer } from "../packages/core/src/execution/sequencer";
import { gitExec } from "../packages/core/src/execution/gitExec";
import type { ExecutionResult } from "../packages/core/src/execution/types";

const SCEN = "crates/fsc-merge/tests/scenarios.json";
const OUT = "crates/fsc-merge/tests/golden/merge.json";

const scenarios = JSON.parse(readFileSync(SCEN, "utf-8"));
const sub = (s: string, vars: Record<string, string>) => s.replace(/\$\{(\w+)\}/g, (_, k) => vars[k]);
const norm = (s: string | undefined) => (s === undefined ? null : s.replace(/[0-9a-f]{40}/g, "<hash>"));

const out: any[] = [];
for (const sc of scenarios) {
  const repo = mkdtempSync(join(tmpdir(), "fsc-golden-"));
  const git = (args: string[]) => {
    const r = gitExec(args, repo);
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${sc.name}: ${r.stderr}`);
    return r;
  };
  git(["init", "-q"]);
  git(["checkout", "-q", "-b", "main"]);
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@t"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) {
    git(["config", k, v]);
  }
  const vars: Record<string, string> = {};
  for (const step of sc.steps) {
    if (step.git) git(step.git.map((a: string) => sub(a, vars)));
    else if (step.write) {
      const p = join(repo, step.write[0]);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, step.write[1]);
    } else if (step.rev) vars[step.rev] = git(["rev-parse", "HEAD"]).stdout.trim();
  }

  const execs: ExecutionResult[] = sc.applies.map((a: any) => ({
    workUnitId: a.id, status: "success", commitHash: a.hash === null ? null : sub(a.hash, vars),
    branch: a.branch, worktreePath: "", startedAt: 0, completedAt: 0, agent: { type: "test" }, filesChanged: [], logs: [],
  }));
  const seq = new CommitSequencer(repo, sc.target);
  const origLog = console.log;
  console.log = () => {}; // the sequencer prints a conflict banner
  let results: any[] = [];
  if (sc.mode === "all") results = await seq.applyAll(execs);
  else for (const e of execs) results.push(await seq.apply(e));
  console.log = origLog;

  const files: Record<string, string | null> = {};
  for (const f of sc.inspect ?? []) files[f] = existsSync(join(repo, f)) ? readFileSync(join(repo, f), "utf-8") : null;
  const histPath = join(repo, ".fsc", "merge-history.json");
  const rawHist = existsSync(histPath) ? JSON.parse(readFileSync(histPath, "utf-8")) : {};
  const history: Record<string, any> = {};
  for (const f of sc.history_files ?? []) history[f] = (rawHist[f] ?? []).map((e: any) => ({ tier: e.tier, success: e.success }));
  const startTiers: Record<string, number> = {};
  for (const f of sc.start_tier_files ?? []) startTiers[f] = seq.getEffectiveStartTier(f);

  out.push({
    ...sc,
    expected: {
      results: results.map((r) => ({
        taskId: r.taskId, success: r.success, resolvedTier: r.resolvedTier ?? null,
        error: norm(r.error), hasCommitHash: !!r.commitHash,
      })),
      files,
      history,
      startTiers,
      porcelainClean: git(["status", "--porcelain", "--untracked-files=no"]).stdout.trim() === "",
      cherryPickInProgress: existsSync(join(repo, ".git", "CHERRY_PICK_HEAD")),
    },
  });
  rmSync(repo, { recursive: true, force: true });
}
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${out.length} scenarios`);
