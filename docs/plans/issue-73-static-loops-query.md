# Implementation Guide — Issue #73: Make the unfinished-loops query adapt to what's actually open

## Background (verified against current source)

`buildStartupOrientationHandler` (`hooks/startup-orientation.ts:208`) runs two retrievals in parallel on the first turn of each session:

1. **Recent interactions** — `fetchRecentConversations` (hot-buffer vault path) or `fetchRecentTraces` (agent_end trace path), both returning the newest N session records *with their backend-generated titles*.
2. **Unfinished loops** — `client.search(so.loopsQuery, { limit: so.loopsLimit, userId })` (`hooks/startup-orientation.ts:271`), where `so.loopsQuery` defaults in `config.ts:557-559` to the fixed string `"open tasks pending questions unfinished promised need to follow up"`.

Because the loops query is byte-identical every session, semantic search ranks the *same* lexically-similar resources every time. Content that is genuinely open but doesn't share vocabulary with that phrase never surfaces; content that happens to embed near it surfaces forever. This is the "stuck" failure mode described in the issue.

**⚠️ Coordination with issue #78 (`/previewcontext` command) — read before implementing either.** #78 proposes extracting the fetch+format core of this same `buildStartupOrientationHandler` into a standalone exported `gatherOrientation(client, cfg, userId)` function, so a read-only preview command can call it without touching session-lifecycle state. That extraction should happen **on top of** this guide's resequenced logic (recent-fetch-first, then the derived `loopsQuery`), not the original parallel-fetch shape — otherwise #78 would extract a version of the function that #73 immediately has to re-resequence, undoing part of the extraction. **Land this guide (#73) first if possible**; if #78 lands first instead, apply this guide's resequencing and query-derivation directly inside its already-extracted `gatherOrientation`, rather than to the pre-extraction handler body.

**⚠️ Coordination with issue #71 (mood-weather observability) — read before implementing either.** #71 also edits this same `client.search(so.loopsQuery, { limit: so.loopsLimit, userId })` call, adding `filter: excludeFilterFor(cfg)` so mood-weather/agent_end rows can't surface in the loops block. The two changes are additive: whichever lands first, the second implementer adds the missing piece to the landed call rather than reverting to their own snapshot. Reconciled shape: `client.search(loopsQuery, { limit: so.loopsLimit, userId, filter: excludeFilterFor(cfg) })`, where `loopsQuery` is this guide's derived string. If #78's `gatherOrientation` extraction lands afterward, verify the extracted function keeps both the query derivation and the filter clause — the filter is easy to silently drop since neither guide's own snippet shows the other's piece.

**⚠️ Overlap with Group B `proposal/04-startup-orientation-loops-tuning` (external, not landable by this repo's normal process) — flag for human/cross-agent coordination, do not resolve unilaterally.** That proposal argues for an audit-before-tuning approach: run a standalone read-only script that mirrors the hook's exact search for ~10 days, hand-label results, and only then decide whether/how to change `loopsQuery`/add a recency window/adjust `loopsLimit`. This guide instead implements a dynamic per-session query now, on the theory that the fix is structurally obvious (a static query can't adapt) and doesn't need a measurement phase to justify. Concretely, if `proposal/04` lands first: its audit script's "byte-identical to the hook's search" fidelity claim breaks the moment this guide's dynamic query ships, and its Candidate A (reword the static default) would edit a string this guide's tests pin as the *base* of the derived query. If this guide lands first: `proposal/04`'s premise (a single static string to audit) no longer holds and its script would need to account for the per-session-varying query. This is a genuine measure-first-vs-fix-now philosophy disagreement between two different authors, not a mechanical conflict — a human should decide which approach to take before both land.

## Direction decision

### Option 1 — dynamic query derived from recent session content (recommended, this PR's scope)

Derive the loops query per-session from the titles of the user's most recent conversations — data the hook **already fetches** for the recent-interactions block — appended to the static intent phrase. The static phrase carries the "open loop" *intent* ("pending", "follow up"); the recent titles carry the *topic* anchor that changes session to session. No new API calls, no new persisted state, no backend changes.

Why this is the right first move:

- **Zero new state.** The recent-conversations list is already fetched in this exact handler; we only re-order two awaits (recent first, then search) and reuse its titles. Works across gateway restarts, and is inherently per-user in multi-user mode because `fetchRecentConversations`/`fetchRecentTraces` already take the resolved `userId`.
- **The API supports it.** `client.search()` (`client.ts:95`) passes `query` straight to `memories.search`; the SDK's `MemorySearchParams.query` is an unconstrained `string` — no documented length limit. We still cap defensively (see sketch).
- **Graceful degradation is built in.** No recent conversations (first session ever, recent fetch failure, or hot-buffer + auto-trace both off) → the derived query collapses to exactly the static default, i.e. today's behavior.

### Option 2 — explicit open-loop tagging at session end (documented alternative / follow-up, NOT this PR)

The architecturally "correct" fix: at `agent_end`, something classifies "this thread left an open loop" and writes a tagged row (e.g. `metadata.openclaw_source: "open_loop"` via `addMemory`), and startup orientation queries the tag directly — the search API already supports MongoDB-style `filter` (`client.ts:103`). The **write** side is not simple:

- It needs an extraction step. The backend's session `extract` enum supports only `procedure | memory | mood` (`client.ts:452-457`); an `open_loops` extractor is a Hyperspell-backend change, or the plugin grows its own LLM call at session end (a new dependency and cost this plugin currently doesn't have).
- It needs loop *lifecycle* semantics: when is a loop closed? Without a resolution/expiry story, tagged loops accumulate and you trade "stuck on lexical similarity" for "stuck on stale tags" — the same symptom with more machinery.

That is a separate design (file a follow-up issue referencing this one). Option 1 is strictly additive toward it: the query-building seam introduced here is where a tag-filtered fetch would later slot in.

## Code-level sketch

### 1. `config.ts` — distinguish "user set loopsQuery" from "defaulted"

Users who explicitly configured `loopsQuery` chose their phrasing; augmenting it behind their back would be a silent behavior change. Add a derived (not user-facing) flag to `StartupOrientationConfig`:

```ts
export type StartupOrientationConfig = {
	enabled: boolean;
	recentDays: number;
	recentLimit: number;
	loopsLimit: number;
	loopsQuery: string;
	/**
	 * True when the user explicitly set loopsQuery in config. Explicit queries
	 * are used verbatim; the defaulted query gets recent-topic terms appended
	 * so retrieval adapts to what's actually open (issue #73).
	 */
	loopsQueryExplicit: boolean;
};
```

In `parseConfig`:

```ts
startupOrientation: {
	enabled: (soRaw.enabled as boolean) ?? false,
	recentDays: (soRaw.recentDays as number) ?? 7,
	recentLimit: (soRaw.recentLimit as number) ?? 5,
	loopsLimit: (soRaw.loopsLimit as number) ?? 3,
	loopsQuery:
		(soRaw.loopsQuery as string) ??
		"open tasks pending questions unfinished promised need to follow up",
	loopsQueryExplicit: typeof soRaw.loopsQuery === "string",
},
```

No new config key, no schema/`ALLOWED_KEYS` change, no migration.

### 2. `hooks/startup-orientation.ts` — build the query from recent titles

Add a small exported helper (exported for direct unit testing, mirroring `sanitizeTraceText`'s pattern in `hooks/auto-trace.ts:35`):

```ts
/** Per-title and total caps keep the search query a bounded, embedding-friendly
 * size even if the backend generates long session titles. */
const LOOPS_TITLE_MAX = 80;
const LOOPS_TOPICS_MAX = 300;

/**
 * Derive the unfinished-loops search query for this session: the static intent
 * phrase (what an open loop *is*) plus recent conversation titles (what it's
 * likely *about*). With no recent titles this is exactly the static base, so
 * first-ever sessions and recent-fetch failures behave like today (issue #73).
 */
export function buildLoopsQuery(base: string, recent: SearchResult[]): string {
	const topics: string[] = [];
	let used = 0;
	for (const r of recent) {
		const title = (r.title ?? "").replace(/\s+/g, " ").trim().slice(0, LOOPS_TITLE_MAX);
		if (title.length === 0) continue;
		if (used + title.length > LOOPS_TOPICS_MAX) break;
		topics.push(title);
		used += title.length;
	}
	if (topics.length === 0) return base;
	return `${base} — recent topics: ${topics.join("; ")}`;
}
```

Notes on the inputs: `fetchRecentConversations` already excludes cron sessions, tagged sync/command rows, untitled rows, and duplicate titles (`hooks/startup-orientation.ts:184-192`), so the derived query inherits those exclusions for free. Titles are backend-generated summaries — already distilled topic phrases, which is why we don't need transcript keyword extraction (`messagesToTranscript`/`sanitizeTraceText` stay untouched; they operate on live `event.messages`, which don't exist yet at `before_agent_start`).

### 3. Re-sequence the two calls

Currently both run under one `Promise.allSettled`. The loops search now depends on the recent results, so it moves after them. Replace the current parallel-await block with:

```ts
const [recentSettled] = await Promise.allSettled([recentFetch]);
const recentOk = recentSettled.status === "fulfilled";
const recent = recentOk ? recentSettled.value : [];
if (!recentOk) {
	log.error(
		"startup-orientation: recent listMemories failed",
		(recentSettled as PromiseRejectedResult).reason,
	);
}

// Explicit user query = verbatim contract; defaulted query adapts to recent
// topics so the same static phrase doesn't pin the same resources forever.
const loopsQuery = so.loopsQueryExplicit
	? so.loopsQuery
	: buildLoopsQuery(so.loopsQuery, recent);

const [loopsSettled] = await Promise.allSettled([
	client.search(loopsQuery, { limit: so.loopsLimit, userId }),
]);
const loopsOk = loopsSettled.status === "fulfilled";
const loops = loopsOk ? loopsSettled.value : [];
if (!loopsOk) {
	log.error(
		"startup-orientation: loops search failed",
		(loopsSettled as PromiseRejectedResult).reason,
	);
}

if (!recentOk && !loopsOk) {
	// ...existing retry block unchanged (failedAttempts / MAX_ATTEMPTS)...
}
```

Everything below (injected-session marking, `formatRecentInteractions`, `formatUnfinishedLoops`, block assembly) is unchanged.

**Latency tradeoff (be explicit in the PR body):** the two calls were parallel (`max(recent, search)`); they're now serial (`recent + search`). This runs once per session (guarded by `injectedSessions`), and the added serial component is a single search call. If the recent fetch fails, the search still runs immediately with the static base — the partial-failure semantics in the existing tests are preserved.

### 4. Observability for the issue's measurement plan

The issue's test plan is "log which resource_ids the loops query surfaces across sessions." Extend the existing injection debug line:

```ts
log.debug(
	`startup-orientation: injecting recent=${recent.length} loops=${loops.length} ` +
		`loopsQuery="${loopsQuery.slice(0, 120)}" loopIds=${loops.map((l) => l.resourceId).join(",")}`,
);
```

With `debug: true`, a couple of weeks of gateway logs then directly answer "same handful of resources or not," before vs. after.

## Test additions

### `hooks/startup-orientation.test.ts` (existing `node:test` + `assert.strict` pattern; `makeClient` already records `searchCalls[i].query`)

First, `makeCfg`'s inline `startupOrientation` objects gain `loopsQueryExplicit: false` (and any tests that build their own `startupOrientation` literal get the field too — the type change makes `tsc` find them).

```ts
test("startup-orientation — loops query is derived from recent conversation titles (hot-buffer path)", async () => {
	const conv = (id: string, title: string): ListedMemory => ({
		resourceId: id, source: "vault", title, metadata: {},
	});
	const client = makeClient({
		traces: [
			conv("0471aa5b-2c34-43d0-a810-3bd846076e43", "Venice image provider setup"),
			conv("22222222-2222-3333-4444-555555555555", "Planning the D&D quarantine"),
		],
		loops: [],
	});
	const handler = buildStartupOrientationHandler(
		client as unknown as HyperspellClient,
		makeCfg({
			hotBuffer: { enabled: true, source: "vault", writeUser: true, writeAssistant: true },
			autoTrace: { enabled: false, extract: ["procedure"] },
		}),
	);
	await handler({}, { sessionKey: "s-dyn" });

	const q = client.searchCalls[0]?.query ?? "";
	assert.ok(q.startsWith("open tasks pending questions"), "static intent phrase kept as base");
	assert.match(q, /Venice image provider setup/);
	assert.match(q, /Planning the D&D quarantine/);
});

test("startup-orientation — no recent content: loops query falls back to exactly the static default", async () => {
	const client = makeClient({ traces: [], loops: [] });
	const handler = buildStartupOrientationHandler(
		client as unknown as HyperspellClient,
		makeCfg({
			hotBuffer: { enabled: true, source: "vault", writeUser: true, writeAssistant: true },
			autoTrace: { enabled: false, extract: ["procedure"] },
		}),
	);
	await handler({}, { sessionKey: "s-first-ever" });
	assert.equal(client.searchCalls[0]?.query, "open tasks pending questions");
});

test("startup-orientation — explicit loopsQuery override is used verbatim, never augmented", async () => {
	const client = makeClient({
		traces: [makeTrace({ title: "recent thing" })],
		loops: [],
	});
	const handler = buildStartupOrientationHandler(
		client as unknown as HyperspellClient,
		makeCfg({
			startupOrientation: {
				enabled: true, recentDays: 7, recentLimit: 5, loopsLimit: 3,
				loopsQuery: "my custom query", loopsQueryExplicit: true,
			},
		}),
	);
	await handler({}, { sessionKey: "s-explicit" });
	assert.equal(client.searchCalls[0]?.query, "my custom query");
});

test("startup-orientation — recent fetch failure: loops search still runs with the static base", async () => {
	const client = makeClient({
		traces: [],
		loops: [makeSearchResult({ title: "still-known loop" })],
		listError: new Error("recent list down"),
	});
	const handler = buildStartupOrientationHandler(
		client as unknown as HyperspellClient,
		makeCfg(),
	);
	const out = await handler({}, { sessionKey: "s-recent-down" });
	assert.equal(client.searchCalls[0]?.query, "open tasks pending questions");
	const prepend = (out as { prependContext?: string })?.prependContext ?? "";
	assert.ok(prepend.includes("<hyperspell-unfinished-loops>"));
});

test("buildLoopsQuery — caps topical portion so pathological titles can't blow up the query", () => {
	const long = "x".repeat(500);
	const recent = Array.from({ length: 10 }, (_, i) =>
		makeSearchResult({ resourceId: `r${i}`, title: `${long} ${i}` }),
	);
	const q = buildLoopsQuery("base", recent);
	assert.ok(q.length < 500, `query stays bounded, got ${q.length}`);
	assert.ok(q.startsWith("base"));
});
```

Also extend the existing multi-user test with one assertion that the derived query path still passes `userId: "alice"` on the search call — the derivation must not disturb per-user scoping.

### `config.test.ts`

```ts
test("parseConfig — loopsQueryExplicit false by default, true when user sets loopsQuery", () => {
	const def = parse({});
	assert.equal(def.startupOrientation.loopsQueryExplicit, false);
	const set = parse({ startupOrientation: { loopsQuery: "custom loops" } });
	assert.equal(set.startupOrientation.loopsQueryExplicit, true);
});
```

## Edge cases (explicit decisions)

- **Very first session ever / empty account:** `recent` is `[]` → `buildLoopsQuery` returns the static base unchanged.
- **Hot buffer AND auto-trace both disabled:** `recentFetch` is `Promise.resolve([])` → static base, no listMemories perf cost.
- **Recent fetch fails, search infra healthy:** static base is used; partial-success semantics (inject loops block, mark session injected, no retry) unchanged.
- **Multi-user:** derivation input is already per-resolved-user; unknown senders skip the whole hook before any fetch. No shared cross-user state is introduced.
- **User-configured `loopsQuery`:** verbatim contract via `loopsQueryExplicit`; no silent augmentation.
- **Query length:** SDK type has no limit, but `LOOPS_TITLE_MAX`/`LOOPS_TOPICS_MAX` bound it (~360 chars worst case).
- **Cron/synced/duplicate titles:** already filtered out upstream in `fetchRecentConversations`; the derived query inherits that.
- **Prompt-injection surface:** titles are backend-generated from user conversations and flow into a *search query*, not into model context beyond what the recent-interactions block already injects verbatim today — no new exposure class.

## Validation plan (matches the issue's "how we'd test it")

1. Unit tests above (`node --test hooks/startup-orientation.test.ts config.test.ts`).
2. Live: enable `debug: true` on a real install, run several sessions across different topics, and grep gateway logs for the new `loopsQuery=... loopIds=...` line. Success criterion: the surfaced `resource_id` set varies with recent topics instead of repeating the same handful; spot-check against a human-maintained "carried forward" list.

## Files touched

- `config.ts` — add `loopsQueryExplicit` to `StartupOrientationConfig`; derive it in `parseConfig`.
- `hooks/startup-orientation.ts` — new exported `buildLoopsQuery` helper + caps; re-sequence recent fetch before loops search; use derived query; extend injection debug log with query + surfaced resource ids.
- `hooks/startup-orientation.test.ts` — `makeCfg`/inline-config updates for the new field; 5 new tests; extend existing tests' assertions.
- `config.test.ts` — one new test for `loopsQueryExplicit`.

Follow-up (separate issue, out of scope here): explicit open-loop tagging at session end (Option 2) — needs a backend `open_loops` extractor or a plugin-side LLM extraction step, plus loop resolution/expiry semantics; the `buildLoopsQuery` seam introduced here is where a tag-filtered fetch would replace the semantic query.
