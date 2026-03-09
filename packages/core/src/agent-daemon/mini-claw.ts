#!/usr/bin/env bun
/**
 * MiniClaw — 子节点轻量 LLM API 代理
 *
 * OpenAI 兼容 API 接口，多供应商路由 + 熔断 + 限流
 * Agent 设 ANTHROPIC_BASE_URL=http://127.0.0.1:18795 即可
 *
 * 路由策略:
 *   model 前缀匹配供应商 → 对应 baseUrl + apiKey
 *   无前缀 → 按优先级轮询可用供应商
 *
 * 环境变量:
 *   PORT             — 监听端口 (默认 18795)
 *   MAX_CONCURRENT   — 最大并发 (默认 8)
 *   PROVIDERS_JSON   — 供应商配置 JSON 文件路径 (默认 /opt/fsc-agent-daemon/providers.json)
 */

const PORT = parseInt(Bun.env.PORT || "18795");
const MAX_CONCURRENT = parseInt(Bun.env.MAX_CONCURRENT || "8");
const PROVIDERS_PATH = Bun.env.PROVIDERS_JSON || "/opt/fsc-agent-daemon/providers.json";

// --- 供应商配置 ---
interface Provider {
  name: string;
  baseUrl: string;
  apiKey: string;
  api: "openai" | "anthropic-messages";
  models: string[];     // 支持的模型 ID
  priority: number;     // 越小越优先
  maxRetries: number;
}

interface ProviderState {
  provider: Provider;
  fails: number;
  openUntil: number;    // 熔断恢复时间
}

let providers: ProviderState[] = [];

async function loadProviders() {
  try {
    const raw = await Bun.file(PROVIDERS_PATH).json();
    providers = (raw as Provider[]).map((p) => ({
      provider: { ...p, maxRetries: p.maxRetries || 2 },
      fails: 0,
      openUntil: 0,
    }));
    providers.sort((a, b) => a.provider.priority - b.provider.priority);
    console.log(`[mini-claw] loaded ${providers.length} providers: ${providers.map(p => p.provider.name).join(", ")}`);
  } catch (e: any) {
    console.error(`[mini-claw] failed to load providers: ${e.message}`);
    providers = [];
  }
}

// --- 熔断器 ---
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30_000;

function isAvailable(s: ProviderState): boolean {
  if (s.fails < BREAKER_THRESHOLD) return true;
  if (Date.now() > s.openUntil) {
    s.fails = BREAKER_THRESHOLD - 1; // half-open
    return true;
  }
  return false;
}

function recordSuccess(s: ProviderState) { s.fails = 0; }
function recordFailure(s: ProviderState) {
  s.fails++;
  if (s.fails >= BREAKER_THRESHOLD) {
    s.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    console.warn(`[breaker] ${s.provider.name} tripped for ${BREAKER_COOLDOWN_MS / 1000}s`);
  }
}

// --- 并发限流 ---
let inflight = 0;
const waitQueue: (() => void)[] = [];

async function acquireSlot(): Promise<void> {
  if (inflight < MAX_CONCURRENT) { inflight++; return; }
  return new Promise((resolve) => {
    waitQueue.push(() => { inflight++; resolve(); });
  });
}

function releaseSlot() {
  inflight--;
  const next = waitQueue.shift();
  if (next) next();
}

// --- 路由 ---
function findProviders(model: string): ProviderState[] {
  // 1. 前缀匹配: "volcengine/doubao-xxx" → volcengine 供应商
  const slash = model.indexOf("/");
  if (slash > 0) {
    const prefix = model.substring(0, slash);
    const matched = providers.filter(
      (s) => s.provider.name === prefix && isAvailable(s)
    );
    if (matched.length > 0) return matched;
  }

  // 2. 模型名匹配
  const byModel = providers.filter(
    (s) => s.provider.models.some((m) => model.includes(m) || m.includes(model)) && isAvailable(s)
  );
  if (byModel.length > 0) return byModel;

  // 3. 全部可用供应商 (按优先级)
  return providers.filter((s) => isAvailable(s));
}

// --- 请求转发 ---
async function forwardRequest(req: Request): Promise<Response> {
  const body = await req.arrayBuffer();
  let parsed: any;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const model = parsed.model || "";
  const candidates = findProviders(model);

  if (candidates.length === 0) {
    return Response.json({ error: `no available provider for model: ${model}` }, { status: 503 });
  }

  for (const state of candidates) {
    const p = state.provider;
    // Strip MiniClaw provider prefix, but preserve model's own namespace
    // e.g. "nvidia-nim/deepseek-ai/deepseek-v3.2" → "deepseek-ai/deepseek-v3.2"
    //      "volcengine/doubao-seed-2.0-code" → "doubao-seed-2.0-code"
    let bareModel = model;
    if (model.startsWith(p.name + "/")) {
      bareModel = model.substring(p.name.length + 1);
    } else {
      const slash = model.indexOf("/");
      if (slash > 0) bareModel = model.substring(slash + 1);
    }
    const reqBody = { ...parsed, model: bareModel };

    // 构建目标 URL
    const url = new URL(req.url);
    const targetPath = url.pathname; // /v1/chat/completions or /v1/messages
    const targetUrl = `${p.baseUrl.replace(/\/$/, "")}${targetPath}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (p.api === "anthropic-messages") {
      headers["x-api-key"] = p.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["Authorization"] = `Bearer ${p.apiKey}`;
    }

    for (let attempt = 0; attempt <= p.maxRetries; attempt++) {
      try {
        const resp = await fetch(targetUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(reqBody),
          signal: AbortSignal.timeout(120_000),
        });

        if (resp.ok) {
          recordSuccess(state);
          // 流式透传
          return new Response(resp.body, {
            status: resp.status,
            headers: {
              "Content-Type": resp.headers.get("Content-Type") || "application/json",
              "X-MiniClaw-Provider": p.name,
            },
          });
        }

        // 4xx 不重试 (客户端错误)
        if (resp.status < 500) {
          const errBody = await resp.text();
          return new Response(errBody, {
            status: resp.status,
            headers: { "Content-Type": "application/json", "X-MiniClaw-Provider": p.name },
          });
        }

        // 5xx 重试
        console.warn(`[proxy] ${p.name} returned ${resp.status}, attempt ${attempt + 1}/${p.maxRetries + 1}`);
      } catch (e: any) {
        console.warn(`[proxy] ${p.name} error: ${e.message}, attempt ${attempt + 1}/${p.maxRetries + 1}`);
      }
    }

    recordFailure(state);
    console.warn(`[proxy] ${p.name} exhausted retries, trying next provider`);
  }

  return Response.json({ error: "all providers exhausted" }, { status: 502 });
}

// --- HTTP 服务 ---
await loadProviders();

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        type: "mini-claw",
        providers: providers.map((s) => ({
          name: s.provider.name,
          available: isAvailable(s),
          fails: s.fails,
          models: s.provider.models,
        })),
        inflight,
        queued: waitQueue.length,
      });
    }

    if (url.pathname === "/reload") {
      await loadProviders();
      return Response.json({ status: "reloaded", count: providers.length });
    }

    // OpenAI / Anthropic 兼容端点
    if (req.method === "POST" && (
      url.pathname === "/v1/chat/completions" ||
      url.pathname === "/v1/messages" ||
      url.pathname === "/chat/completions"
    )) {
      await acquireSlot();
      try {
        return await forwardRequest(req);
      } finally {
        releaseSlot();
      }
    }

    // GET /v1/models — 返回所有配置的模型
    if (url.pathname === "/v1/models") {
      const models = providers.flatMap((s) =>
        s.provider.models.map((m) => ({
          id: `${s.provider.name}/${m}`,
          object: "model",
          owned_by: s.provider.name,
        }))
      );
      return Response.json({ object: "list", data: models });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
});

console.log(`[mini-claw] listening on :${PORT} (max_concurrent=${MAX_CONCURRENT})`);
