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

// ---------------------------------------------------------------------------
// Retrieval quarantine (quarantineResources) — enforced at the client boundary
// so no search path can forget it. See lib/quarantine.ts.
// ---------------------------------------------------------------------------

function makeDoc(id: string, title = id) {
	return {
		resource_id: id,
		title,
		source: "vault",
		score: 0.9,
		metadata: {},
		highlights: [{ id: "h1", score: 0.9, text: `text of ${id}` }],
	};
}

/** Stub the SDK's memories.search on a client; returns the captured call bodies. */
function stubSdkSearch(
	target: HyperspellClient,
	response: Record<string, unknown>,
) {
	const calls: Array<Record<string, unknown>> = [];
	const sdk = (
		target as unknown as {
			client: { memories: { search: (body: Record<string, unknown>) => Promise<unknown> } };
		}
	).client;
	sdk.memories.search = async (body: Record<string, unknown>) => {
		calls.push(body);
		return response;
	};
	return calls;
}

function quarantinedClient(ids: string[]) {
	return new HyperspellClient(
		parseConfig({ apiKey: "k", userId: "u1", quarantineResources: ids }),
	);
}

test("search — metaWriter: openclaw_writer stamp wins; legacy metadata.source is the retroactive fallback", async () => {
	const qc = quarantinedClient([]);
	stubSdkSearch(qc, {
		documents: [
			{ ...makeDoc("r1"), metadata: { openclaw_writer: "user", source: "openclaw_tool" } },
			{ ...makeDoc("r2"), metadata: { source: "openclaw_tool" } },
			{ ...makeDoc("r3"), metadata: { source: "openclaw_command" } },
			// Emotional-state registers: bare legacy key only — agent-generated
			// (their transcripts were text-indexed into vault search until
			// backend PR #3330; titled chunks read as curated without this).
			{ ...makeDoc("r4"), metadata: { source: "openclaw_agent_end" } },
			{ ...makeDoc("r5"), metadata: {} },
			{ ...makeDoc("r6") },
		],
	});
	const results = await qc.search("q", { limit: 10 });
	assert.deepEqual(
		results.map((r) => r.metaWriter),
		["user", "agent", "user", "agent", null, null],
		"stamp beats legacy; tool→agent, command→user, agent_end→agent; unknown→null (fail open)",
	);
});

test("search — quarantined resources are dropped and the fetch limit is widened to compensate", async () => {
	const qc = quarantinedClient(["bad-1"]);
	const calls = stubSdkSearch(qc, {
		documents: [makeDoc("bad-1"), makeDoc("ok-1"), makeDoc("ok-2")],
	});
	const results = await qc.search("q", { limit: 2 });
	assert.deepEqual(results.map((r) => r.resourceId), ["ok-1", "ok-2"]);
	const opts = calls[0].options as { max_results: number };
	assert.equal(opts.max_results, 3, "over-fetched by the quarantine count");
});

test("search — trims back to the requested limit after the drop", async () => {
	const qc = quarantinedClient(["bad-1"]);
	stubSdkSearch(qc, {
		documents: [makeDoc("ok-1"), makeDoc("ok-2"), makeDoc("ok-3")],
	});
	const results = await qc.search("q", { limit: 2 });
	assert.equal(results.length, 2, "over-fetch surplus trimmed when nothing was quarantined");
});

test("search — empty quarantine leaves the fetch limit untouched", async () => {
	const qc = quarantinedClient([]);
	const calls = stubSdkSearch(qc, { documents: [makeDoc("ok-1")] });
	await qc.search("q", { limit: 2 });
	const opts = calls[0].options as { max_results: number };
	assert.equal(opts.max_results, 2);
});

test("searchRaw — documents filtered, sibling response fields preserved", async () => {
	const qc = quarantinedClient(["bad-1"]);
	stubSdkSearch(qc, {
		documents: [makeDoc("bad-1"), makeDoc("ok-1")],
		answer: "unrelated field",
	});
	const response = await qc.searchRaw("q", { limit: 5 });
	const docs = response.documents as Array<{ resource_id: string }>;
	assert.deepEqual(docs.map((d) => d.resource_id), ["ok-1"]);
	assert.equal(response.answer, "unrelated field", "non-document fields pass through");
});

test("searchWithAnswer — answer discarded when a quarantined record was in the synthesis pool", async () => {
	const qc = quarantinedClient(["bad-1"]);
	stubSdkSearch(qc, {
		documents: [makeDoc("bad-1"), makeDoc("ok-1")],
		answer: "synthesized from a pool that included bad-1",
	});
	const out = await qc.searchWithAnswer("q");
	assert.deepEqual(out.documents.map((d) => d.resourceId), ["ok-1"]);
	assert.equal(out.answer, null, "tainted answer must not leak quarantined content");
});

test("searchWithAnswer — answer kept when nothing was quarantined from the pool", async () => {
	const qc = quarantinedClient(["bad-1"]);
	stubSdkSearch(qc, {
		documents: [makeDoc("ok-1")],
		answer: "clean answer",
	});
	const out = await qc.searchWithAnswer("q");
	assert.equal(out.answer, "clean answer");
});
