import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	buildEmotionalStateCompactionHandler,
	buildEmotionalStateFetchHandler,
	buildEmotionalStateSessionCleanupHandler,
	buildEmotionalStateStoreHandler,
	looksLikeRawTranscript,
	MOOD_WEATHER_COOLDOWN_MS,
} from "./emotional-state.ts";
import { MOOD_TABLE } from "./mood-weather.ts";

type State = {
	resourceId: string;
	summary: string;
	extractedAt: string;
	sessionId: string | null;
	relationshipId: string | null;
};
type FakeClient = {
	getEmotionalState: (relId?: string) => Promise<State | null>;
	getRecentEmotionalStates: (relId?: string, limit?: number) => Promise<State[] | null>;
	callCount: number;
};

const st = (summary: string, extractedAt = "2026-04-17T00:00:00Z"): State => ({
	resourceId: `es-${summary.slice(0, 4)}`,
	summary,
	extractedAt,
	sessionId: null,
	relationshipId: "rel-x",
});

function makeClient(
	summary: string | null,
): { client: FakeClient } {
	const client: FakeClient = {
		callCount: 0,
		// Default mock: /recent unavailable (null) → handler falls back to getEmotionalState.
		async getRecentEmotionalStates() {
			return null;
		},
		async getEmotionalState() {
			client.callCount++;
			return summary === null ? null : st(summary);
		},
	};
	return { client };
}

/** Mock where /emotional-state/recent IS available and returns the given arc. */
function makeArcClient(states: State[] | null): {
	client: FakeClient & { recentCalls: number };
} {
	const client = {
		callCount: 0,
		recentCalls: 0,
		async getRecentEmotionalStates() {
			client.recentCalls++;
			return states;
		},
		async getEmotionalState() {
			client.callCount++;
			return null;
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
	const stores: Array<{
		transcript: string;
		opts: { relationshipId?: string; metadata?: Record<string, string | number | boolean> };
	}> = [];
	const client = {
		async storeEmotionalState(
			transcript: string,
			opts: { relationshipId?: string; metadata?: Record<string, string | number | boolean> },
		) {
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

// Metadata assertions below are per-key (not exact deepEqual) so later additive
// metadata fields (e.g. #68's depth fields) don't break these tests.

test("emotional-state store — tags metadata with channelId from ctx (#74)", async () => {
	const { client, stores } = makeStoreClient();
	const handler = buildEmotionalStateStoreHandler(
		client as unknown as Parameters<typeof buildEmotionalStateStoreHandler>[0],
		storeCfg("rel-chan-direct"),
	);
	await handler(
		{ success: true, messages: richMessages },
		{ trigger: "user", channelId: "chan-42" } as never,
	);
	assert.equal(stores.length, 1);
	assert.equal(stores[0].opts.metadata?.source, "openclaw_agent_end");
	assert.equal(stores[0].opts.metadata?.channelId, "chan-42");
});

test("emotional-state store — resolves channelId from composite sessionKey when ctx.channelId is absent", async () => {
	const { client, stores } = makeStoreClient();
	const handler = buildEmotionalStateStoreHandler(
		client as unknown as Parameters<typeof buildEmotionalStateStoreHandler>[0],
		storeCfg("rel-chan-skey"),
	);
	await handler(
		{ success: true, messages: richMessages },
		{ trigger: "user", sessionKey: "agent:main:discord:channel:222" },
	);
	assert.equal(stores.length, 1);
	assert.equal(stores[0].opts.metadata?.channelId, "222");
});

test("emotional-state store — omits channelId when unresolvable, still stores (no crash)", async () => {
	const { client, stores } = makeStoreClient();
	const handler = buildEmotionalStateStoreHandler(
		client as unknown as Parameters<typeof buildEmotionalStateStoreHandler>[0],
		storeCfg("rel-chan-none"),
	);
	// e.g. a manual CLI run: no channelId, sessionKey has no conversation segment.
	await handler({ success: true, messages: richMessages }, { trigger: "user" });
	assert.equal(stores.length, 1);
	assert.equal(stores[0].opts.metadata?.source, "openclaw_agent_end");
	assert.equal("channelId" in (stores[0].opts.metadata ?? {}), false, "channelId key must be absent, not empty");
});

// ---- the arc: inject last N via /emotional-state/recent --------------------

test("emotional-state fetch — injects the recent ARC (multiple registers, most recent first)", async () => {
	const { client } = makeArcClient([
		st("Warm and close right now.", "2026-06-24T20:00:00Z"),
		st("Tender after a hard day.", "2026-06-24T18:00:00Z"),
		st("Playful and light.", "2026-06-23T12:00:00Z"),
	]);
	const handler = buildEmotionalStateFetchHandler(
		client as unknown as Parameters<typeof buildEmotionalStateFetchHandler>[0],
		cfg,
	);
	const out = await handler({}, { sessionKey: "arc-1" });
	const ctx = (out as { prependContext?: string })?.prependContext ?? "";
	assert.match(ctx, /Warm and close/);
	assert.match(ctx, /Tender after a hard day/);
	assert.match(ctx, /Playful and light/);
	assert.match(ctx, /most recent first/);
	assert.equal(client.recentCalls, 1);
	assert.equal(client.callCount, 0, "uses /recent — no fallback to single getEmotionalState");
});

test("emotional-state fetch — filters raw-transcript placeholders out of the arc", async () => {
	const { client } = makeArcClient([
		st("Warm and steady."),
		st("user: hey\nassistant: hi"), // pending placeholder — must be dropped
		st("Grateful and close."),
	]);
	const handler = buildEmotionalStateFetchHandler(
		client as unknown as Parameters<typeof buildEmotionalStateFetchHandler>[0],
		cfg,
	);
	const out = await handler({}, { sessionKey: "arc-2" });
	const ctx = (out as { prependContext?: string })?.prependContext ?? "";
	assert.match(ctx, /Warm and steady/);
	assert.match(ctx, /Grateful and close/);
	assert.doesNotMatch(ctx, /user: hey/);
});

test("emotional-state fetch — falls back to single latest when /recent is unavailable (404 → null)", async () => {
	// makeClient's getRecentEmotionalStates returns null → fallback path.
	const { client } = makeClient("Just the latest register.");
	const handler = buildEmotionalStateFetchHandler(
		client as unknown as Parameters<typeof buildEmotionalStateFetchHandler>[0],
		cfg,
	);
	const out = await handler({}, { sessionKey: "arc-fallback" });
	const ctx = (out as { prependContext?: string })?.prependContext ?? "";
	assert.match(ctx, /Just the latest register/);
	assert.equal(client.callCount, 1, "fell back to getEmotionalState");
});

// ---- mood weather: cross-session cooldown (issue #77) ----------------------

const moodCfg = (relationshipId: string, chance = 1) =>
	({ relationshipId, moodWeatherChance: chance }) as unknown as Parameters<
		typeof buildEmotionalStateFetchHandler
	>[1];

const hasMood = (out: unknown) =>
	String((out as { prependContext?: string })?.prependContext ?? "").includes(
		"<hyperspell-mood-weather>",
	);

test("mood weather — a landed roll suppresses new rolls for clustered sessions", async () => {
	const { client } = makeClient("Warm and steady.");
	let t = 1_000_000;
	const handler = buildEmotionalStateFetchHandler(
		client as unknown as Parameters<typeof buildEmotionalStateFetchHandler>[0],
		moodCfg("rel-mood-cluster"),
		{ now: () => t, rng: () => 0 },
	);

	const first = await handler({}, { sessionKey: "mood-s1" });
	assert.ok(hasMood(first), "chance=1 → weather lands on the first session");

	t += 10 * 60 * 1000; // 10 minutes later — well inside the cooldown
	const second = await handler({}, { sessionKey: "mood-s2" });
	assert.ok(!hasMood(second), "second session in the cluster gets NO new weather");
	assert.match(
		String((second as { prependContext?: string })?.prependContext ?? ""),
		/Warm and steady/,
		"arc injection is unaffected — only the weather is suppressed",
	);

	t += 60 * 60 * 1000; // one more hour — still inside the 6h window
	const third = await handler({}, { sessionKey: "mood-s3" });
	assert.ok(!hasMood(third), "still cooled down an hour later");
});

test("mood weather — rolls again once the cooldown window has elapsed", async () => {
	const { client } = makeClient("Warm and steady.");
	let t = 1_000_000;
	const handler = buildEmotionalStateFetchHandler(
		client as unknown as Parameters<typeof buildEmotionalStateFetchHandler>[0],
		moodCfg("rel-mood-elapse"),
		{ now: () => t, rng: () => 0 },
	);

	const first = await handler({}, { sessionKey: "elapse-s1" });
	assert.ok(hasMood(first));

	t += MOOD_WEATHER_COOLDOWN_MS + 1;
	const later = await handler({}, { sessionKey: "elapse-s2" });
	assert.ok(hasMood(later), "a session past the window can roll fresh weather");
});

test("mood weather — a miss does not start the cooldown", async () => {
	const { client } = makeClient("Warm and steady.");
	let rngValue = 0.999;
	const handler = buildEmotionalStateFetchHandler(
		client as unknown as Parameters<typeof buildEmotionalStateFetchHandler>[0],
		moodCfg("rel-mood-miss", 0.5),
		{ now: () => 1_000_000, rng: () => rngValue },
	);

	const first = await handler({}, { sessionKey: "miss-s1" });
	assert.ok(!hasMood(first), "0.999 >= 0.5 — the gate misses");

	rngValue = 0;
	const second = await handler({}, { sessionKey: "miss-s2" });
	assert.ok(hasMood(second), "the miss did not burn the window — next session can land");
});

test("mood weather — post-compaction re-injection replays the SAME mood, no new dice", async () => {
	const { client } = makeClient("Warm and steady.");
	// First roll consumes [0, 0] → gate hit, picks MOOD_TABLE[0]. If a second
	// roll ever happened it would consume [0, 0.999999] → the LAST table entry.
	const rolls = [0, 0, 0, 0.999999];
	let i = 0;
	const handler = buildEmotionalStateFetchHandler(
		client as unknown as Parameters<typeof buildEmotionalStateFetchHandler>[0],
		moodCfg("rel-mood-compact"),
		{ now: () => 1_000_000, rng: () => rolls[i++] ?? 0 },
	);
	const onCompaction = buildEmotionalStateCompactionHandler();
	const ctx = { sessionKey: "compact-mood" };

	const first = await handler({}, ctx);
	assert.ok(hasMood(first));
	assert.match(
		String((first as { prependContext?: string })?.prependContext ?? ""),
		new RegExp(MOOD_TABLE[0].id),
	);

	await onCompaction({}, ctx);

	const replay = await handler({}, ctx);
	const replayCtx = String((replay as { prependContext?: string })?.prependContext ?? "");
	assert.ok(
		replayCtx.includes(MOOD_TABLE[0].note),
		"re-injection carries the mood rolled at session start",
	);
	assert.ok(
		!replayCtx.includes(MOOD_TABLE[MOOD_TABLE.length - 1].note),
		"no second roll happened (the [0, 0.999999] mood never appears)",
	);
});

test("mood weather — a still-extracting turn does not consume the roll", async () => {
	// Call 1 returns the pending raw-transcript placeholder (discarded turn);
	// call 2 returns a real register. The roll must happen only on call 2.
	let calls = 0;
	const client = {
		async getRecentEmotionalStates() {
			return null;
		},
		async getEmotionalState() {
			calls++;
			return calls === 1
				? st("user: hi\nassistant: hey")
				: st("Settled and warm.");
		},
	};
	const handler = buildEmotionalStateFetchHandler(
		client as unknown as Parameters<typeof buildEmotionalStateFetchHandler>[0],
		moodCfg("rel-mood-pending"),
		{ now: () => 1_000_000, rng: () => 0 },
	);
	const ctx = { sessionKey: "pending-mood" };

	const first = await handler({}, ctx);
	assert.equal(first, undefined, "still extracting — no injection, no roll");

	const second = await handler({}, ctx);
	assert.ok(hasMood(second), "the roll was not burned by the discarded turn");
	assert.match(
		String((second as { prependContext?: string })?.prependContext ?? ""),
		/Settled and warm/,
	);
});
