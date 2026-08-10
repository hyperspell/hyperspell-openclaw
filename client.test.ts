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

test("sendMessages — merges per-message metadata over shared batch metadata", async () => {
	const { calls, restore } = stubFetch();
	try {
		await client.sendMessages(
			[
				{
					resourceId: "r3",
					messageId: "m3",
					content: "c3",
					metadata: { openclaw_speaker_role: "user", openclaw_speaker_name: "David" },
				},
			],
			{ metadata: { openclaw_source: "hot_buffer" } },
		);
		const messages = (calls[0].body.messages as Array<Record<string, unknown>>);
		assert.deepEqual(messages[0].metadata, {
			openclaw_source: "hot_buffer",
			openclaw_speaker_role: "user",
			openclaw_speaker_name: "David",
		});
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

// GET-shaped stub: emotional-state GETs carry no request body, so the
// body-parsing stubFetch above would throw — this one just serves a payload.
function stubFetchJson(payload: unknown) {
	const orig = globalThis.fetch;
	globalThis.fetch = (async () =>
		({ ok: true, status: 200, json: async () => payload }) as unknown as Response) as typeof fetch;
	return { restore: () => (globalThis.fetch = orig) };
}

const stateRow = {
	resource_id: "es-1",
	summary: "warm, unhurried",
	extracted_at: "2026-07-12T00:00:00Z",
	session_id: "s1",
	relationship_id: null,
};

test("getRecentEmotionalStates — maps metadata through when the backend echoes it (#116)", async () => {
	const metadata = { source: "openclaw_agent_end", channelId: "telegram:123", depth_score: 0.7 };
	const { restore } = stubFetchJson([{ ...stateRow, metadata }]);
	try {
		const list = await client.getRecentEmotionalStates(undefined, 3);
		assert.deepEqual(list?.[0].metadata, metadata);
	} finally {
		restore();
	}
});

test("getEmotionalState — maps metadata through when the backend echoes it (#116)", async () => {
	const metadata = { source: "openclaw_agent_end" };
	const { restore } = stubFetchJson({ ...stateRow, metadata });
	try {
		const state = await client.getEmotionalState();
		assert.deepEqual(state?.metadata, metadata);
	} finally {
		restore();
	}
});

test("emotional-state GETs — metadata key cleanly absent when the backend doesn't echo it (today's reality)", async () => {
	const { restore } = stubFetchJson([stateRow]);
	try {
		const list = await client.getRecentEmotionalStates();
		assert.ok(list && !("metadata" in list[0]), "recent: no metadata key invented");
	} finally {
		restore();
	}
	const { restore: restore2 } = stubFetchJson(stateRow);
	try {
		const state = await client.getEmotionalState();
		assert.ok(state && !("metadata" in state), "latest: no metadata key invented");
	} finally {
		restore2();
	}
});

test("emotional-state GETs — non-object metadata is ignored, not mapped", async () => {
	for (const bad of ["oops", 7, null, ["a"]]) {
		const { restore } = stubFetchJson([{ ...stateRow, metadata: bad }]);
		try {
			const list = await client.getRecentEmotionalStates();
			assert.ok(list && !("metadata" in list[0]), `metadata=${JSON.stringify(bad)} dropped`);
		} finally {
			restore();
		}
	}
});
