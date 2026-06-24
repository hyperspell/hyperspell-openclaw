import assert from "node:assert/strict";
import { test } from "node:test";
import { HyperspellClient } from "./client.ts";
import { parseConfig } from "./config.ts";

function stubFetch() {
	const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
	const orig = globalThis.fetch;
	globalThis.fetch = (async (url: unknown, init: { body: string }) => {
		calls.push({ url: String(url), body: JSON.parse(init.body) });
		return { ok: true, json: async () => ({ count: 1 }) } as unknown as Response;
	}) as typeof fetch;
	return { calls, restore: () => (globalThis.fetch = orig) };
}

const client = new HyperspellClient(
	parseConfig({ apiKey: "k", userId: "u1" }),
);

test("sendMessages — forwards per-message metadata into the POST /messages body", async () => {
	const { calls, restore } = stubFetch();
	try {
		await client.sendMessages(
			[{ resourceId: "r1", messageId: "m1", content: "c1" }],
			{ metadata: { openclaw_source: "hot_buffer" } },
		);
		assert.match(calls[0].url, /\/messages$/);
		const messages = (calls[0].body.messages as Array<Record<string, unknown>>);
		assert.deepEqual(messages[0].metadata, { openclaw_source: "hot_buffer" });
	} finally {
		restore();
	}
});

test("sendMessages — omits the metadata key entirely when none is given", async () => {
	const { calls, restore } = stubFetch();
	try {
		await client.sendMessages([
			{ resourceId: "r2", messageId: "m2", content: "c2" },
		]);
		const messages = (calls[0].body.messages as Array<Record<string, unknown>>);
		assert.ok(!("metadata" in messages[0]));
	} finally {
		restore();
	}
});
