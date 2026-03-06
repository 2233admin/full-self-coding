/**
 * FSC-Mesh Cluster Health Check
 * 通过 mesh-bridge API 检查节点健康状态
 *
 * 由硅谷节点 AI 设计，人工修正 API 调用方式
 */

export interface NodeHealth {
	node: string;
	status: "ok" | "degraded" | "down";
	latencyMs: number;
	memoryMB: number | null;
	uptime: number | null;
	checkedAt: string;
}

export interface ClusterHealth {
	nodes: NodeHealth[];
	healthyCount: number;
	totalCount: number;
	timestamp: string;
}

export async function checkNodeHealth(
	nodeId: string,
	bridgeUrl: string
): Promise<NodeHealth> {
	const checkedAt = new Date().toISOString();
	const startTime = Date.now();
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 10_000);

	let status: NodeHealth["status"] = "down";
	let latencyMs = 0;
	let memoryMB: number | null = null;
	let uptime: number | null = null;

	try {
		// 发 status 查询给目标节点
		const res = await fetch(`${bridgeUrl}/send`, {
			method: "POST",
			signal: controller.signal,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ to: nodeId, message: "health-check", type: "status" }),
		});

		latencyMs = Date.now() - startTime;

		if (res.ok) {
			status = "ok";
			// mesh-bridge /send 返回 { ok, id }，实际健康数据通过 Redis Streams 异步回传
			// 这里只验证 bridge 可达性和响应时间
			if (latencyMs > 5000) status = "degraded";
		}
	} catch {
		latencyMs = Date.now() - startTime;
	} finally {
		clearTimeout(timeoutId);
	}

	return { node: nodeId, status, latencyMs, memoryMB, uptime, checkedAt };
}

export async function checkClusterHealth(
	nodes: string[],
	bridgeUrl: string
): Promise<ClusterHealth> {
	const timestamp = new Date().toISOString();
	const nodeHealths = await Promise.all(
		nodes.map((nodeId) => checkNodeHealth(nodeId, bridgeUrl))
	);
	const healthyCount = nodeHealths.filter((h) => h.status === "ok").length;

	return { nodes: nodeHealths, healthyCount, totalCount: nodes.length, timestamp };
}
