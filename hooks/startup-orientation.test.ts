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
type ListCall = { options?: Parameters<HyperspellClient["listMemories"]>[0] };
type ListedMemory = {
	resourceId: string;
	source: "trace";
	title: string | null;
	metadata: Record<string, unknown>;
};

type ClientResponses = {
	traces?: ListedMemory[];
	loops?: SearchResult[];
	listError?: Error;
	loopsError?: Error;
};

function makeClient(responses: ClientResponses) {
	const searchCalls: SearchCall[] = [];
	const listCalls: ListCall[] = [];
	const client = {
		searchCalls,
		listCalls,
		async search(
			query: string,
			options?: Parameters<HyperspellClient["search"]>[1],
		) {
			searchCalls.push({ query, options });
			if (responses.loopsError) throw responses.loopsError;
			return responses.loops ?? [];
		},
		async *listMemories(
			options?: Parameters<HyperspellClient["listMemories"]>[0],
		) {
			listCalls.push({ options });
			if (responses.listError) throw responses.listError;
			for (const m of responses.traces ?? []) yield m;
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
			loopsQuery: "open tasks pending questions",
		},
		syncMemories: false,
		syncMemoriesConfig: {
			enabled: false,
			sectionize: true,
			watchPaths: [],
			debounceMs: 2000,
		},
		sources: [],
		maxResults: 10,
		relevanceThreshold: 0.6,
		debug: false,
		knowledgeGraph: { enabled: false, scanIntervalMinutes: 60, batchSize: 20 },
		...overrides,
	};
}

function makeTrace(
	partial: Partial<ListedMemory> & { ageDays?: number },
): ListedMemory {
	const ageDays = partial.ageDays ?? 1;
	const created = new Date(
		Date.now() - ageDays * 24 * 3600 * 1000,
	).toISOString();
	const meta: Record<string, unknown> = {
		openclaw_source: "agent_end",
		created_at: created,
		...(partial.metadata ?? {}),
	};
	return {
		resourceId: partial.resourceId ?? "r1",
		source: "trace",
		title: partial.title ?? "some session",
		metadata: meta,
	};
}

function makeSearchResult(partial: Partial<SearchResult>): SearchResult {
	return {
		resourceId: "s1",
		title: "loop title",
		source: "trace",
		score: 0.6,
		url: null,
		createdAt: new Date().toISOString(),
		highlights: [{ id: "h1", score: 0.5, text: "open thread text" }],
		...partial,
	};
}

test("startup-orientation — injects once per session, caches on subsequent turns", async () => {
	const client = makeClient({
		traces: [makeTrace({ title: "yesterday's session", ageDays: 1 })],
		loops: [
			makeSearchResult({
				title: "followup",
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
	assert.equal(client.listCalls.length, 1, "list runs once for recent");
	assert.equal(client.searchCalls.length, 1, "search runs once for loops");

	const second = await handler({}, ctx);
	assert.equal(second, undefined);
	assert.equal(client.listCalls.length, 1, "no re-fetch within same session");
	assert.equal(client.searchCalls.length, 1);
});

test("startup-orientation — recent path filters non-agent_end traces and out-of-window items", async () => {
	const client = makeClient({
		traces: [
			makeTrace({ title: "in-window agent_end", ageDays: 2 }),
			makeTrace({
				title: "non-agent_end",
				ageDays: 1,
				metadata: {
					openclaw_source: "command",
					created_at: new Date(Date.now() - 1 * 86400000).toISOString(),
				},
			}),
			makeTrace({ title: "too old", ageDays: 30 }),
		],
		loops: [],
	});
	const handler = buildStartupOrientationHandler(
		client as unknown as HyperspellClient,
		makeCfg(),
	);
	const out = await handler({}, { sessionKey: "s-filter" });
	const prepend =
		(out as { prependContext?: string } | undefined)?.prependContext ?? "";
	assert.ok(prepend.includes("in-window agent_end"));
	assert.ok(!prepend.includes("non-agent_end"));
	assert.ok(!prepend.includes("too old"));
});

test("startup-orientation — recent results sorted desc by created_at, capped at recentLimit", async () => {
	// Inserted out-of-order to verify sort, not iteration order. With recentLimit=3,
	// expected output (desc): newest (0.1d), middle (2d), thirdNewest (3d).
	// "older" (4d) and "trimmed" (5d) get dropped past the limit.
	const client = makeClient({
		traces: [
			makeTrace({ title: "older", ageDays: 4 }),
			makeTrace({ title: "newest", ageDays: 0.1 }),
			makeTrace({ title: "middle", ageDays: 2 }),
			makeTrace({ title: "thirdNewest", ageDays: 3 }),
			makeTrace({ title: "trimmed", ageDays: 5 }),
		],
		loops: [],
	});
	const handler = buildStartupOrientationHandler(
		client as unknown as HyperspellClient,
		makeCfg({
			startupOrientation: {
				enabled: true,
				recentDays: 7,
				recentLimit: 3,
				loopsLimit: 3,
				loopsQuery: "q",
			},
		}),
	);
	const out = await handler({}, { sessionKey: "s-sort" });
	const prepend =
		(out as { prependContext?: string } | undefined)?.prependContext ?? "";
	const block = prepend.split("</hyperspell-recent-interactions>")[0];
	const newestPos = block.indexOf("newest");
	const middlePos = block.indexOf("middle");
	const thirdPos = block.indexOf("thirdNewest");
	assert.ok(
		newestPos > -1 && middlePos > newestPos && thirdPos > middlePos,
		"ordered desc by recency",
	);
	assert.ok(!block.includes("older"), "items beyond recentLimit are dropped");
	assert.ok(!block.includes("trimmed"));
});

test("startup-orientation — list call passes source:trace and userId", async () => {
	const client = makeClient({ traces: [makeTrace({})], loops: [] });
	const handler = buildStartupOrientationHandler(
		client as unknown as HyperspellClient,
		makeCfg(),
	);
	await handler({}, { sessionKey: "s-list" });

	assert.equal(client.listCalls[0]?.options?.source, "trace");
	assert.equal(
		client.listCalls[0]?.options?.userId,
		undefined,
		"single-user mode passes undefined",
	);
});

test("startup-orientation — compaction clears cache, next turn re-fetches", async () => {
	const client = makeClient({ traces: [makeTrace({})], loops: [] });
	const handler = buildStartupOrientationHandler(
		client as unknown as HyperspellClient,
		makeCfg(),
	);
	const onCompaction = buildStartupOrientationCompactionHandler();
	const ctx = { sessionKey: "s-compact" };

	await handler({}, ctx);
	await handler({}, ctx);
	assert.equal(client.listCalls.length, 1);
	assert.equal(client.searchCalls.length, 1);

	await onCompaction({}, ctx);
	await handler({}, ctx);
	assert.equal(client.listCalls.length, 2, "list re-fetches after compaction");
	assert.equal(client.searchCalls.length, 2);
});

test("startup-orientation — session_end cleanup allows later re-injection", async () => {
	const client = makeClient({ traces: [makeTrace({})], loops: [] });
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
		client.listCalls.length,
		2,
		"resumes fetching after session_end drop",
	);
});

test("startup-orientation — empty results still mark session as handled (no retry storm)", async () => {
	const client = makeClient({ traces: [], loops: [] });
	const handler = buildStartupOrientationHandler(
		client as unknown as HyperspellClient,
		makeCfg(),
	);
	const ctx = { sessionKey: "s-empty" };

	const out = await handler({}, ctx);
	assert.equal(out, undefined);
	assert.equal(client.listCalls.length, 1);
	assert.equal(client.searchCalls.length, 1);

	await handler({}, ctx);
	assert.equal(
		client.listCalls.length,
		1,
		"empty result counts as a successful attempt",
	);
});

test("startup-orientation — retries on total failure up to MAX_ATTEMPTS, then gives up", async () => {
	const client = makeClient({
		traces: [],
		loops: [],
		listError: new Error("transient list outage"),
		loopsError: new Error("transient search outage"),
	});
	const handler = buildStartupOrientationHandler(
		client as unknown as HyperspellClient,
		makeCfg(),
	);
	const ctx = { sessionKey: "s-retry" };

	await handler({}, ctx);
	assert.equal(client.listCalls.length, 1, "1st turn attempts");

	await handler({}, ctx);
	assert.equal(
		client.listCalls.length,
		2,
		"2nd turn retries after total failure",
	);

	await handler({}, ctx);
	assert.equal(client.listCalls.length, 2, "gives up after MAX_ATTEMPTS=2");
});

test("startup-orientation — partial failure (recent fails, loops succeeds) marks injected and surfaces what worked", async () => {
	const client = makeClient({
		traces: [],
		loops: [makeSearchResult({ title: "still-known loop" })],
		listError: new Error("recent list down"),
	});
	const handler = buildStartupOrientationHandler(
		client as unknown as HyperspellClient,
		makeCfg(),
	);
	const ctx = { sessionKey: "s-partial" };

	const out = await handler({}, ctx);
	const prepend =
		(out as { prependContext?: string } | undefined)?.prependContext ?? "";
	assert.ok(prepend.includes("<hyperspell-unfinished-loops>"));
	assert.ok(!prepend.includes("<hyperspell-recent-interactions>"));

	await handler({}, ctx);
	assert.equal(
		client.searchCalls.length,
		1,
		"no retry — partial success counts as injected",
	);
});

test("startup-orientation — skips orientation for unknown sender in multi-user mode", async () => {
	const client = makeClient({
		traces: [makeTrace({})],
		loops: [makeSearchResult({})],
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
	assert.equal(client.listCalls.length, 0);
	assert.equal(client.searchCalls.length, 0);
});

test("startup-orientation — uses resolved userId for both calls in multi-user mode", async () => {
	const client = makeClient({ traces: [makeTrace({})], loops: [] });
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
	assert.equal(client.listCalls[0]?.options?.userId, "alice");
	assert.equal(client.searchCalls[0]?.options?.userId, "alice");
});
