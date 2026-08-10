import { strict as assert } from "node:assert";
import { test } from "node:test";
import { HOT_BUFFER_SOURCE } from "../lib/filters.ts";
import { buildPreviewReport } from "./preview.ts";

type State = {
	resourceId: string; summary: string; extractedAt: string;
	sessionId: string | null; relationshipId: string | null;
};

function makeClient(opts: {
	arc?: State[] | null;          // getRecentEmotionalStates result
	vaultRows?: Array<{ resourceId: string; title: string | null; metadata: Record<string, unknown> }>;
	loops?: Array<{ resourceId: string; title: string | null; source: string; score: number | null; url: null; createdAt: string | null; highlights: Array<{ text: string; score: number }> }>;
}) {
	const calls = { recent: 0, latest: 0, list: 0, search: 0 };
	const client = {
		calls,
		async getRecentEmotionalStates() { calls.recent++; return opts.arc ?? null; },
		async getEmotionalState() { calls.latest++; return null; },
		async *listMemories() {
			calls.list++;
			for (const row of opts.vaultRows ?? []) yield { source: "vault", ...row };
		},
		async search() { calls.search++; return opts.loops ?? []; },
	};
	return client;
}

const baseCfg = {
	emotionalContext: true,
	moodWeatherChance: 0.08,
	autoContext: false,
	excludeChannels: [],
	quarantineResources: [],
	relationshipId: "rel-x",
	hotBuffer: { enabled: true },
	autoTrace: { enabled: false },
	startupOrientation: {
		enabled: true, recentDays: 7, recentLimit: 5, loopsLimit: 3,
		loopsQuery: "open tasks pending questions unfinished promised need to follow up",
	},
} as unknown as Parameters<typeof buildPreviewReport>[1];

const st = (summary: string): State => ({
	resourceId: "es-1", summary, extractedAt: "2026-07-01T00:00:00Z",
	sessionId: null, relationshipId: "rel-x",
});

test("preview — shows emotional arc block and configured mood chance without rolling", async () => {
	const client = makeClient({
		arc: [st("Warm and steady lately.")],
		vaultRows: [{ resourceId: "8a1b2c3d-0000-4000-8000-1234567890ab", title: "Budget chat", metadata: { openclaw_source: HOT_BUFFER_SOURCE } }],
		loops: [{ resourceId: "m1", title: "Follow up", source: "vault", score: 0.7, url: null, createdAt: null, highlights: [{ text: "promised to send the doc", score: 0.7 }] }],
	});
	const out = await buildPreviewReport(client as never, baseCfg, {});
	assert.ok(out.includes("<hyperspell-emotional-context>"));
	assert.ok(out.includes("Warm and steady lately."));
	assert.ok(out.includes("configured chance 8%"));
	assert.ok(out.includes("NOT rolled"));
	// The roll never happens: the mood override block must never appear.
	assert.ok(!out.includes("<hyperspell-mood-weather>"));
	assert.ok(out.includes("<hyperspell-recent-interactions>"));
	assert.ok(out.includes("Budget chat"));
	assert.ok(out.includes("<hyperspell-unfinished-loops>"));
	assert.ok(out.includes("promised to send the doc"));
});

test("preview — is idempotent: repeated calls re-fetch (no inject-once caching)", async () => {
	const client = makeClient({ arc: [st("Warm.")] });
	await buildPreviewReport(client as never, baseCfg, {});
	await buildPreviewReport(client as never, baseCfg, {});
	assert.equal(client.calls.recent, 2, "preview must not consult/populate session caches");
});

test("preview — emotionalContext off says so plainly and makes no emotional fetch", async () => {
	const client = makeClient({ arc: [st("Warm.")] });
	const cfg = { ...baseCfg, emotionalContext: false } as typeof baseCfg;
	const out = await buildPreviewReport(client as never, cfg, {});
	assert.ok(out.includes("Emotional context: OFF"));
	assert.equal(client.calls.recent + client.calls.latest, 0);
	assert.ok(!out.includes("Mood weather:"), "mood weather is gated on emotionalContext, like the real hook");
});

test("preview — no prior registers reports empty state, not an error", async () => {
	const client = makeClient({ arc: [] });
	const out = await buildPreviewReport(client as never, baseCfg, {});
	assert.ok(out.includes("no prior emotional state"));
});

test("preview — pending (raw-transcript) register reported as still extracting", async () => {
	const client = makeClient({ arc: [st("user: hello\nassistant: hi")] });
	const out = await buildPreviewReport(client as never, baseCfg, {});
	assert.ok(out.includes("still extracting"));
	assert.ok(!out.includes("<hyperspell-emotional-context>"));
});

test("preview — quarantined channel short-circuits with zero client calls", async () => {
	const client = makeClient({ arc: [st("Warm.")] });
	const cfg = { ...baseCfg, excludeChannels: ["dnd-123"] } as typeof baseCfg;
	const out = await buildPreviewReport(client as never, cfg, { channel: "dnd-123" });
	assert.ok(out.includes("quarantined"));
	assert.equal(client.calls.recent + client.calls.list + client.calls.search, 0);
});

test("preview — orientation with no source names the gap", async () => {
	const client = makeClient({ arc: [st("Warm.")] });
	const cfg = {
		...baseCfg,
		hotBuffer: { enabled: false },
		autoTrace: { enabled: false },
	} as typeof baseCfg;
	const out = await buildPreviewReport(client as never, cfg, {});
	assert.ok(out.includes("no source (hotBuffer and autoTrace both off)"));
});
