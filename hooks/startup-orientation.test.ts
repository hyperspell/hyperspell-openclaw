import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { HyperspellClient, SearchResult } from "../client.ts";
import type { HyperspellConfig } from "../config.ts";
import {
	buildStartupOrientationCompactionHandler,
	buildStartupOrientationHandler,
	buildStartupOrientationSessionCleanupHandler,
} from "./startup-orientation.ts";

type SearchCall = {
	query: string;
	options?: Parameters<HyperspellClient["search"]>[1];
};

function makeClient(responses: {
	recent?: SearchResult[];
	loops?: SearchResult[];
}) {
	const calls: SearchCall[] = [];
	const client = {
		calls,
		async search(
			query: string,
			options?: Parameters<HyperspellClient["search"]>[1],
		) {
			calls.push({ query, options });
			if (options?.after) return responses.recent ?? [];
			return responses.loops ?? [];
		},
	};
	return client;
}

function makeCfg(overrides?: Partial<HyperspellConfig>): HyperspellConfig {
	return {
		apiKey: "k",
		autoContext: false,
		autoTrace: { enabled: false, extract: ["procedure"] },
		emotionalContext: false,
		startupOrientation: {
			enabled: true,
			recentDays: 7,
			recentLimit: 5,
			loopsLimit: 3,
			recentQuery: "conversation session interaction",
			loopsQuery: "open tasks pending questions",
		},
		syncMemories: false,
		sources: [],
		maxResults: 10,
		relevanceThreshold: 0.6,
		debug: false,
		knowledgeGraph: { enabled: false, scanIntervalMinutes: 60, batchSize: 20 },
		...overrides,
	};
}

function makeResult(partial: Partial<SearchResult>): SearchResult {
	return {
		resourceId: "r1",
		title: "some session",
		source: "trace",
		score: 0.8,
		url: null,
		createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
		highlights: [{ id: "h1", score: 0.75, text: "we talked about the plan" }],
		...partial,
	};
}

test("startup-orientation — injects once per session, caches on subsequent turns", async () => {
	const client = makeClient({
		recent: [makeResult({ title: "yesterday's session" })],
		loops: [
			makeResult({
				title: "followup question",
				highlights: [{ id: "h", score: 0.4, text: "follow up on the config" }],
			}),
		],
	});
	const handler = buildStartupOrientationHandler(
		client as unknown as HyperspellClient,
		makeCfg(),
	);
	const ctx = { sessionKey: "s1" };

	const first = await handler({}, ctx);
	const prepend = (first as { prependContext?: string } | undefined)
		?.prependContext;
	assert.ok(prepend);
	assert.ok(prepend.includes("<hyperspell-recent-interactions>"));
	assert.ok(prepend.includes("<hyperspell-unfinished-loops>"));
	assert.ok(prepend.includes("yesterday's session"));
	assert.equal(client.calls.length, 2, "fires both searches in parallel");

	const second = await handler({}, ctx);
	assert.equal(second, undefined);
	assert.equal(
		client.calls.length,
		2,
		"does not re-search within same session",
	);
});

test("startup-orientation — compaction clears cache, next turn re-injects", async () => {
	const client = makeClient({ recent: [makeResult({})], loops: [] });
	const handler = buildStartupOrientationHandler(
		client as unknown as HyperspellClient,
		makeCfg(),
	);
	const onCompaction = buildStartupOrientationCompactionHandler();
	const ctx = { sessionKey: "s-compact" };

	await handler({}, ctx);
	await handler({}, ctx);
	assert.equal(client.calls.length, 2);

	await onCompaction({}, ctx);
	await handler({}, ctx);
	assert.equal(client.calls.length, 4, "re-searches after compaction");
});

test("startup-orientation — session_end cleanup allows later re-injection", async () => {
	const client = makeClient({ recent: [makeResult({})], loops: [] });
	const handler = buildStartupOrientationHandler(
		client as unknown as HyperspellClient,
		makeCfg(),
	);
	const onSessionEnd = buildStartupOrientationSessionCleanupHandler();
	const ctx = { sessionKey: "s-end" };

	await handler({}, ctx);
	await onSessionEnd({}, ctx);
	await handler({}, ctx);
	assert.equal(
		client.calls.length,
		4,
		"resumes searching after session end drops the cache entry",
	);
});

test("startup-orientation — empty results cache the attempt (no retry storm)", async () => {
	const client = makeClient({ recent: [], loops: [] });
	const handler = buildStartupOrientationHandler(
		client as unknown as HyperspellClient,
		makeCfg(),
	);
	const ctx = { sessionKey: "s-empty" };

	const out = await handler({}, ctx);
	assert.equal(out, undefined);
	assert.equal(client.calls.length, 2);

	await handler({}, ctx);
	assert.equal(
		client.calls.length,
		2,
		"empty results still mark session as handled",
	);
});

test("startup-orientation — recent search uses `after` and metadata filter", async () => {
	const client = makeClient({ recent: [makeResult({})], loops: [] });
	const handler = buildStartupOrientationHandler(
		client as unknown as HyperspellClient,
		makeCfg(),
	);
	await handler({}, { sessionKey: "s-filter" });

	const recentCall = client.calls.find((c) => c.options?.after);
	assert.ok(recentCall, "recent search must include `after`");
	assert.equal(
		(recentCall.options?.filter as { openclaw_source?: unknown } | undefined)
			?.openclaw_source,
		"agent_end",
	);
	assert.equal(recentCall.options?.limit, 5);
});

test("startup-orientation — loops search runs without filter or threshold", async () => {
	const client = makeClient({
		recent: [],
		loops: [makeResult({ title: "q" })],
	});
	const handler = buildStartupOrientationHandler(
		client as unknown as HyperspellClient,
		makeCfg(),
	);
	await handler({}, { sessionKey: "s-loops" });

	const loopsCall = client.calls.find((c) => !c.options?.after);
	assert.ok(loopsCall, "loops search must exist");
	assert.equal(
		loopsCall.options?.filter,
		undefined,
		"loops search has no metadata filter",
	);
	assert.equal(loopsCall.options?.limit, 3);
});

test("startup-orientation — skips orientation for unknown sender in multi-user mode", async () => {
	const client = makeClient({
		recent: [makeResult({})],
		loops: [makeResult({})],
	});
	const cfg = makeCfg({
		multiUser: {
			senderMap: { "+111": { userId: "alice", name: "Alice" } },
			sharedUserId: "shared",
			includeSharedInSearch: true,
		},
	});
	const handler = buildStartupOrientationHandler(
		client as unknown as HyperspellClient,
		cfg,
	);
	const out = await handler({}, { sessionKey: "s-unknown", senderId: "+999" });
	assert.equal(out, undefined);
	assert.equal(client.calls.length, 0, "no searches for unresolved sender");
});

test("startup-orientation — uses resolved userId for personal-only search in multi-user mode", async () => {
	const client = makeClient({ recent: [makeResult({})], loops: [] });
	const cfg = makeCfg({
		multiUser: {
			senderMap: { "+111": { userId: "alice", name: "Alice" } },
			sharedUserId: "shared",
			includeSharedInSearch: true,
		},
	});
	const handler = buildStartupOrientationHandler(
		client as unknown as HyperspellClient,
		cfg,
	);
	await handler({}, { sessionKey: "s-known", senderId: "+111" });
	assert.ok(client.calls.length === 2);
	for (const c of client.calls) {
		assert.equal(
			c.options?.userId,
			"alice",
			"both searches scoped to resolved personal userId",
		);
	}
});
