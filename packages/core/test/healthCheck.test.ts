/**
 * healthCheck.ts 测试
 * 由东京节点 AI 设计，人工修正断言细节
 */
import { test, expect, spyOn, afterEach } from "bun:test";
import { checkNodeHealth, checkClusterHealth } from "../src/utils/healthCheck";

const BRIDGE = "http://mock-bridge:18790";
let mockFetch: ReturnType<typeof spyOn>;

afterEach(() => {
	mockFetch?.mockRestore();
});

test("checkNodeHealth returns ok on 200", async () => {
	mockFetch = spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(JSON.stringify({ ok: true, id: "123" }), { status: 200 })
	);

	const result = await checkNodeHealth("silicon-valley", BRIDGE);

	expect(mockFetch).toHaveBeenCalledTimes(1);
	expect(result.node).toBe("silicon-valley");
	expect(result.status).toBe("ok");
	expect(result.latencyMs).toBeGreaterThanOrEqual(0);
	expect(typeof result.checkedAt).toBe("string");
});

test("checkNodeHealth returns down on fetch error", async () => {
	mockFetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));

	const result = await checkNodeHealth("tokyo", BRIDGE);

	expect(result.node).toBe("tokyo");
	expect(result.status).toBe("down");
	expect(result.latencyMs).toBeGreaterThanOrEqual(0);
});

test("checkClusterHealth aggregates healthyCount correctly", async () => {
	let callCount = 0;
	mockFetch = spyOn(globalThis, "fetch").mockImplementation(() => {
		callCount++;
		if (callCount === 3) return Promise.reject(new Error("timeout"));
		return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
	});

	const result = await checkClusterHealth(["central", "silicon-valley", "tokyo"], BRIDGE);

	expect(result.totalCount).toBe(3);
	expect(result.healthyCount).toBe(2);
	expect(result.nodes[0].status).toBe("ok");
	expect(result.nodes[1].status).toBe("ok");
	expect(result.nodes[2].status).toBe("down");
	expect(typeof result.timestamp).toBe("string");
});
