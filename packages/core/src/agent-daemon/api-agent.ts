/**
 * FSC API Agent — 纯 TypeScript agent loop
 *
 * 通过 MiniClaw HTTP API 调用 LLM，在 bwrap 沙箱内执行工具。
 * 不依赖任何外部 CLI (claude/gemini/codex)。
 *
 * 数据流:
 *   task → buildPrompt → loop { callLLM → executeTool } → result
 */

import type { TaskPayload } from "./agent";
import type { SandboxConfig } from "./sandbox";
import { TOOLS, executeTool } from "./api-tools";
import { buildSystemPrompt, buildUserPrompt } from "./api-prompt";

// ─── 类型 ───

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ApiAgentConfig {
  /** MiniClaw API URL */
  miniClawUrl: string;
  /** LLM 模型名 */
  model: string;
  /** 最大循环轮数 */
  maxTurns: number;
  /** 单轮最大 token */
  maxTokensPerTurn: number;
  /** bwrap 沙箱配置 */
  sandboxConfig: SandboxConfig;
  /** 成本回调: 上报 token 用量，返回推荐模型和是否暂停 */
  costCallback?: (tokens: number) => Promise<{ model: string; paused: boolean }>;
}

// ─── 常量 ───

const CONTEXT_CHAR_LIMIT = 80_000; // ~27K tokens
const LLM_TIMEOUT_MS = 120_000;

// ─── 主函数 ───

export async function runApiAgent(
  task: TaskPayload,
  config: ApiAgentConfig,
): Promise<{ output: string; success: boolean }> {
  const messages: Message[] = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: buildUserPrompt(task) },
  ];

  let totalOutput = "";
  let model = config.model;

  for (let turn = 0; turn < config.maxTurns; turn++) {
    // 1. 成本检查
    if (config.costCallback) {
      const budget = await config.costCallback(0);
      if (budget.paused) {
        totalOutput += "\n[BUDGET EXHAUSTED — agent stopped]";
        return { output: totalOutput, success: false };
      }
      model = budget.model;
    }

    // 2. 调 LLM
    let response: any;
    try {
      response = await callLLM(config.miniClawUrl, {
        model,
        messages,
        tools: TOOLS,
        max_tokens: config.maxTokensPerTurn,
        temperature: 0,
      });
    } catch (e: any) {
      // LLM 调用失败 — 尝试 fallback 到无 tools 模式
      console.warn(`[api-agent] LLM call failed: ${e.message}, trying without tools`);
      try {
        response = await callLLM(config.miniClawUrl, {
          model,
          messages,
          max_tokens: config.maxTokensPerTurn,
          temperature: 0,
        });
      } catch (e2: any) {
        totalOutput += `\n[LLM ERROR: ${e2.message}]`;
        return { output: totalOutput, success: false };
      }
    }

    // 3. 成本上报
    if (config.costCallback && response.usage) {
      await config.costCallback(response.usage.total_tokens || 0);
    }

    const choice = response.choices?.[0];
    if (!choice) {
      totalOutput += "\n[LLM returned no choices]";
      return { output: totalOutput, success: false };
    }

    const assistantMsg = choice.message;
    messages.push(assistantMsg);

    // 4a. 文本 tool call 解析 (XML fallback)
    let toolCalls = assistantMsg.tool_calls;
    if ((!toolCalls || toolCalls.length === 0) && assistantMsg.content) {
      toolCalls = parseXmlToolCalls(assistantMsg.content);
    }

    // 4b. 无 tool calls → agent 完成
    if (!toolCalls || toolCalls.length === 0) {
      totalOutput += assistantMsg.content || "";
      const isFinish = choice.finish_reason === "stop" || !assistantMsg.content?.includes("<tool");
      if (isFinish) {
        return { output: totalOutput, success: true };
      }
      continue;
    }

    // 5. 执行 tool calls
    for (const tc of toolCalls) {
      let args: Record<string, any>;
      try {
        args = typeof tc.function.arguments === "string"
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments;
      } catch {
        args = { command: tc.function.arguments };
      }

      console.log(`[api-agent] turn=${turn} tool=${tc.function.name} args=${JSON.stringify(args).slice(0, 200)}`);

      const result = await executeTool(tc.function.name, args, config.sandboxConfig);

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result,
      });

      totalOutput += `[${tc.function.name}] ${result.slice(0, 300)}\n`;
    }

    // 6. 上下文窗口保护
    const contextSize = JSON.stringify(messages).length;
    if (contextSize > CONTEXT_CHAR_LIMIT) {
      // 保留 system + 最近 20 条消息
      const keep = 20;
      if (messages.length > keep + 1) {
        const removed = messages.splice(1, messages.length - keep - 1);
        messages.splice(1, 0, {
          role: "user",
          content: `[Context truncated — ${removed.length} messages removed. Continue from where you left off.]`,
        });
      }
    }
  }

  totalOutput += "\n[MAX TURNS REACHED]";
  return { output: totalOutput, success: false };
}

// ─── LLM HTTP 调用 ───

async function callLLM(baseUrl: string, body: any): Promise<any> {
  const url = `${baseUrl}/v1/chat/completions`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "(no body)");
    throw new Error(`LLM API ${resp.status}: ${text.slice(0, 500)}`);
  }

  return resp.json();
}

// ─── XML Fallback 解析 ───
// 廉价模型不支持 function calling 时，让模型输出 XML 格式的 tool calls:
// <tool name="bash"><command>ls -la</command></tool>
// <tool name="edit_file"><path>src/main.ts</path><search>old</search><replace>new</replace></tool>

function parseXmlToolCalls(content: string): ToolCall[] | null {
  const toolPattern = /<tool\s+name="(\w+)">([\s\S]*?)<\/tool>/g;
  const calls: ToolCall[] = [];
  let match;
  let callId = 0;

  while ((match = toolPattern.exec(content)) !== null) {
    const name = match[1];
    const body = match[2];
    const args: Record<string, string> = {};

    // 解析 <key>value</key> 对
    const paramPattern = /<(\w+)>([\s\S]*?)<\/\1>/g;
    let paramMatch;
    while ((paramMatch = paramPattern.exec(body)) !== null) {
      args[paramMatch[1]] = paramMatch[2];
    }

    calls.push({
      id: `xml-${callId++}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
  }

  return calls.length > 0 ? calls : null;
}
