import { SWEAgentType } from "../config";
import type { Config } from "../config";
import { taskSolverPrompt } from "../prompts/taskSolverPrompt";
import type {Task} from "../task";
import {diffNodejsSourceCode} from "../prompts/diff_nodejs";

const diffjsPrompt = diffNodejsSourceCode;
function addTaskSolverPromptIntoPath(
  taskSolverPrompt: string,
  path: string = "/app/taskSolverPrompt.txt",
): string {
  return `echo "${taskSolverPrompt}" > ${path}`;
}

function environmentSetup(config: Config, gitRemoteUrl: string, task: Task, bInstallAgent: boolean = true): string[] {
  let setupCommands = [
    `git clone ${gitRemoteUrl} /app/repo`,
    "apt-get update",
    "apt-get install -y curl",
    "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -",
    "apt-get install -y nodejs",
    "mkdir /app/diff && cd /app/diff && npm install simple-git",
    
    // save diffjsPrompt into /app/diff/run.js
    `echo "${diffjsPrompt}" > /app/diff/run.js`,
  ];

  if (bInstallAgent) {
    if (config.agentType === SWEAgentType.GEMINI_CLI) {
      setupCommands.push(
        "npm install -g @google/gemini-cli",
      );
    }
    else throw new Error(`Unsupported agent type: ${config.agentType}`);
  }

  setupCommands.push("mkdir /app/repo/fsc");
  setupCommands.push(
    addTaskSolverPromptIntoPath(
      taskSolverPrompt(task, config),
      "/app/taskSolverPrompt.txt"));
  return setupCommands;
}

export function taskSolverCommands(
  agentType:SWEAgentType,
  config: Config,
  task: Task,
  gitRemoteUrl: string,
): string[] {
  if (agentType === SWEAgentType.GEMINI_CLI) {
    let finalCommandsList = [];
    finalCommandsList.push(...environmentSetup(config, gitRemoteUrl, task));
    if (config.googleGeminiApiKey && config.googleGeminiAPIKeyExportNeeded) {
      finalCommandsList.push(
        `export GEMINI_API_KEY=${config.googleGeminiApiKey} && gemini -p "all the task descriptions are located at /app/taskSolverPrompt.txt, please read and execute" --yolo`,
      );
    }
    else {
      finalCommandsList.push(
        `gemini -p "all the task descriptions are located at /app/taskSolverPrompt.txt, please read and execute" --yolo`,
      );
    }
    return finalCommandsList;
  }
  else if (agentType === SWEAgentType.CLAUDE_CODE) {
    throw new Error("CLAUDE_CODE is not supported yet for the task solver.");
  }
  else if (agentType === SWEAgentType.CODEX) {
    throw new Error("CODEX is not supported yet for the task solver.");
  }
  throw new Error(`Unsupported agent type: ${agentType}`);
}