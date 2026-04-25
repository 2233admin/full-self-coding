# FSC Capability Sidecar Proposal

> Date: 2026-04-25
> Source: EvoMap.ai Gene+Capsule schema (see `E:/knowledge/04-Research/EvoMap-stolen-2026-04-25.md`)
> Status: proposal, not implemented

## 1. 问题

FSC commit 是普通 git commit. planner agent 选 worker 时只能看 commit message + diff. 没有结构化元数据回答:

- 这次 patch 是被什么 trigger 触发的 (errsig:X / user_feature_request:Y)?
- blast_radius 多大 (改了几个文件几行)?
- 在什么 env 下 verify 过 (lockfile hash / git rev)?
- 历史 reuse 多少次, success_streak 多少?

planner 只能让 LLM 读 git log 全文重复推断, 烧 context.

## 2. 方案

每个 executor agent 完工 commit 前, 同 dir 写一个 `.fsc/capability.json` sidecar. 内容是 EvoMap Gene+Capsule schema 的 FSC 子集 (去掉上链 / GDI / carbon tax / multi-publisher), 只保留本地 reuse 信号.

**不上链**: 不发布到 EvoMap, 不验证内容寻址 hash 跨 agent 一致, 只本地 dedupe.

**Forward-only migration**: 现有 commit 不 backfill. patch plan 落地后的新 commit 才有 sidecar. 兼容代价: planner 读历史时区分 "with sidecar" 和 "without sidecar" 两类, 后者 fallback 到 LLM 读 diff (现状).

## 3. Schema (TypeScript)

```typescript
// D:/projects/full-self-coding/src/capability/schema.ts

export type Intent = 'repair' | 'optimize' | 'innovate' | 'explore';
export type Status = 'success' | 'failed' | 'partial';
export type Tier = 'trusted' | 'experimental' | 'deprecated';

export interface BlastRadius {
  files: number;
  lines: number;
}

export interface EnvFingerprint {
  platform: NodeJS.Platform;          // win32 / linux / darwin
  arch: string;                        // x64 / arm64
  bun_version: string;                 // Bun.version
  node_version?: string;               // process.version (only if node fallback)
  lockfile_hash: string;               // sha256 of bun.lockb / package-lock.json
  git_rev: string;                     // HEAD commit sha
}

export interface CapabilityOutcome {
  status: Status;
  score: number;                       // 0-1, agent self-report (not trusted alone)
  tests_passed?: number;               // real metric, must be measured
  tests_total?: number;
  wall_clock_ms?: number;              // real metric
}

export interface CapabilityProvenance {
  prompt?: string;                     // user/parent prompt that triggered, max 2000 chars
  agent_role: string;                  // executor / planner / verifier / ...
  agent_model: string;                 // claude-opus-4-7 / gpt-5-codex / ...
  parent_capability_id?: string;       // sha256 of parent sidecar (lineage)
  session_id?: string;
}

export interface CapabilitySidecar {
  // identity
  schema_version: '1.0.0';
  capability_id: string;               // sha256 of this object minus capability_id (canonical JSON)
  intent: Intent;
  trigger: string[];                   // signal patterns (errsig:X / user_request:snippet)

  // content
  summary: string;                     // >= 10 chars, what was done
  strategy?: string[];                 // optional ordered steps
  diff_summary?: string;               // first 500 chars of git diff (full diff in commit itself)

  // safety + scope
  blast_radius: BlastRadius;
  outcome: CapabilityOutcome;
  env_fingerprint: EnvFingerprint;

  // local reuse signals (no GDI, no upvotes)
  reuse_count: number;                 // how many times this sidecar was reused as few-shot
  success_streak: number;              // consecutive successes when this was reused
  tier: Tier;                          // trusted / experimental / deprecated

  // provenance + audit
  provenance: CapabilityProvenance;
  created_at: string;                  // ISO 8601
}
```

## 4. Content-addressed `capability_id`

抄 EvoMap canonical JSON + sha256 (见主档 3.2):

```typescript
// D:/projects/full-self-coding/src/capability/hash.ts
import { createHash } from 'node:crypto';

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value as object).sort();
  const pairs = keys.map(k => JSON.stringify(k) + ':' + canonicalize((value as Record<string, unknown>)[k]));
  return '{' + pairs.join(',') + '}';
}

export function computeCapabilityId(sidecar: Omit<CapabilitySidecar, 'capability_id'>): string {
  const canonical = canonicalize(sidecar);
  return 'sha256:' + createHash('sha256').update(canonical, 'utf8').digest('hex');
}
```

Bun 单测:
```bash
bun test src/capability/hash.test.ts
```

## 5. 写入时机 (executor)

每个 executor agent 在自己 worktree commit 前:

1. 跑测试拿真 metric (`tests_passed`, `wall_clock_ms`)
2. `git diff --stat HEAD` 拿 `blast_radius`
3. 算 `lockfile_hash` (`Bun.CryptoHasher` over `bun.lockb` content)
4. 拼 sidecar 对象, 计算 `capability_id`
5. 写到 `.fsc/capabilities/<capability_id-short>.json`
6. `git add .fsc/capabilities/<...>.json && git commit -m "<msg>" -m "Capability-Id: sha256:<hex>"`

git trailer `Capability-Id: ...` 让 sidecar 和 commit 双向可查, 不需要单独维护 mapping.

## 6. 读取时机

### Planner 选 worker / 选 capability

```typescript
// D:/projects/full-self-coding/src/planner/select.ts
import { readdirSync, readFileSync } from 'node:fs';
import type { CapabilitySidecar } from '../capability/schema.js';

export function selectCapabilities(
  signals: string[],
  options: { min_tier?: 'trusted' | 'experimental'; limit?: number } = {}
): CapabilitySidecar[] {
  const dir = '.fsc/capabilities';
  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  const all: CapabilitySidecar[] = files.map(f =>
    JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'))
  );

  const tier_floor = options.min_tier ?? 'experimental';
  const tier_rank = { deprecated: 0, experimental: 1, trusted: 2 };

  const matched = all.filter(c =>
    tier_rank[c.tier] >= tier_rank[tier_floor] &&
    c.outcome.status === 'success' &&
    c.trigger.some(t => signals.some(s => s.toLowerCase().includes(t.toLowerCase())))
  );

  // simple score: reuse * recency * success_streak
  const now = Date.now();
  return matched
    .map(c => ({
      sidecar: c,
      score: (c.reuse_count + 1)
        * Math.pow(0.5, (now - new Date(c.created_at).getTime()) / (30 * 86400_000))
        * (1 + c.success_streak * 0.1),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 3)
    .map(x => x.sidecar);
}
```

### Verifier 决策

verifier 读对应 commit 的 `Capability-Id` trailer, 加载 sidecar:
- 如果 `outcome.tests_passed < tests_total` 直接 reject
- 如果 `env_fingerprint.lockfile_hash` 和当前 lockfile 不符, warn (依赖飘了)
- 如果 `tier === 'deprecated'`, fail (用了不该用的 capability)

## 7. tier 升降级

手动 + 自动混合:

- 默认新 sidecar `tier = experimental`
- 自动晋级 trusted: `reuse_count >= 5 && success_streak >= 3`
- 自动降级 deprecated: `success_streak === 0 && reuse_count > 3` (反复用反复失败)
- Curry 手动 override: `bun fsc capability set-tier <id> trusted` (CLI)

不抄 EvoMap 的 GDI auto-promote (>= 25 阈值) -- 那是平台多用户场景, 单机 reuse 数 5 已经够信号.

## 8. dedupe

新 sidecar 写入前, 检查 `capability_id` 是否已存在:

- 已存在且内容字节相同 -> 不重复写, 把已有 sidecar 的 `reuse_count++`
- 已存在但内容不同 -> 不可能 (hash 是内容寻址), 报错说明 canonical JSON 实现有 bug

## 9. CLI

```bash
# 写 sidecar (executor 内部调用, 不暴露给用户)
bun fsc capability write --intent repair --trigger "errsig:Cannot find module" --summary "..." --diff-summary "..."

# 查询
bun fsc capability list --intent repair --tier trusted --limit 10
bun fsc capability show sha256:<hex>

# 升降级
bun fsc capability set-tier sha256:<hex> trusted

# stats (类似 EvoMap GDI dashboard 简化版)
bun fsc capability stats
# Output:
#   Total sidecars: 47
#   Tier breakdown: trusted=12, experimental=33, deprecated=2
#   Top reused: sha256:abc... (reuse=18, streak=7) "fix: aiohttp timeout"
#   Stale (no reuse > 60d): 5
```

## 10. 不做的事

- 不上链 EvoMap. 不发布到任何 hub.
- 不实现 carbon tax / GDI multi-dimensional scoring / Wilson lower-bound. 单机用普通 reuse_count 排序够.
- 不实现 PAVA confidence calibration. 单机 cold-start 数据不够.
- 不实现 cross-agent reuse (拿别人 capsule 适配). 只在本仓库历史里复用.
- 不实现 Mutation declaration / Hypothesis pre-record / 7-phase 完整 lifecycle. FSC 已有 GSD phase, 不重复造.
- 不写 docstring 和 type annotation 之外的注释. 代码自解释.

## 11. Migration plan

**Forward-only.** 不 backfill 现有 commit. 理由:

- backfill 必须 LLM 读 diff 反推 trigger / blast_radius -- 不准
- backfill 跑测试拿 `tests_passed` -- 历史 commit 当时的 test snapshot 已丢
- 现有 planner 已经支持"无 sidecar fallback 到 LLM 读 diff", 不破

实施顺序:

1. **Phase 1** (1 session): schema.ts + hash.ts + tests
2. **Phase 2** (1 session): executor 写 sidecar 集成 (在 commit 前 hook)
3. **Phase 3** (1 session): planner.selectCapabilities 集成, 注入 top3 当 few-shot
4. **Phase 4** (1 session): CLI + verifier 集成 + tier 升降级 logic
5. **Phase 5** (后续): 真实使用 1 周, 看 reuse_count 增长曲线决定要不要做 deprecated 自动降级

## 12. Unresolved Questions

- `provenance.prompt` 截 2000 字够不够? EvoMap 用 2000, 但 Curry 的 task prompt 经常 5000+. 扩到 4000?
- `capability_id` 用 SHA-256 还是 BLAKE3? Bun 原生支持后者, 快 3x. 但跨工具兼容差.
- 是否需要 sidecar 的 sidecar (EvolutionEvent 等价物, 即使失败也记)? 倾向不要, git commit 本身已 append-only.
- tier 默认 `experimental` 还是 `trusted`? 倾向 experimental, 但 planner 必须显式开启 `--include-experimental` 才用. 否则冷启动池空.
