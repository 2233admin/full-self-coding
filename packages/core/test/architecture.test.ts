import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

const SRC = join(import.meta.dir, "..", "src");
const DOC = readFileSync(join(import.meta.dir, "..", "..", "..", "MODULE_STRUCTURE.md"), "utf-8");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** Top-level dir under src (or "." for files directly in src) for a source file. */
const moduleOf = (file: string) => {
  const parts = relative(SRC, file).split(sep);
  return parts.length === 1 ? "." : parts[0];
};

/** Relative imports that leave the file's own top-level module: [file, module]. */
function crossModuleImports(): Array<{ file: string; from: string; to: string }> {
  const out: Array<{ file: string; from: string; to: string }> = [];
  for (const file of walk(SRC)) {
    const src = readFileSync(file, "utf-8");
    for (const m of src.matchAll(/(?:from|import\()\s*['"](\.[^'"]+)['"]/g)) {
      const target = join(file, "..", m[1]);
      const rel = relative(SRC, target).split(sep);
      const to = rel.length === 1 ? "." : rel[0];
      const toName = to === "." ? rel[0].replace(/\.ts$/, "") : to;
      const from = moduleOf(file);
      if (from !== to || from === ".") out.push({ file: relative(SRC, file), from, to: toName });
    }
  }
  return out;
}

describe("architecture (see MODULE_STRUCTURE.md)", () => {
  const imports = crossModuleImports();

  test("every src subdirectory is documented", () => {
    const dirs = readdirSync(SRC).filter((n) => statSync(join(SRC, n)).isDirectory());
    const missing = dirs.filter((d) => !DOC.includes("`" + d + "/`"));
    expect(missing).toEqual([]);
  });

  test("agent-daemon, harness, codeRAGv2 only import utils (and config for harness)", () => {
    const allowed: Record<string, string[]> = { "agent-daemon": ["utils"], codeRAGv2: ["utils"], harness: ["utils", "config"] };
    const bad = imports.filter((i) => i.from in allowed && i.to !== i.from && !allowed[i.from].includes(i.to));
    expect(bad).toEqual([]);
  });

  test("execution never imports daemon, docker, v1 solver or analyzer", () => {
    const banned = new Set(["agent-daemon", "dockerInstance", "taskSolver", "taskSolverManager", "analyzer"]);
    const bad = imports.filter((i) => i.from === "execution" && banned.has(i.to));
    expect(bad).toEqual([]);
  });

  test("utils is a leaf layer; prompts only reads config/task/codingStyle", () => {
    const bad = imports.filter(
      (i) =>
        (i.from === "utils" && i.to !== "utils") ||
        (i.from === "prompts" && i.to !== "prompts" && !["config", "task", "codingStyle"].includes(i.to)),
    );
    expect(bad).toEqual([]);
  });
});
