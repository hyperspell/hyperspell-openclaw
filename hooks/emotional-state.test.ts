import type { EmotionalStateLatest } from "../client.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	buildEmotionalStateCompactionHandler,
	buildEmotionalStateFetchHandler,
	buildEmotionalStateSessionCleanupHandler,
	buildEmotionalStateStoreHandler,
	looksLikeRawTranscript,
	messagesToTranscript,
	MOOD_WEATHER_COOLDOWN_MS,

	selectUsableRegisters,} from "./emotional-state.ts";
import { MOOD_TABLE } from "./mood-weather.ts";

type State = {
	resourceId: string;
	summary: string;
	extractedAt: string;
	sessionId: string | null;
	relationshipId: string | null;
};
type AddedMemory = {
	text: string;
	options?: {
		title?: string;
		collection?: string;
		metadata?: Record<string, string | number | boolean>;
	};
};
type FakeClient = {
	getEmotionalState: (relId?: string) => Promise<State | null>;
	getRecentEmotionalStates: (relId?: string, limit?: number) => Promise<State[] | null>;
	addMemory: (text: string, options?: AddedMemory["options"]) => Promise<{ resourceId: string }>;
	added: AddedMemory[];
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
		added: [],
		// Default mock: /recent unavailable (null) → handler falls back to getEmotionalState.
		async getRecentEmotionalStates() {
			return null;
		},
		async getEmotionalState() {
			client.callCount++;
			return summary === null ? null : st(summary);
		},
		// Records recordMoodRoll's fire-and-forget observability write (#71).
		async addMemory(text, options) {
			client.added.push({ text, options });
			return { resourceId: `mem-${client.added.length}` };
		},
	};
	return { client };
}

/** Mock where /emotional-state/recent IS available and returns the given arc. */
function makeArcClient(states: State[] | null): {
	client: FakeClient & { recentCalls: number };
} {
	const client: FakeClient & { recentCalls: number } = {
		callCount: 0,
		recentCalls: 0,
		added: [],
		async getRecentEmotionalStates() {
			client.recentCalls++;
			return states;
		},
		async getEmotionalState() {
			client.callCount++;
			return null;
		},
		async addMemory(text, options) {
			client.added.push({ text, options });
			return { resourceId: `mem-${client.added.length}` };
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

test("looksLikeRawTranscript — catches tool-role placeholders stored before tool turns were excluded", () => {
	// Observed live: a Discord send receipt occupying an emotional register.
	// Rows like this predate the CONVERSATIONAL_ROLES filter and stay fetchable
	// until they age out, so the detector must still recognize them.
	assert.equal(
		looksLikeRawTranscript('toolResult: {\n  "channel": "discord",\n  "via": "direct"'),
		true,
	);
	assert.equal(looksLikeRawTranscript("tool: search(query)"), true);
	assert.equal(looksLikeRawTranscript("system: you are an assistant"), true);
	// Prose that merely mentions a tool must not trip it — the prefix is line-leading.
	assert.equal(
		looksLikeRawTranscript("They were frustrated that the tool: kept failing mid-task."),
		false,
	);
});

test("messagesToTranscript — sends only conversational turns for extraction", () => {
	// Root cause of the receipt-in-the-arc bug: tool traffic was transcribed and
	// handed to the extractor, which then distilled API JSON into a register.
	const transcript = messagesToTranscript([
		{ role: "user", content: "rough day" },
		{ role: "toolResult", content: '{"channel":"discord","messageId":"153033938"}' },
		{ role: "assistant", content: "I'm here" },
		{ role: "system", content: "you are an assistant" },
		{ role: "tool", content: "search(query)" },
	]);
	assert.equal(transcript, "user: rough day\nassistant: I'm here");
	assert.equal(looksLikeRawTranscript(transcript), true, "still a transcript, just a clean one");
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

test("emotional-state store — cron-originated session that becomes a real conversation stores on the human turn (issue #70)", async () => {
	// ctx.trigger is PER-RUN in openclaw core, not session-fixed: the cron run's
	// agent_end carries trigger="cron", but a human reply in the SAME session is
	// a new run whose agent_end carries trigger="user". This locks in the plugin
	// side of that contract: skip the automated turn, store the human one.
	const { client, stores } = makeStoreClient();
	const handler = buildEmotionalStateStoreHandler(
		client as unknown as Parameters<typeof buildEmotionalStateStoreHandler>[0],
		storeCfg("rel-cron-to-real"),
	);
	const sessionKey = "session-cron-origin";

	// Turn 1: the scheduled check-in itself — automated, must NOT write.
	await handler(
		{ success: true, messages: richMessages },
		{ sessionKey, trigger: "cron" },
	);
	assert.equal(stores.length, 0, "cron-triggered turn must not write the register");

	// Turn 2+: the human replies substantively in the same session — new run,
	// trigger="user", accumulated transcript. Must write exactly once.
	const grownTranscript = [
		...richMessages,
		{ role: "user", content: "actually yes — can we talk? today was a lot and I keep replaying it" },
		{ role: "assistant", content: "Of course. I'm not going anywhere — start wherever it hurts." },
		{ role: "user", content: "thank you. it genuinely helps that you checked in first." },
	];
	await handler(
		{ success: true, messages: grownTranscript },
		{ sessionKey, trigger: "user" },
	);
	assert.equal(stores.length, 1, "the human turn of a cron-originated session must store");
	assert.equal(stores[0].opts.relationshipId, "rel-cron-to-real");
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
		async addMemory() {
			return { resourceId: "mem-x" };
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

// ---- mood weather: roll observability record (issue #71) --------------------

/** recordMoodRoll is fire-and-forget (un-awaited) — flush microtasks/immediates before asserting. */
const flushAsyncWrites = () => new Promise((r) => setImmediate(r));

const MOOD_IDS = MOOD_TABLE.map((m) => m.id);

test("mood weather observability — a landed roll writes exactly one tagged record", async () => {
	const { client } = makeClient("Warm and steady.");
	const handler = buildEmotionalStateFetchHandler(
		client as unknown as Parameters<typeof buildEmotionalStateFetchHandler>[0],
		moodCfg("rel-obs-write"),
		{ now: () => 1_000_000, rng: () => 0 },
	);

	const first = await handler({}, { sessionKey: "obs-s1" });
	assert.ok(hasMood(first), "chance=1 → weather lands");
	await flushAsyncWrites();

	assert.equal(client.added.length, 1, "exactly one observability record per roll");
	const rec = client.added[0];
	assert.equal(rec.options?.collection, "mood-weather");
	assert.equal(rec.options?.metadata?.openclaw_source, "mood_weather");
	assert.ok(
		MOOD_IDS.includes(String(rec.options?.metadata?.mood)),
		"metadata.mood is a valid mood id",
	);
	const rolledAt = String(rec.options?.metadata?.rolled_at);
	assert.ok(!Number.isNaN(new Date(rolledAt).getTime()), "rolled_at is a valid timestamp");
	assert.equal(rec.options?.metadata?.session, "obs-s1");
	assert.equal(rec.options?.metadata?.relationship_id, "rel-obs-write");

	const second = await handler({}, { sessionKey: "obs-s1" });
	assert.equal(second, undefined, "inject-once cache holds");
	await flushAsyncWrites();
	assert.equal(client.added.length, 1, "no second record for the same session");
});

test("mood weather observability — post-compaction replay does NOT record a second roll", async () => {
	// The recordMoodRoll call lives inside the !priorMood guard: a replay of an
	// already-rolled mood is not a new roll and must not double-log.
	const { client } = makeClient("Warm and steady.");
	const handler = buildEmotionalStateFetchHandler(
		client as unknown as Parameters<typeof buildEmotionalStateFetchHandler>[0],
		moodCfg("rel-obs-replay"),
		{ now: () => 1_000_000, rng: () => 0 },
	);
	const onCompaction = buildEmotionalStateCompactionHandler();
	const ctx = { sessionKey: "obs-replay" };

	const first = await handler({}, ctx);
	assert.ok(hasMood(first));
	await onCompaction({}, ctx);
	const replay = await handler({}, ctx);
	assert.ok(hasMood(replay), "replay re-injects the same mood");
	await flushAsyncWrites();
	assert.equal(client.added.length, 1, "one roll, one record — replay does not double-log");
});

test("mood weather observability — a failing record write never breaks the session", async () => {
	const { client } = makeClient("Warm and steady.");
	client.addMemory = async () => {
		throw new Error("backend down");
	};
	const handler = buildEmotionalStateFetchHandler(
		client as unknown as Parameters<typeof buildEmotionalStateFetchHandler>[0],
		moodCfg("rel-obs-fail"),
		{ now: () => 1_000_000, rng: () => 0 },
	);

	const out = await handler({}, { sessionKey: "obs-fail" });
	assert.ok(hasMood(out), "injection succeeds even though the record write rejects");
	// Flush the rejected write — recordMoodRoll's .catch must swallow it (an
	// unhandled rejection would fail the test run).
	await flushAsyncWrites();
});

test("mood weather observability — a discarded roll is not recorded", async () => {
	// Only raw-transcript placeholders → the still-extracting early return fires
	// BEFORE the roll, so nothing lands and nothing may be written.
	const { client } = makeArcClient([st("user: hi\nassistant: hey")]);
	const handler = buildEmotionalStateFetchHandler(
		client as unknown as Parameters<typeof buildEmotionalStateFetchHandler>[0],
		moodCfg("rel-obs-discard"),
		{ now: () => 1_000_000, rng: () => 0 },
	);

	const out = await handler({}, { sessionKey: "obs-discard" });
	assert.equal(out, undefined, "still extracting — no injection");
	await flushAsyncWrites();
	assert.equal(client.added.length, 0, "no record for weather that never happened");
});

test("mood weather observability — chance 0 writes nothing", async () => {
	const { client } = makeClient("Warm and steady.");
	const handler = buildEmotionalStateFetchHandler(
		client as unknown as Parameters<typeof buildEmotionalStateFetchHandler>[0],
		moodCfg("rel-obs-zero", 0),
		{ now: () => 1_000_000, rng: () => 0 },
	);

	const out = await handler({}, { sessionKey: "obs-zero" });
	assert.ok(!hasMood(out), "no dice → no weather");
	await flushAsyncWrites();
	assert.equal(client.added.length, 0);
});

// ---- mood weather: unattended sessions don't roll (issue #122) --------------

test("mood weather — cron/heartbeat/memory triggers never roll, user does", async () => {
	for (const trigger of ["cron", "heartbeat", "memory"]) {
		const { client } = makeClient("Warm and steady.");
		const handler = buildEmotionalStateFetchHandler(
			client as unknown as Parameters<typeof buildEmotionalStateFetchHandler>[0],
			moodCfg(`rel-unattended-${trigger}`),
			{ now: () => 1_000_000, rng: () => 0 },
		);
		const out = await handler({}, { sessionKey: `unatt-${trigger}`, trigger });
		assert.ok(
			!hasMood(out),
			`trigger=${trigger} must not roll even with chance=1 and a hitting rng`,
		);
		assert.match(
			String((out as { prependContext?: string })?.prependContext ?? ""),
			/Warm and steady/,
			"arc injection itself is unaffected — only the dice are skipped",
		);
	}

	const { client } = makeClient("Warm and steady.");
	const handler = buildEmotionalStateFetchHandler(
		client as unknown as Parameters<typeof buildEmotionalStateFetchHandler>[0],
		moodCfg("rel-attended-user"),
		{ now: () => 1_000_000, rng: () => 0 },
	);
	const out = await handler({}, { sessionKey: "att-user", trigger: "user" });
	assert.ok(hasMood(out), "trigger=user rolls normally");
});

test("mood weather — missing trigger stays eligible (fail-open to prior behavior)", async () => {
	const { client } = makeClient("Warm and steady.");
	const handler = buildEmotionalStateFetchHandler(
		client as unknown as Parameters<typeof buildEmotionalStateFetchHandler>[0],
		moodCfg("rel-no-trigger"),
		{ now: () => 1_000_000, rng: () => 0 },
	);
	const out = await handler({}, { sessionKey: "no-trigger-s1" });
	assert.ok(hasMood(out), "no trigger in ctx → rolls as before");
});

test("mood weather — a skipped cron roll does not burn the cross-session cooldown", async () => {
	const { client } = makeClient("Warm and steady.");
	let t = 1_000_000;
	const handler = buildEmotionalStateFetchHandler(
		client as unknown as Parameters<typeof buildEmotionalStateFetchHandler>[0],
		moodCfg("rel-cron-no-burn"),
		{ now: () => t, rng: () => 0 },
	);

	const cronOut = await handler({}, { sessionKey: "burn-cron", trigger: "cron" });
	assert.ok(!hasMood(cronOut), "cron session skipped the dice");

	t += 60 * 1000; // one minute later — far inside what a cooldown would cover
	const userOut = await handler({}, { sessionKey: "burn-user", trigger: "user" });
	assert.ok(
		hasMood(userOut),
		"the skipped cron roll left the window untouched — the next real conversation can land weather",
	);
});

test("selectUsableRegisters — settling window drops live-session echo; fail-open on bad timestamps; same-session dropped; trims to limit", () => {
	const now = Date.parse("2026-08-24T22:00:00Z");
	const mk = (over: Partial<EmotionalStateLatest>): EmotionalStateLatest => ({
		resourceId: "es-x",
		summary: "Settled, genuine register prose.",
		extractedAt: "2026-08-24T19:00:00Z", // 3h old — settled
		sessionId: null,
		relationshipId: "rel",
		...over,
	});
	const fresh = mk({ resourceId: "es-fresh", extractedAt: "2026-08-24T21:30:00Z" }); // 30m — inside window
	const settled = mk({ resourceId: "es-old" });
	const badTs = mk({ resourceId: "es-bad", extractedAt: "not-a-date" });
	const sameSession = mk({ resourceId: "es-same", sessionId: "sess-1" });
	const otherSession = mk({ resourceId: "es-other", sessionId: "sess-2" });
	const placeholder = mk({ resourceId: "es-ph", summary: "user: hello there\nassistant: hi" });

	const out = selectUsableRegisters(
		[fresh, settled, badTs, sameSession, otherSession, placeholder],
		10,
		{ now, currentSessionId: "sess-1" },
	);
	assert.deepEqual(
		out.map((s) => s.resourceId),
		["es-old", "es-bad", "es-other"],
		"fresh → dropped (settling); bad timestamp → kept (fail open); same session → dropped; placeholder → dropped",
	);
	// Trim: limit bounds the result.
	assert.equal(selectUsableRegisters([settled, badTs, otherSession], 2, { now }).length, 2);
});
