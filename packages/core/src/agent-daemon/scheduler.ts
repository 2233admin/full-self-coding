#!/usr/bin/env bun
/**
 * FSC Task Scheduler v1.3 — 中央调度器 + HTTP API
 *
 * 数据流:
 *   HTTP POST /submit → fsc:tasks → Scheduler → fsc:tasks:{node_id} → Daemon
 *
 * 调度策略:
 *   1. 读取 fsc:agents HASH 获取各节点心跳
 *   2. effective idle = heartbeat idle - scheduler pending
 *   3. 按 effIdle * (1 + 0.3 * affinity) 加权选节点
 *   4. 内存不足 / 心跳过期的节点跳过
 *
 * HTTP API (port 18800):
 *   POST /submit        — 提交任务
 *   GET  /status        — 集群概览
 *   GET  /nodes         — 节点详情
 *   GET  /results       — 最近结果
 *   GET  /results/:id   — 特定任务结果
 *   GET  /health        — 健康检查
 */

import { createClient, type RedisClientType } from "redis";

const REDIS_URL = Bun.env.REDIS_URL || "redis://:fsc-mesh-2026@127.0.0.1:6379";
const POLL_INTERVAL = parseInt(Bun.env.POLL_INTERVAL || "1000");
const MEMORY_FLOOR_MB = parseInt(Bun.env.MEMORY_FLOOR_MB || "300");
const API_PORT = parseInt(Bun.env.API_PORT || "18800");
const HEARTBEAT_STALE_S = 60;
const AFFINITY_WEIGHT = 0.3;

const TASK_STREAM = "fsc:tasks";
const RESULT_STREAM = "fsc:results";
const HEARTBEAT_KEY = "fsc:agents";
const SCHEDULER_GROUP = "fsc-scheduler";
const SCHEDULER_CONSUMER = "scheduler-0";

interface NodeStatus {
  node_id: string;
  idle: number;
  busy: number;
  total: number;
  memory_available_mb: number;
  timestamp: number;
}

const pendingByNode = new Map<string, number>();
let totalDistributed = 0;
const startedAt = Date.now();

function getEffectiveIdle(node: NodeStatus): number {
  const pending = pendingByNode.get(node.node_id) || 0;
  return Math.max(0, node.idle - pending);
}

async function main() {
  console.log(`
╔══════════════════════════════════════╗
║   FSC Task Scheduler v1.3           ║
║   产能 + 亲和度 + HTTP API          ║
╚══════════════════════════════════════╝
  `);

  const redis = createClient({ url: REDIS_URL }) as RedisClientType;
  redis.on("error", (err) => console.error("[redis]", err.message));
  await redis.connect();
  console.log("[scheduler] Redis connected");

  try {
    await redis.xGroupCreate(TASK_STREAM, SCHEDULER_GROUP, "0", { MKSTREAM: true });
  } catch (e: any) {
    if (!e.message.includes("BUSYGROUP")) throw e;
  }

  startHttpApi(redis);
  console.log(`[scheduler] Listening on ${TASK_STREAM}, poll=${POLL_INTERVAL}ms`);

  // pending 衰减
  setInterval(() => {
    for (const [nodeId, count] of pendingByNode) {
      if (count > 0) pendingByNode.set(nodeId, Math.floor(count / 2));
      else pendingByNode.delete(nodeId);
    }
  }, 5000);

  // 主调度循环
  while (true) {
    try {
      const nodes = await getNodeStatuses(redis);
      const available = nodes.filter(
        (n) => getEffectiveIdle(n) > 0 && n.memory_available_mb > MEMORY_FLOOR_MB
      );

      if (available.length === 0) {
        await Bun.sleep(POLL_INTERVAL);
        continue;
      }

      const totalEffIdle = available.reduce((s, n) => s + getEffectiveIdle(n), 0);
      const messages = await redis.xReadGroup(
        SCHEDULER_GROUP, SCHEDULER_CONSUMER,
        [{ key: TASK_STREAM, id: ">" }],
        { BLOCK: POLL_INTERVAL, COUNT: Math.min(totalEffIdle, 10) },
      );

      if (!messages || messages.length === 0) continue;

      for (const stream of messages) {
        for (const { id: messageId, message } of stream.messages) {
          const taskModules = extractTaskModules(message);
          const node = await pickNode(available, redis, taskModules);
          if (!node) continue;

          const nodeQueue = `${TASK_STREAM}:${node.node_id}`;
          await redis.xAdd(nodeQueue, "*", message);
          await redis.xAck(TASK_STREAM, SCHEDULER_GROUP, messageId);

          pendingByNode.set(node.node_id, (pendingByNode.get(node.node_id) || 0) + 1);
          totalDistributed++;

          const taskName = message.task
            ? (() => { try { return JSON.parse(message.task as string).id; } catch { return messageId; } })()
            : message.task_id || messageId;
          console.log(
            `[scheduler] ${taskName} → ${node.node_id}` +
            ` (eff=${getEffectiveIdle(node)}, pending=${pendingByNode.get(node.node_id)})` +
            ` [total=${totalDistributed}]`
          );
        }
      }
    } catch (e: any) {
      console.error("[scheduler] Error:", e.message);
      await Bun.sleep(2000);
    }
  }
}

// ─── HTTP API ───

function startHttpApi(redis: RedisClientType): void {
  const cors = { "Access-Control-Allow-Origin": "*" };

  Bun.serve({
    port: API_PORT,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "OPTIONS") {
        return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "Content-Type" } });
      }

      try {
        if (url.pathname === "/submit" && req.method === "POST") {
          const body = await req.json() as Record<string, any>;
          const taskId = body.id || `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const task = {
            id: taskId,
            title: body.title || body.description?.slice(0, 60) || taskId,
            description: body.description || "",
            gitUrl: body.gitUrl || body.git_url || "",
            branch: body.branch || "",
            agentType: body.agentType || "api",
            timeoutSeconds: body.timeoutSeconds || 300,
          };
          const streamId = await redis.xAdd(TASK_STREAM, "*", { task: JSON.stringify(task) });
          console.log(`[api] Task submitted: ${taskId} (${streamId})`);
          return Response.json({ ok: true, taskId, streamId }, { status: 201, headers: cors });
        }

        if (url.pathname === "/status") {
          const nodes = await getNodeStatuses(redis);
          const taskLen = await redis.xLen(TASK_STREAM).catch(() => 0);
          const resultLen = await redis.xLen(RESULT_STREAM).catch(() => 0);
          const nodeQueues: Record<string, number> = {};
          for (const n of nodes) {
            nodeQueues[n.node_id] = await redis.xLen(`${TASK_STREAM}:${n.node_id}`).catch(() => 0);
          }
          return Response.json({
            scheduler: { version: "1.3", uptime_s: Math.round((Date.now() - startedAt) / 1000), distributed: totalDistributed },
            cluster: {
              nodes: nodes.length,
              total_idle: nodes.reduce((s, n) => s + n.idle, 0),
              total_busy: nodes.reduce((s, n) => s + n.busy, 0),
            },
            queues: { pending_tasks: taskLen, total_results: resultLen, node_queues: nodeQueues },
            nodes: nodes.map((n) => ({
              id: n.node_id, idle: n.idle, busy: n.busy,
              effective_idle: getEffectiveIdle(n),
              memory_mb: n.memory_available_mb,
              age_s: Math.round((Date.now() - n.timestamp) / 1000),
            })),
          }, { headers: cors });
        }

        if (url.pathname === "/nodes") {
          const all = await redis.hGetAll(HEARTBEAT_KEY);
          const nodes = Object.entries(all).map(([id, json]) => {
            try { return { id, ...JSON.parse(json) }; } catch { return { id, raw: json }; }
          });
          return Response.json(nodes, { headers: cors });
        }

        if (url.pathname === "/results") {
          const count = parseInt(url.searchParams.get("count") || "20");
          const results = await redis.xRevRange(RESULT_STREAM, "+", "-", { COUNT: Math.min(count, 100) });
          return Response.json(results.map(({ id, message }) => ({
            streamId: id, taskId: message.task_id, nodeId: message.node_id,
            status: message.status, durationMs: parseInt(message.duration_ms || "0"),
            failureClass: message.failure_class, error: message.error?.slice(0, 200),
            timestamp: parseInt(message.timestamp || "0"),
          })), { headers: cors });
        }

        if (url.pathname.startsWith("/results/")) {
          const taskId = url.pathname.slice("/results/".length);
          const results = await redis.xRevRange(RESULT_STREAM, "+", "-", { COUNT: 200 });
          const match = results.find(({ message }) => message.task_id === taskId);
          if (!match) return Response.json({ error: "Not found" }, { status: 404, headers: cors });
          return Response.json({ streamId: match.id, ...match.message }, { headers: cors });
        }

        if (url.pathname === "/health") {
          return Response.json({
            status: "ok", version: "1.3",
            uptime_s: Math.round((Date.now() - startedAt) / 1000),
            distributed: totalDistributed,
          }, { headers: cors });
        }

        if (url.pathname === "/") {
          return new Response(DASHBOARD_HTML, { headers: { ...cors, "Content-Type": "text/html; charset=utf-8" } });
        }

        return new Response("Not found", { status: 404, headers: cors });
      } catch (e: any) {
        return Response.json({ error: e.message }, { status: 500, headers: cors });
      }
    },
  });

  console.log(`[scheduler] HTTP API on :${API_PORT}`);
}

// ─── 节点状态 ───

async function getNodeStatuses(redis: RedisClientType): Promise<NodeStatus[]> {
  const all = await redis.hGetAll(HEARTBEAT_KEY);
  const now = Date.now();
  const nodes: NodeStatus[] = [];
  for (const [id, json] of Object.entries(all)) {
    try {
      const data = JSON.parse(json);
      if ((now - data.timestamp) / 1000 > HEARTBEAT_STALE_S) continue;
      nodes.push({
        node_id: id,
        idle: data.agents?.idle ?? 0,
        busy: data.agents?.busy ?? 0,
        total: data.agents?.total ?? 0,
        memory_available_mb: data.memory?.available_mb ?? 0,
        timestamp: data.timestamp,
      });
    } catch {}
  }
  return nodes;
}

// ─── 任务模块提取 ───

function extractTaskModules(message: Record<string, string>): string[] {
  try {
    if (message.task) {
      const parsed = JSON.parse(message.task as string);
      const pathPattern = /(?:^|\s|\/)((?:src|lib|packages|app|components|modules|services)\/[a-zA-Z0-9_-]+)/g;
      const modules = new Set<string>();
      for (const text of [parsed.title || "", parsed.description || ""]) {
        let match;
        while ((match = pathPattern.exec(text)) !== null) modules.add(match[1]);
      }
      return [...modules];
    }
  } catch {}
  return [];
}

// ─── 节点选择 ───

async function pickNode(
  nodes: NodeStatus[], redis: RedisClientType, taskModules: string[],
): Promise<NodeStatus | null> {
  let best: NodeStatus | null = null;
  let bestScore = 0;
  const affinityScores = new Map<string, number>();

  if (taskModules.length > 0) {
    await Promise.all(nodes.map(async (n) => {
      try {
        const affinityKey = `fsc:affinity:${n.node_id}`;
        let total = 0;
        for (const mod of taskModules) {
          const val = await redis.hGet(affinityKey, mod);
          if (val) total += parseInt(val);
        }
        if (total > 0) affinityScores.set(n.node_id, total);
      } catch {}
    }));
  }

  const maxAffinity = Math.max(1, ...affinityScores.values());

  for (const n of nodes) {
    const effIdle = getEffectiveIdle(n);
    if (effIdle <= 0 || n.memory_available_mb < MEMORY_FLOOR_MB) continue;
    const affinityNorm = (affinityScores.get(n.node_id) || 0) / maxAffinity;
    const score = effIdle * (1 + AFFINITY_WEIGHT * affinityNorm);
    if (!best || score > bestScore) { best = n; bestScore = score; }
  }
  return best;
}

// ─── Dashboard HTML ───

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FSC Scheduler Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d1117;color:#c9d1d9;padding:20px}
h1{color:#58a6ff;margin-bottom:20px;font-size:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-bottom:24px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px}
.card h3{color:#8b949e;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
.metric{font-size:36px;font-weight:700;color:#58a6ff}
.metric.green{color:#3fb950}.metric.yellow{color:#d29922}.metric.red{color:#f85149}
.sub{font-size:13px;color:#8b949e;margin-top:4px}
.node{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #21262d}
.node:last-child{border-bottom:none}
.node-name{font-weight:600;color:#c9d1d9}
.node-badge{padding:2px 8px;border-radius:12px;font-size:12px;font-weight:600}
.badge-idle{background:#1f3a2c;color:#3fb950}.badge-busy{background:#3d2c1f;color:#d29922}
table{width:100%;border-collapse:collapse;margin-top:8px}
th{text-align:left;color:#8b949e;font-size:12px;text-transform:uppercase;padding:8px;border-bottom:1px solid #30363d}
td{padding:8px;border-bottom:1px solid #21262d;font-size:13px}
.status-success{color:#3fb950}.status-failure{color:#f85149}
.submit-form{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:24px}
.submit-form textarea,.submit-form input{width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:8px;margin:4px 0 8px;font-family:inherit;font-size:13px}
.submit-form textarea{height:80px;resize:vertical}
.submit-form button{background:#238636;color:#fff;border:none;border-radius:6px;padding:8px 16px;cursor:pointer;font-weight:600}
.submit-form button:hover{background:#2ea043}
.submit-form button:disabled{opacity:0.5;cursor:not-allowed}
#submitResult{margin-top:8px;font-size:13px;color:#8b949e}
.refresh{color:#8b949e;font-size:12px;float:right}
</style>
</head>
<body>
<h1>⚡ FSC Scheduler <span class="refresh" id="refreshInfo">loading...</span></h1>

<div class="grid" id="metrics"></div>

<div class="submit-form">
<h3 style="color:#8b949e;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">Submit Task</h3>
<input id="gitUrl" placeholder="Git URL (e.g. http://...@10.10.0.1:8418/org/repo.git)" />
<input id="taskTitle" placeholder="Title (optional)" />
<textarea id="taskDesc" placeholder="Description: what should the agent do?"></textarea>
<button id="submitBtn" onclick="submitTask()">Submit Task</button>
<span id="submitResult"></span>
</div>

<div class="card">
<h3>Nodes</h3>
<div id="nodeList"></div>
</div>

<div class="card" style="margin-top:16px">
<h3>Recent Results</h3>
<table><thead><tr><th>Task</th><th>Node</th><th>Status</th><th>Duration</th><th>Time</th></tr></thead>
<tbody id="resultBody"></tbody></table>
</div>

<script>
async function refresh(){
  try{
    const [status,results]=await Promise.all([
      fetch('/status').then(r=>r.json()),
      fetch('/results?count=15').then(r=>r.json())
    ]);
    document.getElementById('refreshInfo').textContent='Auto-refresh 5s | v'+status.scheduler.version;
    const m=document.getElementById('metrics');
    const c=status.cluster;
    m.innerHTML=\`
      <div class="card"><h3>Nodes Online</h3><div class="metric">\${c.nodes}</div><div class="sub">across cluster</div></div>
      <div class="card"><h3>Idle Agents</h3><div class="metric green">\${c.total_idle}</div><div class="sub">ready to work</div></div>
      <div class="card"><h3>Busy Agents</h3><div class="metric \${c.total_busy>0?'yellow':''}">\${c.total_busy}</div><div class="sub">executing tasks</div></div>
      <div class="card"><h3>Tasks Distributed</h3><div class="metric">\${status.scheduler.distributed}</div><div class="sub">this session (\${Math.round(status.scheduler.uptime_s/60)}min uptime)</div></div>
      <div class="card"><h3>Pending</h3><div class="metric \${status.queues.pending_tasks>5?'red':''}">\${status.queues.pending_tasks}</div><div class="sub">in queue</div></div>
      <div class="card"><h3>Total Results</h3><div class="metric">\${status.queues.total_results}</div><div class="sub">all time</div></div>
    \`;
    const nl=document.getElementById('nodeList');
    nl.innerHTML=status.nodes.map(n=>\`
      <div class="node">
        <div><span class="node-name">\${n.id}</span> <span style="color:#8b949e;font-size:12px">\${n.memory_mb}MB free, \${n.age_s}s ago</span></div>
        <div><span class="node-badge badge-idle">\${n.idle} idle</span> <span class="node-badge badge-busy">\${n.busy} busy</span></div>
      </div>
    \`).join('');
    const rb=document.getElementById('resultBody');
    rb.innerHTML=results.map(r=>{
      const d=new Date(r.timestamp);
      const time=d.toLocaleTimeString();
      return \`<tr>
        <td>\${r.taskId?.slice(0,25)||'?'}</td>
        <td>\${r.nodeId||'?'}</td>
        <td class="status-\${r.status}">\${r.status}</td>
        <td>\${(r.durationMs/1000).toFixed(1)}s</td>
        <td>\${time}</td>
      </tr>\`;
    }).join('');
  }catch(e){document.getElementById('refreshInfo').textContent='Error: '+e.message}
}
async function submitTask(){
  const btn=document.getElementById('submitBtn');
  const res=document.getElementById('submitResult');
  btn.disabled=true;res.textContent='Submitting...';
  try{
    const body={
      gitUrl:document.getElementById('gitUrl').value,
      title:document.getElementById('taskTitle').value,
      description:document.getElementById('taskDesc').value,
    };
    const r=await fetch('/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const j=await r.json();
    res.textContent=j.ok?'✅ '+j.taskId:'❌ '+j.error;
    if(j.ok){document.getElementById('taskDesc').value='';document.getElementById('taskTitle').value='';}
  }catch(e){res.textContent='❌ '+e.message}
  btn.disabled=false;
}
refresh();setInterval(refresh,5000);
</script>
</body>
</html>`;

main().catch((e) => { console.error("[fatal]", e); process.exit(1); });
