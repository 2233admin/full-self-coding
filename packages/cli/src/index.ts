#!/usr/bin/env bun

import { Command } from 'commander';
import {
  analyzeCodebase,
  analyzeCodebaseNative,
  ignoreStateDir,
  UnifiedScheduler,
  TaskSolverManager,
  DistributedScheduler,
  createConfig,
  type Config,
  readConfigWithEnv,
  getGitRemoteUrls,
  CodeCommitter,
  getYYMMDDHHMMSS,
  type Task
} from '@full-self-coding/core';
import fs from 'fs';

// Global configuration accessible throughout the application
export let appConfig: Config;

export async function runFullAnalysis(): Promise<void> {
  // Load configuration from standard location with environment variable overrides
  let config: Config;

  const configFilePathIndex = process.argv.indexOf('--config');
  if (configFilePathIndex > -1) {
    // Support legacy --config argument for backwards compatibility
    const configFilePath = process.argv[configFilePathIndex + 1];
    if (configFilePath) {
      try {
        const configFileContent = await Bun.file(configFilePath).text();
        const userConfig = JSON.parse(configFileContent);
        config = createConfig(userConfig);
        console.log(`Loaded configuration from ${configFilePath}`);
      } catch (error) {
        console.error(`Error loading or parsing config file at ${configFilePath}:`, error);
        process.exit(1);
      }
    } else {
      console.error('Error: --config argument requires a path to a configuration file.');
      process.exit(1);
    }
  } else {
    // Use ConfigReader to load from standard location with env var support
    try {
      config = readConfigWithEnv();
    } catch (error) {
      console.error('Error loading configuration:', error);
      process.exit(1);
    }
  }

  // Store configuration globally for later use
  appConfig = config;

  const mode = config.executionMode ?? 'worktree';
  const useDistributed = process.argv.includes('--distributed') || process.env.FSC_DISTRIBUTED === '1';
  console.log(`FSC: agent=${config.agentType} mode=${mode} repo=${process.cwd()}`);
  if (process.env.FSC_DEBUG) console.log(JSON.stringify(config, null, 2));

  // Only docker and distributed runs fetch code from a remote; native runs use the local repo.
  let gitRemoteUrl = '';
  if (mode === 'docker' || useDistributed) {
    const { fetchUrl } = await getGitRemoteUrls(config.useGithubSSH);
    gitRemoteUrl = fetchUrl || '';
    if (!gitRemoteUrl) {
      throw new Error(
        `${useDistributed ? 'Distributed' : 'Docker'} mode clones the repository from its "origin" remote, ` +
          `but this repository has none. Add one (git remote add origin <url>), or use the default native mode.`,
      );
    }
    console.log(`Git remote: ${gitRemoteUrl}`);
  }

  // Step 1: analyze the codebase and get tasks
  if (mode !== 'docker') ignoreStateDir(process.cwd());
  const tasksFile = process.env.FSC_TASKS_FILE;
  let tasks: Task[];
  if (tasksFile) {
    // Skip analysis: run exactly the tasks in this JSON file (an array of Task objects).
    try {
      tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
    } catch (e) {
      throw new Error(`Cannot read tasks from ${tasksFile}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!Array.isArray(tasks) || tasks.length === 0) throw new Error(`${tasksFile} must contain a non-empty JSON array of tasks.`);
    tasks = tasks.map((t, i) => ({ ...t, priority: t.priority ?? 1, ID: t.ID ?? `task-${i + 1}` }));
  } else {
    console.log('Analyzing the codebase...');
    tasks =
      mode === 'docker'
        ? await analyzeCodebase(config, gitRemoteUrl)
        : await analyzeCodebaseNative(config, process.cwd());
  }
  console.log(`Found ${tasks.length} task(s):`);
  for (const t of tasks) console.log(`  - [P${t.priority}] ${t.title}`);

  // Native path: worktree per task -> agent -> ordered merge onto the current branch.
  if (mode !== 'docker' && !useDistributed) {
    const concurrency = Math.max(1, Math.min(config.maxParallelWorktrees ?? 5, tasks.length));
    console.log(`Running ${tasks.length} task(s), up to ${concurrency} at a time...`);
    const scheduler = new UnifiedScheduler({
      localPoolSize: concurrency,
      maxConcurrency: concurrency,
      agentType: config.agentType,
    });
    const report = await scheduler.execute(tasks, process.cwd());

    console.log('');
    for (const t of report.tasks) {
      const merged = report.mergeResults.find((m) => m.taskId === t.taskId);
      const mergeNote = merged ? (merged.success ? ` (merged${merged.resolvedTier ? `, tier ${merged.resolvedTier}` : ''})` : ` (NOT merged: ${merged.error})`) : '';
      console.log(`  ${t.status === 'completed' && merged?.success ? 'ok  ' : 'FAIL'} ${t.taskId}${mergeNote}${t.error ? ` - ${t.error}` : ''}`);
    }
    const merged = report.mergeResults.filter((m) => m.success && m.resolvedTier).length;
    console.log(`
${report.completed}/${report.total} task(s) completed, ${merged} merged, ${report.failed} failed (${Math.round(report.durationMs / 1000)}s)`);

    const logDir = `${process.cwd()}/.fsc`;
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(`${logDir}/last-report.json`, JSON.stringify(report, null, 2));
    console.log(`Report: ${logDir}/last-report.json`);
    if (report.failed > 0 || merged < report.completed) process.exit(1);
    return;
  }

  // Step 2: execute tasks — distributed (Redis Streams) or local
  let allTaskReports;

  if (useDistributed) {
    console.log('[FSC] Distributed mode — submitting tasks to Redis Streams');
    const agentTypeMap: Record<string, string> = {
      'claude-code': 'claude',
      'gemini-cli': 'gemini',
      'codex': 'codex',
      'cursor': 'bash',
    };
    const scheduler = new DistributedScheduler({
      gitUrl: gitRemoteUrl,
      agentType: agentTypeMap[config.agentType] || 'bash',
    });
    await scheduler.connect();
    try {
      allTaskReports = await scheduler.submitAndWait(tasks);
    } finally {
      await scheduler.disconnect();
    }
  } else {
    const taskSolverManager = new TaskSolverManager(config, gitRemoteUrl);
    for (const task of tasks) {
      taskSolverManager.addTask(task);
    }
    await taskSolverManager.start();
    allTaskReports = taskSolverManager.getReports();
  }

  // Step 3: do code commit
  const codeCommitter = new CodeCommitter(allTaskReports);
  await codeCommitter.commitAllChanges();

  // Step 4: save the final report
  const yymmddhhmmss = getYYMMDDHHMMSS();

  // Save final report — cross-platform log directory
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  const logDir = process.platform === 'darwin'
    ? `${home}/Library/Logs/full-self-coding`
    : `${home}/.local/share/full-self-coding/logs`;

  // Create the directory if it doesn't exist
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  // Write the final report
  const reportPath = logDir + "/finalReport_" + yymmddhhmmss + ".txt";
  fs.writeFileSync(reportPath, JSON.stringify(allTaskReports, null, 2));

  console.log(`Final report saved to "${reportPath}"`);
}

export function createCLI(): Command {
  const program = new Command();

  program
    .name('full-self-coding')
    .description('CLI tool for automated code analysis and task execution')
    .version('1.0.1');

  program
    .command('run')
    .description('Run the full self-coding analysis and task execution')
    .option('-c, --config <path>', 'Path to configuration file')
    .option('--tasks <file>', 'Run the tasks in this JSON file instead of analyzing the codebase')
    .option('--mode <mode>', 'Execution mode: worktree (native git worktree), bare, or docker (optional)', 'worktree')
    .action(async (options) => {
      try {
        // If config option is provided, add it to process.argv for the main function to pick up
        if (options.config) {
          process.argv.push('--config', options.config);
        }
        if (options.tasks) {
          process.env.FSC_TASKS_FILE = options.tasks;
        }
        if (options.mode) {
          process.env.FSC_EXECUTION_MODE = options.mode;
        }
        await runFullAnalysis();
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        if (process.env.FSC_DEBUG && error instanceof Error && error.stack) console.error(error.stack);
        process.exit(1);
      }
    });

  program
    .command('collect')
    .description('Collect results from existing FSC worktrees')
    .option('--interactive', 'Show diffs and confirm merges')
    .action(async (options) => {
      try {
        const { WorktreeManager, WorktreeCollector } = await import('@full-self-coding/core');
        const manager = new WorktreeManager();
        const collector = new WorktreeCollector(manager);

        let tasks: import('@full-self-coding/core').Task[] = [];
        try {
          const raw = await Bun.file('.fsc/tasks.json').text();
          tasks = JSON.parse(raw);
        } catch {
          console.warn('Warning: could not load .fsc/tasks.json, proceeding with empty task list');
        }

        const results = options.interactive
          ? collector.collectInteractive('.', tasks)
          : collector.collectAll('.', tasks);

        console.log(JSON.stringify(results, null, 2));
      } catch (error) {
        console.error('Error collecting results:', error);
        process.exit(1);
      }
    });

  program
    .command('cleanup')
    .description('Remove all FSC worktrees and branches')
    .action(async () => {
      try {
        const { WorktreeManager } = await import('@full-self-coding/core');
        const manager = new WorktreeManager();
        manager.cleanup('.');
        console.log('All FSC worktrees and branches removed successfully.');
      } catch (error) {
        console.error('Error during cleanup:', error);
        process.exit(1);
      }
    });

  program
    .command('preflight')
    .description('Check prerequisites for worktree execution')
    .action(async () => {
      try {
        const { WorktreeManager } = await import('@full-self-coding/core');
        const manager = new WorktreeManager();
        const errors = manager.preflight('.', ['claude']);
        if (errors.length === 0) {
          console.log('Preflight checks passed. All prerequisites satisfied.');
        } else {
          console.error('Preflight checks failed:');
          for (const err of errors) {
            console.error(`  - ${err}`);
          }
          process.exit(1);
        }
      } catch (error) {
        console.error('Error during preflight:', error);
        process.exit(1);
      }
    });

  // Default action - run full analysis if no command is provided
  program.action(async () => {
    try {
      await runFullAnalysis();
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  });

  return program;
}

// Export for use as a library
export { runFullAnalysis as main };

// Run the CLI if this file is executed directly
if (import.meta.main) {
  createCLI().parse();
}