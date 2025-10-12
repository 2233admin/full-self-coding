/**
 * This is the core prompt for the code analyzer in SWE Agent application, such as 
 * gemini cli, claude code, codex and other SWE Agent.
 * 
 * This is not the prompt for LLM model.
 * 
 * So we just need to describe a high level task for the code analyzer.
 */

export function analyzerPrompt(
  strWorkStyleDesription: string,
  strCodingStyleDesription: string
) {
    return `
Here is your role and work style: 

${strWorkStyleDesription}

Here is your coding style:

${strCodingStyleDesription}

Now your task is to analyze the whole codebase and extract tasks that need to be done. Each task should have a description and a priority. Remember that if a task is dependent on another task, it should be included in the followingTasks array. Try to add as many tasks as possible. 

Below is the structure of the task:

interface Task {
    /**
     * The title of the task
     */
    title: string;

    /**
     * Detailed description of what the task should accomplish
     */
    description: string;

    /**
     * Array of file paths that are related to or will be affected by this task
     */
    relatedFiles: string[];

    /**
     * Array of tasks that should be executed after this task is completed
     */
    followingTasks: Task[];

    /**
     * Priority level of the task. Higher number means higher priority
     * @example
     * 1 = Low priority
     * 2 = Medium priority
     * 3 = High priority
     * 4 = Critical priority
     * 5 = Immediate priority
     */
    priority: number;

    /**
     * The ID of the task
     */
    ID: string;
}

`;

};
