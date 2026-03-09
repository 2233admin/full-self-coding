#!/usr/bin/env bun
/**
 * FSC Agent Daemon — 子节点常驻守护进程
 *
 * 替代旧的 worker.ts，核心升级:
 * 1. Agent Pool 复用 (不再每任务创建/销毁)
 * 2. bubblewrap 沙箱 (替代 Docker)
 * 3. 心跳 + 资源上报
 * 4. HTTP API 本地管理
 *
 * 数据流:
 *   中央 Scheduler → fsc:tasks:{NODE_ID} → XREADGROUP → Agent Pool → 执行 → fsc:results
 *
 * 环境变量:
 *   AGENT_ID      — 节点标识 (默认 hostname)
 *   MAX_AGENTS    — 最大并发 Agent 数 (默认 5)
 *   MIN_AGENTS    — 最小常驻 Agent 数 (默认 2)
 *   REDIS_URL     — Redis 连接串
 *   WORKSPACE     — 工作空间根目录 (默认 /workspace)
 *   SANDBOX       — 是否启用沙箱 (默认 true)
 *   API_PORT      — HTTP API 端口 (默认 18791)
 *   ANTHROPIC_API_KEY  — Claude API key
 *   GEMINI_API_KEY     — Gemini API key
 */

import { createClient, type RedisClientType } from "redis";
import { AgentPool, type PoolConfig } from "./pool";
import type { TaskPayload } from "./agent";

// ─── 配置 ───
const NODE_ID = Bun.env.AGENT_ID || (await getHostname());
const MAX_AGENTS = parseInt(Bun.env.MAX_AGENTS || "5");
const MIN_AGENTS = parseInt(Bun.env.MIN_AGENTS || "2");
const REDIS_URL = Bun.env.REDIS_URL || "redis://:fsc-mesh-2026@127.0.0.1:6379";
const WORKSPACE = Bun.env.WORKSPACE || "/workspace";
const ENABLE_SANDBOX = Bun.env.SANDBOX !== "false";
const API_PORT = parseInt(Bun.env.API_PORT || "18791");

const STREAM_KEY = `fsc:tasks:${NODE_ID}`; // 节点专属队列 (由中央 Scheduler 分发)
const RESULT_STREAM = "fsc:results";
const HEARTBEAT_KEY = "fsc:agents"; // HASH
const CONSUMER_GROUP = `fsc-worker-${NODE_ID}`; // 节点专属消费组
const DLQ_STREAM = "fsc:dlq";
const AFFINITY_KEY = `fsc:affinity:${NODE_ID}`; // HASH: module → score
const MEM_EVENTS_STREAM = "fsc:mem_events";
const AFFINITY_TTL_S = 3600; // 亲和度 1 小时过期
const BUDGET_KEY = "fsc:budget"; // CostController 预算状态

// ─── 主函数 ───

async function main() {
  console.log(`
╔══════════════════════════════════════╗
║   FSC Agent Daemon v2.0             ║
║   Node: ${NODE_ID.padEnd(28)}║
║   Agents: ${MIN_AGENTS}-${MAX_AGENTS} (sandbox=${ENABLE_SANDBOX})${" ".repeat(Math.max(0, 14 - String(MIN_AGENTS).length - String(MAX_AGENTS).length - String(ENABLE_SANDBOX).length))}║
╚══════════════════════════════════════╝
  `);

  // 1. 初始化工作空间
  await Bun.spawn(["mkdir", "-p", WORKSPACE]).exited;

  // 2. 连接 Redis
  const redis = createClient({ url: REDIS_URL }) as RedisClientType;
  redis.on("error", (err) => console.error("[redis]", err.message));
  await redis.connect();
  console.log("[daemon] Redis connected");

  // 确保 consumer group
  try {
    await redis.xGroupCreate(STREAM_KEY, CONSUMER_GROUP, "0", { MKSTREAM: true });
  } catch (e: any) {
    if (!e.message.includes("BUSYGROUP")) throw e;
  }

  // 2.5. 初始化预算 (如果不存在)
  const budgetExists = await redis.exists(BUDGET_KEY);
  if (!budgetExists) {
    await redis.hSet(BUDGET_KEY, {
      hourlySpent: "0", dailySpent: "0", monthlySpent: "0",
      hourlyLimit: "0.5", dailyLimit: "10", monthlyLimit: "200",
      currentModel: "doubao-seed-2.0-code", modelTier: "standard",
      lastResetHourly: String(Date.now()), lastResetDaily: String(Date.now()),
    });
    console.log("[daemon] Initialized fsc:budget");
  }

  // 3. 创建 Agent Pool
  const poolConfig: PoolConfig = {
    minAgents: MIN_AGENTS,
    maxAgents: MAX_AGENTS,
    workspaceRoot: WORKSPACE,
    enableSandbox: ENABLE_SANDBOX,
    allowNetwork: true,
    agentIdleTimeoutSeconds: 600,
    baseEnv: collectApiKeys(),
  };

  const pool = new AgentPool(poolConfig);
  await pool.start();

  // 4. 启动 HTTP API
  startHttpApi(pool, redis);

  // 5. 启动心跳
  const heartbeatInterval = startHeartbeat(pool, redis);

  // 6. 优雅退出
  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log("[daemon] Shutting down...");
    clearInterval(heartbeatInterval);
    await redis.hDel(HEARTBEAT_KEY, NODE_ID);
    await pool.shutdown();
    await redis.quit();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 7. 主循环: 拉取任务
  console.log("[daemon] Listening for tasks...");

  while (!isShuttingDown) {
    try {
      // 从节点专属队列拉取 (scheduler 已按产能分配，可一次拉多条)
      const stats = pool.getStats();
      const pullCount = Math.max(1, stats.idle);
      const messages = await redis.xReadGroup(
        CONSUMER_GROUP,
        NODE_ID,
        [{ key: STREAM_KEY, id: ">" }],
        { BLOCK: 5000, COUNT: pullCount },
      );

      if (!messages || messages.length === 0) continue;

      for (const stream of messages) {
        for (const { id: messageId, message } of stream.messages) {
          // 解析任务
          const task = parseTask(message);
          if (!task) {
            console.warn(`[daemon] Invalid task message: ${messageId}`);
            await redis.xAck(STREAM_KEY, CONSUMER_GROUP, messageId);
            continue;
          }

          // 注入成本控制: 从 fsc:budget 读取推荐模型
          const budgetModel = await getBudgetModel(redis);
          if (budgetModel === "none") {
            console.warn(`[daemon] Budget exhausted, skipping task ${task.id}`);
            await redis.xAdd(RESULT_STREAM, "*", {
              task_id: task.id, node_id: NODE_ID, status: "failure",
              output: "Budget exhausted (paused tier)", error: "BUDGET_PAUSED",
              git_diff: "", duration_ms: "0", failure_class: "PERMANENT",
              timestamp: String(Date.now()),
            });
            await redis.xAck(STREAM_KEY, CONSUMER_GROUP, messageId);
            continue;
          }
          if (!task.env) task.env = {};
          task.env.DEFAULT_MODEL = budgetModel;

          console.log(`[daemon] Received task ${task.id} → pool (model=${budgetModel})`);

          // 异步提交到 pool
          pool.submit(task).then(async (result) => {
            // 推送结果
            await redis.xAdd(RESULT_STREAM, "*", {
              task_id: result.taskId,
              agent_id: result.agentId,
              node_id: NODE_ID,
              status: result.status,
              output: result.output.slice(0, 5000),
              error: result.error.slice(0, 2000),
              git_diff: result.gitDiff.slice(0, 10000),
              duration_ms: String(result.durationMs),
              failure_class: result.failureClass,
              timestamp: String(result.timestamp),
            });

            // 写入亲和度 + 记忆事件
            await updateAffinity(redis, task, result);

            // 上报成本 (粗估: output 长度 / 3 ≈ tokens, 用 doubao 费率)
            await reportCost(redis, task, result);

            await redis.xAck(STREAM_KEY, CONSUMER_GROUP, messageId);
            console.log(`[daemon] Task ${task.id} done: ${result.status} (${result.durationMs}ms)`);
          }).catch(async (error) => {
            console.error(`[daemon] Task ${task.id} failed:`, error.message);
            // DLQ
            await redis.xAdd(DLQ_STREAM, "*", {
              task_id: task.id,
              node_id: NODE_ID,
              message_id: messageId,
              error: error.message,
              timestamp: String(Date.now()),
            });
            await redis.xAck(STREAM_KEY, CONSUMER_GROUP, messageId);
          });
        }
      }
    } catch (e: any) {
      if (!isShuttingDown) {
        console.error("[daemon] Loop error:", e.message);
        await Bun.sleep(2000);
      }
    }
  }
}

// ─── 任务解析 ───

function parseTask(message: Record<string, string>): TaskPayload | null {
  try {
    // 支持两种格式: 直接字段 或 JSON task 字段
    if (message.task) {
      const parsed = JSON.parse(message.task);
      return {
        id: parsed.id || parsed.ID || `task-${Date.now()}`,
        title: parsed.title,
        description: parsed.description,
        gitUrl: parsed.gitUrl || parsed.git_url,
        branch: parsed.branch,
        commands: parsed.commands,
        agentType: parsed.agentType || parsed.agent_type,
        apiKey: parsed.apiKey || parsed.api_key,
        timeoutSeconds: parsed.timeoutSeconds || parsed.timeout_seconds,
        env: parsed.env,
      };
    }

    // 直接字段模式 (DistributedScheduler 格式)
    return {
      id: message.task_id || `task-${Date.now()}`,
      title: message.title,
      description: message.description,
      gitUrl: message.gitUrl || message.git_url,
      branch: message.branch,
      commands: message.commands ? JSON.parse(message.commands) : undefined,
      agentType: (message.agentType || message.agent_type as any) || undefined,
      apiKey: message.apiKey || message.api_key,
      timeoutSeconds: message.timeoutSeconds
        ? parseInt(message.timeoutSeconds)
        : message.max_execution_time_ms
          ? Math.ceil(parseInt(message.max_execution_time_ms) / 1000)
          : undefined,
    };
  } catch {
    return null;
  }
}

// ─── 心跳 ───

function startHeartbeat(pool: AgentPool, redis: RedisClientType): ReturnType<typeof setInterval> {
  const update = async () => {
    try {
      const stats = pool.getStats();
      const memInfo = await Bun.file("/proc/meminfo").text().catch(() => "");
      const memTotal = parseInt(memInfo.match(/MemTotal:\s+(\d+)/)?.[1] || "0");
      const memAvail = parseInt(memInfo.match(/MemAvailable:\s+(\d+)/)?.[1] || "0");

      const heartbeat = JSON.stringify({
        node_id: NODE_ID,
        type: "agent-daemon-v2",
        sandbox: ENABLE_SANDBOX,
        agents: stats,
        memory: {
          total_mb: Math.round(memTotal / 1024),
          available_mb: Math.round(memAvail / 1024),
          used_pct: memTotal > 0 ? Math.round((1 - memAvail / memTotal) * 100) : 0,
        },
        uptime_s: Math.round(process.uptime()),
        timestamp: Date.now(),
      });

      await redis.hSet(HEARTBEAT_KEY, NODE_ID, heartbeat);
      // 60s TTL 防止僵尸节点
      // (HASH 字段无法设 TTL，用 EXPIRE 在整个 key 上不合适，改用 timestamp 判断)
    } catch {}
  };

  update(); // 立即执行一次
  return setInterval(update, 15000);
}

// ─── HTTP API ───

function startHttpApi(pool: AgentPool, redis: RedisClientType): void {
  Bun.serve({
    port: API_PORT,
    async fetch(req) {
      const url = new URL(req.url);

      // GET /health
      if (url.pathname === "/health") {
        const stats = pool.getStats();
        return Response.json({
          status: "ok",
          node_id: NODE_ID,
          sandbox: ENABLE_SANDBOX,
          agents: stats,
          uptime_s: Math.round(process.uptime()),
        });
      }

      // GET /stats
      if (url.pathname === "/stats") {
        return Response.json(pool.getStats());
      }

      // POST /submit — 直接提交任务 (绕过 Redis，用于调试)
      if (url.pathname === "/submit" && req.method === "POST") {
        try {
          const task = await req.json() as TaskPayload;
          if (!task.id) task.id = `local-${Date.now()}`;
          const result = await pool.submit(task);
          return Response.json(result);
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 400 });
        }
      }

      // GET /nodes — 查看所有注册节点
      if (url.pathname === "/nodes") {
        try {
          const all = await redis.hGetAll(HEARTBEAT_KEY);
          const nodes = Object.entries(all).map(([id, json]) => {
            try { return { id, ...JSON.parse(json) }; }
            catch { return { id, raw: json }; }
          });
          return Response.json(nodes);
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500 });
        }
      }

      return new Response("Not found", { status: 404 });
    },
  });

  console.log(`[daemon] HTTP API listening on :${API_PORT}`);
}

// ─── 成本控制 ───

// 模型费率表 ($/token)
const MODEL_COST: Record<string, number> = {
  "claude-sonnet-4": 0.003,
  "doubao-seed-2.0-code": 0.0003,
  "minimax-2.5": 0.0001,
  "openrouter/free": 0,
};

/** 上报任务成本到 fsc:budget */
async function reportCost(
  redis: RedisClientType,
  task: TaskPayload,
  result: import("./agent").TaskResult,
): Promise<void> {
  try {
    const model = task.env?.DEFAULT_MODEL || "doubao-seed-2.0-code";
    const rate = MODEL_COST[model] || 0.0003;
    const estimatedTokens = Math.round(result.output.length / 3);
    const cost = estimatedTokens * rate;
    if (cost > 0) {
      await redis.hIncrByFloat(BUDGET_KEY, "hourlySpent", cost);
      await redis.hIncrByFloat(BUDGET_KEY, "dailySpent", cost);
      await redis.hIncrByFloat(BUDGET_KEY, "monthlySpent", cost);
    }
  } catch {}
}

/** 从 Redis fsc:budget 读取当前推荐模型 (CostController 写入) */
async function getBudgetModel(redis: RedisClientType): Promise<string> {
  try {
    const data = await redis.hmGet(BUDGET_KEY, ["modelTier", "currentModel"]);
    const tier = data[0] || "standard";
    const model = data[1] || "doubao-seed-2.0-code";
    if (tier === "paused") return "none";
    return model;
  } catch {
    return "doubao-seed-2.0-code"; // Redis 不可达时用默认模型
  }
}

// ─── 亲和度 + 记忆回流 ───

/**
 * 从 git diff 提取涉及的模块路径 (取前两级目录)
 * e.g. "src/auth/login.ts" → "src/auth"
 */
function extractModules(gitDiff: string): string[] {
  const modules = new Set<string>();
  const filePattern = /^(?:diff --git a\/|[+-]{3} [ab]\/)(.+)/gm;
  let match;
  while ((match = filePattern.exec(gitDiff)) !== null) {
    const path = match[1];
    const parts = path.split("/");
    if (parts.length >= 2) {
      modules.add(parts.slice(0, 2).join("/"));
    } else {
      modules.add(parts[0]);
    }
  }
  return [...modules];
}

/**
 * 任务完成后:
 * 1. 更新 fsc:affinity:{node_id} — 模块亲和度 (成功+2, 失败-1)
 * 2. 发布 fsc:mem_events — 执行知识回流到 MemoV
 */
async function updateAffinity(
  redis: RedisClientType,
  task: TaskPayload,
  result: import("./agent").TaskResult,
): Promise<void> {
  try {
    const modules = extractModules(result.gitDiff);
    const delta = result.status === "success" ? 2 : -1;

    // 批量更新亲和度分数
    for (const mod of modules) {
      await redis.hIncrBy(AFFINITY_KEY, mod, delta);
    }
    // 刷新 TTL
    if (modules.length > 0) {
      await redis.expire(AFFINITY_KEY, AFFINITY_TTL_S);
    }

    // 发布记忆事件 (MemoV Sync Daemon 消费)
    await redis.xAdd(MEM_EVENTS_STREAM, "*", {
      type: "task_completed",
      node_id: NODE_ID,
      task_id: result.taskId,
      status: result.status,
      modules: JSON.stringify(modules),
      duration_ms: String(result.durationMs),
      diff_size: String(result.gitDiff.length),
      timestamp: String(Date.now()),
    });
  } catch (e: any) {
    // 亲和度写入失败不应阻塞主流程
    console.warn(`[daemon] Affinity update failed: ${e.message}`);
  }
}

// ─── 工具函数 ───

function collectApiKeys(): Record<string, string> {
  const env: Record<string, string> = {};
  if (Bun.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = Bun.env.ANTHROPIC_API_KEY;
  if (Bun.env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = Bun.env.ANTHROPIC_BASE_URL;
  if (Bun.env.GEMINI_API_KEY) env.GEMINI_API_KEY = Bun.env.GEMINI_API_KEY;
  if (Bun.env.OPENAI_API_KEY) env.OPENAI_API_KEY = Bun.env.OPENAI_API_KEY;
  return env;
}

async function getHostname(): Promise<string> {
  try {
    const proc = Bun.spawn(["hostname"], { stdout: "pipe" });
    const name = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return name || "unknown";
  } catch {
    return "unknown";
  }
}

// ─── 启动 ───

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
