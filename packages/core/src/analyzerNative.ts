import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import type { Task } from './task';
import { type Config, SWEAgentType } from './config';
import { analyzerPrompt } from './prompts/analyzerPrompt';
import { getCodingStyle } from './codingStyle';
import { getWorkStyleDescription, WorkStyle } from './workStyle';
import { trimJSONObjectArray } from './utils/trimJSON';
import { claudeIsolationArgs } from './execution/types';

const ALLOWED_TOOLS = 'Bash,ReadEdit,Glob,Grep,WebFetch,WebSearch,Write,TodoWrite,SlashCommand';
const DEFAULT_TIMEOUT_SECONDS = 1200;

function git(args: string[], cwd: string): { ok: boolean; out: string } {
  const r = Bun.spawnSync({ cmd: ['git', ...args], cwd });
  return { ok: r.exitCode === 0, out: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr) };
}

/** Keep our `.fsc/` runtime state out of `git status` without touching the user's .gitignore. */
export function ignoreStateDir(repo: string): void {
  const p = git(['rev-parse', '--git-path', 'info/exclude'], repo);
  if (!p.ok) return;
  const file = resolve(repo, p.out.trim());
  try {
    const cur = existsSync(file) ? readFileSync(file, 'utf-8') : '';
    if (!/^\/?\.fsc\/?$/m.test(cur)) {
      mkdirSync(join(file, '..'), { recursive: true });
      const sep = cur && !cur.endsWith('\n') ? '\n' : '';
      writeFileSync(file, `${cur}${sep}.fsc/\n`, 'utf-8');
    }
  } catch {
    // not fatal: worst case `.fsc/` shows up as untracked
  }
}

/** Environment for the local agent process. Never put keys on a command line. */
function agentEnv(config: Config): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (config.anthropicAPIKey) env.ANTHROPIC_AUTH_TOKEN = config.anthropicAPIKey;
  if (config.anthropicAPIBaseUrl) env.ANTHROPIC_BASE_URL = config.anthropicAPIBaseUrl;
  return env;
}

/**
 * Analyze the codebase with a locally installed agent CLI and return the task list.
 * No Docker and no git remote needed. The agent runs in a throwaway detached worktree of HEAD
 * so a misbehaving analyzer cannot touch the user's working tree.
 */
export async function analyzeCodebaseNative(config: Config, repoPath: string): Promise<Task[]> {
  if (config.agentType !== SWEAgentType.CLAUDE_CODE) {
    throw new Error(
      `Native analysis currently supports agentType "claude-code" (got "${config.agentType}"). ` +
        `Use --mode docker for other agents.`,
    );
  }
  const repo = resolve(repoPath);
  if (!git(['rev-parse', '--git-dir'], repo).ok) {
    throw new Error(`${repo} is not a git repository. Run FSC from inside one (git init, and make at least one commit).`);
  }
  if (!git(['rev-parse', '--verify', 'HEAD'], repo).ok) {
    throw new Error('This repository has no commits yet. Make an initial commit first.');
  }
  if (!Bun.which('claude')) {
    throw new Error('The "claude" CLI was not found on PATH. Install Claude Code, or change agentType.');
  }

  ignoreStateDir(repo);
  const stateDir = join(repo, '.fsc', 'analysis');
  mkdirSync(stateDir, { recursive: true });
  const tasksPath = join(stateDir, 'tasks.json');
  const promptPath = join(stateDir, 'codeAnalyzerPrompt.txt');
  rmSync(tasksPath, { force: true });

  const workStyle = await getWorkStyleDescription(config.workStyle || WorkStyle.DEFAULT, {
    customLabel: config.customizedWorkStyle,
  });
  const codingStyle = getCodingStyle(config.codingStyleLevel || 0);
  writeFileSync(promptPath, analyzerPrompt(workStyle, codingStyle, config, tasksPath), 'utf-8');

  const scratch = join(stateDir, `wt-${Date.now()}`);
  const add = git(['worktree', 'add', '--detach', scratch, 'HEAD'], repo);
  if (!add.ok) throw new Error(`Could not create the analysis worktree: ${add.out.trim()}`);

  try {
    const seconds = config.analysisTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    const proc = Bun.spawn({
      cmd: [
        'claude',
        '-p',
        `All the task descriptions are in ${promptPath}. Read it and do what it says.`,
        '--allowedTools',
        ALLOWED_TOOLS,
        '--permission-mode',
        'bypassPermissions',
        ...claudeIsolationArgs(),
      ],
      cwd: scratch,
      env: { ...agentEnv(config), IS_SANDBOX: '1' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => proc.kill(), seconds * 1000);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);

    if (!existsSync(tasksPath)) {
      const why = code === 0 ? 'the agent finished without writing the task file' : `the agent exited with code ${code}`;
      const tail = (stderr || stdout).trim().split('\n').slice(-5).join('\n');
      throw new Error(`Analysis produced no tasks: ${why}.${tail ? `\n${tail}` : ''}`);
    }
    const json = trimJSONObjectArray(readFileSync(tasksPath, 'utf-8'));
    let tasks: Task[];
    try {
      tasks = JSON.parse(json);
    } catch (e) {
      throw new Error(`The agent wrote a task file that is not valid JSON (${tasksPath}): ${e instanceof Error ? e.message : e}`);
    }
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new Error(`The agent found no tasks (${tasksPath}).`);
    }
    return tasks;
  } finally {
    // Cleanup is best effort: on Windows the agent can still hold the directory for a moment,
    // and a failed cleanup must never hide the analysis result (or its real error).
    git(['worktree', 'remove', '--force', scratch], repo);
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      console.warn(`Could not remove ${scratch}; delete it manually.`);
    }
    git(['worktree', 'prune'], repo);
  }
}
