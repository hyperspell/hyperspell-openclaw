import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	buildEmotionalStateCompactionHandler,
	buildEmotionalStateFetchHandler,
	buildEmotionalStateSessionCleanupHandler,
	buildEmotionalStateStoreHandler,
	looksLikeRawTranscript,
} from "./emotional-state.ts";

type FakeClient = {
	getEmotionalState: (relId?: string) => Promise<{
		resourceId: string;
		summary: string;
		extractedAt: string;
		sessionId: string | null;
		relationshipId: string | null;
	} | null>;
	callCount: number;
};

function makeClient(
	summary: string | null,
): { client: FakeClient } {
	const client: FakeClient = {
		callCount: 0,
		async getEmotionalState() {
			client.callCount++;
			if (summary === null) return null;
			return {
				resourceId: "es-test",
				summary,
				extractedAt: "2026-04-17T00:00:00Z",
				sessionId: null,
				relationshipId: "rel-x",
			};
		},
	};
	return { client };
}

const cfg = {
	relationshipId: "rel-x",
} as unknown as Parameters<typeof buildEmotionalStateFetchHandler>[1];

test("emotional-state fetch — injects on first turn, skips on subsequent turns", async () => {
	const { client } = makeClient("state summary");
	const handler = buildEmotionalStateFetchHandler(
		client as unknown as Parameters<typeof buildEmotionalStateFetchHandler>[0],
		cfg,
	);

	const ctx = { sessionKey: "session-A" };

	const first = await handler({}, ctx);
	assert.ok(first && typeof (first as { prependContext?: unknown }).prependContext === "string");
	assert.ok(
		(first as { prependContext: string }).prependContext.includes("state summary"),
	);
	assert.equal(client.callCount, 1);

	const second = await handler({}, ctx);
	assert.equal(second, undefined);
	assert.equal(client.callCount, 1, "should not re-fetch within same session");

	const third = await handler({}, ctx);
	assert.equal(third, undefined);
	assert.equal(client.callCount, 1, "should not re-fetch across many turns");
});

test("emotional-state fetch — different sessions fetch independently", async () => {
	const { client } = makeClient("summary");
	const handler = buildEmotionalStateFetchHandler(
		client as unknown as Parameters<typeof buildEmotionalStateFetchHandler>[0],
		cfg,
	);

	await handler({}, { sessionKey: "session-B" });
	await handler({}, { sessionKey: "session-C" });
	assert.equal(client.callCount, 2, "each distinct session triggers its own fetch");
});

test("emotional-state fetch — null state is also cached (no retry storm)", async () => {
	const { client } = makeClient(null);
	const handler = buildEmotionalStateFetchHandler(
		client as unknown as Parameters<typeof buildEmotionalStateFetchHandler>[0],
		cfg,
	);

	const ctx = { sessionKey: "session-D" };
	await handler({}, ctx);
	await handler({}, ctx);
	await handler({}, ctx);
	assert.equal(
		client.callCount,
		1,
		"null result should also mark session as handled",
	);
});

test("emotional-state compaction — clears cache so next turn re-injects", async () => {
	const { client } = makeClient("state");
	const handler = buildEmotionalStateFetchHandler(
		client as unknown as Parameters<typeof buildEmotionalStateFetchHandler>[0],
		cfg,
	);
	const onCompaction = buildEmotionalStateCompactionHandler();
	const ctx = { sessionKey: "session-E" };

	await handler({}, ctx);
	assert.equal(client.callCount, 1);

	await handler({}, ctx);
	assert.equal(client.callCount, 1, "cached mid-session");

	await onCompaction({}, ctx);

	await handler({}, ctx);
	assert.equal(
		client.callCount,
		2,
		"after_compaction should invalidate cache and force re-inject",
	);
});

test("emotional-state session cleanup — removes entry to prevent unbounded growth", async () => {
	const { client } = makeClient("state");
	const handler = buildEmotionalStateFetchHandler(
		client as unknown as Parameters<typeof buildEmotionalStateFetchHandler>[0],
		cfg,
	);
	const onSessionEnd = buildEmotionalStateSessionCleanupHandler();
	const ctx = { sessionKey: "session-F" };

	await handler({}, ctx);
	assert.equal(client.callCount, 1);

	await onSessionEnd({}, ctx);

	await handler({}, ctx);
	assert.equal(
		client.callCount,
		2,
		"after session_end, re-joining same session id fetches again",
	);
});

test("emotional-state fetch — missing sessionKey still fetches (fallback)", async () => {
	const { client } = makeClient("state");
	const handler = buildEmotionalStateFetchHandler(
		client as unknown as Parameters<typeof buildEmotionalStateFetchHandler>[0],
		cfg,
	);

	await handler({}, {});
	await handler({}, {});
	assert.equal(
		client.callCount,
		2,
		"without sessionKey we can't cache — fetch each call",
	);
});

test("looksLikeRawTranscript — detects the pending raw-transcript placeholder, not real summaries", () => {
	assert.equal(looksLikeRawTranscript("user: hi\nassistant: hey there"), true);
	assert.equal(looksLikeRawTranscript("assistant: I think we left things tender"), true);
	assert.equal(
		looksLikeRawTranscript(
			"Your relationship with this user currently feels warm and steady; they leaned on you and felt met.",
		),
		false,
	);
});

test("emotional-state fetch — skips injecting a raw-transcript placeholder (pending), does NOT cache (retries next turn)", async () => {
	// During the ~10s extraction window the GET returns the raw transcript. We
	// must not inject it; and we must not cache, so a later turn re-fetches once
	// extraction completes.
	const { client } = makeClient("user: rough day\nassistant: I'm here");
	const handler = buildEmotionalStateFetchHandler(
		client as unknown as Parameters<typeof buildEmotionalStateFetchHandler>[0],
		cfg,
	);
	const ctx = { sessionKey: "session-pending" };

	const first = await handler({}, ctx);
	assert.equal(first, undefined, "no injection while still extracting");
	const second = await handler({}, ctx);
	assert.equal(second, undefined);
	assert.equal(client.callCount, 2, "not cached — re-fetched on the next turn");
});

// ---- store handler: cron-gate + debounce (the cadence fix) ----------------

function makeStoreClient() {
	const stores: Array<{ transcript: string; opts: { relationshipId?: string } }> = [];
	const client = {
		async storeEmotionalState(transcript: string, opts: { relationshipId?: string }) {
			stores.push({ transcript, opts });
			return { resourceId: "es-x", status: "pending", summary: "", extractedAt: "", sessionId: null, relationshipId: opts?.relationshipId ?? null };
		},
	};
	return { client, stores };
}

const richMessages = [
	{ role: "user", content: "hey, I had a really rough day and wanted to talk it through with you" },
	{ role: "assistant", content: "I'm here. Tell me what happened — take your time." },
	{ role: "user", content: "the deploy broke and I felt awful, but you always help me feel better" },
];
const storeCfg = (relationshipId: string) =>
	({ relationshipId }) as unknown as Parameters<typeof buildEmotionalStateStoreHandler>[1];

test("emotional-state store — skips automated triggers (cron/heartbeat/memory don't count)", async () => {
	for (const trigger of ["cron", "heartbeat", "memory"]) {
		const { client, stores } = makeStoreClient();
		const handler = buildEmotionalStateStoreHandler(
			client as unknown as Parameters<typeof buildEmotionalStateStoreHandler>[0],
			storeCfg(`rel-${trigger}`),
		);
		await handler({ success: true, messages: richMessages }, { trigger });
		assert.equal(stores.length, 0, `should NOT store for trigger=${trigger}`);
	}
});

test("emotional-state store — stores for a real user conversation", async () => {
	const { client, stores } = makeStoreClient();
	const handler = buildEmotionalStateStoreHandler(
		client as unknown as Parameters<typeof buildEmotionalStateStoreHandler>[0],
		storeCfg("rel-user-store"),
	);
	await handler({ success: true, messages: richMessages }, { trigger: "user" });
	assert.equal(stores.length, 1);
	assert.equal(stores[0].opts.relationshipId, "rel-user-store");
});

test("emotional-state store — undefined trigger still stores (don't skip when unknown)", async () => {
	const { client, stores } = makeStoreClient();
	const handler = buildEmotionalStateStoreHandler(
		client as unknown as Parameters<typeof buildEmotionalStateStoreHandler>[0],
		storeCfg("rel-undef"),
	);
	await handler({ success: true, messages: richMessages }, {});
	assert.equal(stores.length, 1);
});

test("emotional-state store — debounces repeated stores within the window", async () => {
	const { client, stores } = makeStoreClient();
	const handler = buildEmotionalStateStoreHandler(
		client as unknown as Parameters<typeof buildEmotionalStateStoreHandler>[0],
		storeCfg("rel-debounce"),
	);
	await handler({ success: true, messages: richMessages }, { trigger: "user" });
	await handler({ success: true, messages: richMessages }, { trigger: "user" });
	assert.equal(stores.length, 1, "second store within the debounce window is skipped");
});
