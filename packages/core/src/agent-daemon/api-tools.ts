/**
 * FSC API Agent — 工具定义 + 沙箱执行器
 *
 * 6 个工具，全部在 bwrap 沙箱内执行。
 * 使用 OpenAI function calling 格式。
 */

import { execInSandbox, type SandboxConfig } from "./sandbox";

// ─── OpenAI Function 定义 ───

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export const TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command in /workspace/repo. Use for builds, tests, git, ls, etc.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read file contents with line numbers.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to /workspace/repo" },
          offset: { type: "number", description: "Start line (1-indexed)" },
          limit: { type: "number", description: "Max lines to read" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file with the given content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to /workspace/repo" },
          content: { type: "string", description: "Full file content" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace exact text in a file. SEARCH must match file content exactly (including whitespace).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to /workspace/repo" },
          search: { type: "string", description: "Exact text to find in the file" },
          replace: { type: "string", description: "Text to replace it with" },
        },
        required: ["path", "search", "replace"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search for a regex pattern in files. Returns matching lines with file paths and line numbers.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern" },
          path: { type: "string", description: "Directory or file to search (default: /workspace/repo)" },
          include: { type: "string", description: "File glob filter, e.g. '*.ts'" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files matching a glob pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern, e.g. '*.ts' or 'src/**/*.py'" },
          path: { type: "string", description: "Base directory (default: /workspace/repo)" },
        },
        required: ["pattern"],
      },
    },
  },
];

// ─── 工具执行器 ───

const MAX_OUTPUT = 8000; // 单个工具输出上限 (chars)
const REPO_DIR = "/workspace/repo";

function truncate(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 50) + `\n...[truncated, ${s.length} chars total]`;
}

function resolvePath(path: string): string {
  if (path.startsWith("/")) return path;
  return `${REPO_DIR}/${path}`;
}

export async function executeTool(
  name: string,
  args: Record<string, any>,
  sandboxConfig: SandboxConfig,
): Promise<string> {
  try {
    switch (name) {
      case "bash":
        return await toolBash(args.command, sandboxConfig);
      case "read_file":
        return await toolReadFile(args.path, args.offset, args.limit, sandboxConfig);
      case "write_file":
        return await toolWriteFile(args.path, args.content, sandboxConfig);
      case "edit_file":
        return await toolEditFile(args.path, args.search, args.replace, sandboxConfig);
      case "grep":
        return await toolGrep(args.pattern, args.path, args.include, sandboxConfig);
      case "glob":
        return await toolGlob(args.pattern, args.path, sandboxConfig);
      default:
        return `ERROR: Unknown tool "${name}"`;
    }
  } catch (e: any) {
    return `ERROR: ${e.message}`;
  }
}

// 危险命令过滤 (防止 LLM 破坏 git 配置)
const BLOCKED_PATTERNS = [/\bgit\s+init\b/, /\bgit\s+clone\b/, /\brm\s+-rf\s+\.git\b/];

async function toolBash(command: string, cfg: SandboxConfig): Promise<string> {
  for (const pat of BLOCKED_PATTERNS) {
    if (pat.test(command)) {
      return `ERROR: "${command.match(pat)?.[0]}" is blocked. The repo is already set up at /workspace/repo/ — just use "git add", "git commit", "git push".`;
    }
  }
  const cmd = `cd ${REPO_DIR} 2>/dev/null; ${command}`;
  const { output, exitCode } = await execInSandbox(cmd, cfg);
  const prefix = exitCode === 0 ? "" : `[exit code ${exitCode}]\n`;
  return truncate(prefix + output);
}

async function toolReadFile(
  path: string, offset?: number, limit?: number, cfg?: SandboxConfig,
): Promise<string> {
  const p = resolvePath(path);
  let cmd: string;
  if (offset && limit) {
    cmd = `sed -n '${offset},${offset + limit - 1}p' '${p}' | cat -n`;
  } else if (limit) {
    cmd = `head -n ${limit} '${p}' | cat -n`;
  } else {
    cmd = `cat -n '${p}'`;
  }
  const { output, success } = await execInSandbox(cmd, cfg!);
  if (!success) return `ERROR: Could not read ${path}\n${output}`;
  return truncate(output);
}

async function toolWriteFile(
  path: string, content: string, cfg: SandboxConfig,
): Promise<string> {
  const p = resolvePath(path);
  const dir = p.substring(0, p.lastIndexOf("/"));
  // 用 stdin pipe 写入，避免 shell 转义
  const cmd = `mkdir -p '${dir}' && cat > '${p}'`;
  const { success, output } = await execInSandbox(cmd, cfg, content);
  if (!success) return `ERROR: Failed to write ${path}\n${output}`;
  return `OK: wrote ${path} (${content.length} chars)`;
}

async function toolEditFile(
  path: string, search: string, replace: string, cfg: SandboxConfig,
): Promise<string> {
  const p = resolvePath(path);
  // python3 精确替换，search 和 replace 用 \x00 分隔通过 stdin 传入
  const pyScript = `
import sys
path = sys.argv[1]
data = sys.stdin.read()
parts = data.split('\\x00')
old, new = parts[0], parts[1] if len(parts) > 1 else ''
with open(path) as f: content = f.read()
count = content.count(old)
if count == 0:
    print(f'ERROR: search text not found in {path}')
    sys.exit(1)
if count > 1:
    print(f'WARNING: {count} matches found, replacing first occurrence')
content = content.replace(old, new, 1)
with open(path, 'w') as f: f.write(content)
print(f'OK: edited {path}')
`.trim();
  const cmd = `python3 -c '${pyScript.replace(/'/g, "'\\''")}' '${p}'`;
  const stdin = search + "\x00" + replace;
  const { output, success } = await execInSandbox(cmd, cfg, stdin);
  if (!success) return `ERROR: edit failed\n${output}`;
  return output.trim();
}

async function toolGrep(
  pattern: string, path?: string, include?: string, cfg?: SandboxConfig,
): Promise<string> {
  const p = path ? resolvePath(path) : REPO_DIR;
  let cmd = `grep -rn '${pattern.replace(/'/g, "'\\''")}' '${p}'`;
  if (include) cmd += ` --include='${include}'`;
  cmd += " | head -100";
  const { output } = await execInSandbox(cmd, cfg!);
  return truncate(output || "(no matches)");
}

async function toolGlob(
  pattern: string, path?: string, cfg?: SandboxConfig,
): Promise<string> {
  const p = path ? resolvePath(path) : REPO_DIR;
  const cmd = `find '${p}' -name '${pattern.replace(/'/g, "'\\''")}' -type f | head -200`;
  const { output } = await execInSandbox(cmd, cfg!);
  return truncate(output || "(no files found)");
}
