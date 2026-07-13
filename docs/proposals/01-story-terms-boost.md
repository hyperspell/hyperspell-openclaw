# Proposal 01 — Set `ranking.storyTerms` to boost the active story

Idea #1 from the retrieval-relevance brainstorm ([#66](https://github.com/hyperspell/hyperspell-openclaw/issues/66)).

## 1. Summary

The composite ranker already has a content-based boost lane — `storyTerms` marks a result as the active story and grants it `storyBoost + curationBoost` on top of raw relevance — but it ships empty (`DEFAULT_RANKING.storyTerms: []`), so in practice nothing is ever boosted by *topic*, only by title shape. This proposal is mostly operational: define how to pick and maintain the term list, verify the boost actually reorders results, and close three small gaps that make the feature hard to use today — (a) substring matching false-positives on short terms (add word-boundary matching), (b) no `uiHints` entry for the entire `ranking` section so `storyTerms` is invisible in the plugin config UI, and (c) debug logging that only tallies *selected* results so you can't see whether a story match existed in the candidate pool but lost. No new config fields; the code delta is ~30 lines plus tests.

## 2. Problem

The only mechanisms lifting "what matters most right now" are structural, not topical:

- `classifyResult` (`lib/ranking.ts:75-88`) classifies by title shape + resourceId shape: `chatter` = untitled/"Unnamed Conversation" with a bare session-UUID `resourceId`; `curated` = real title + non-UUID id. A memory about the active project gets no lift unless it *happens* to be a titled non-UUID row — and even then it gets the same generic `curationBoost` as every other titled row.
- `scoreResult` (`lib/ranking.ts:91-103`) already implements the story lane: `kind === "story"` → `composite = base + storyBoost + curationBoost` (+0.35 with defaults, vs +0.2 curated, −0.2 chatter). But `kind` can only be `"story"` when `storyTerms` is non-empty, and `DEFAULT_RANKING.storyTerms` is `[]` (`lib/ranking.ts:41`). The lane exists and is dead.

So today, a topically-on-point memory competes purely on cosine similarity — and similarity rewards frequency (the "useless dreamer" failure documented in the header comment of `lib/ranking.ts:3-18`). A hundred re-saved conversation echoes about a topic look "most similar" to a prompt about that topic and crowd out the one memory that actually carries the thread.

Three concrete gaps block just "setting the config and being done":

1. **Matching is naive substring.** `classifyResult` builds `hay = title + " " + highlights.join(" ")` lowercased and tests `hay.includes(term)` (`lib/ranking.ts:80-82`). A short term like `"ada"` matches "adaptation"; `"tin"` matches "meeting". Because a story hit is worth +0.35 *and* runs before the chatter check (see Risks §5.4), a false positive is expensive.
2. **The config is undiscoverable.** `openclaw.plugin.json` has a `configSchema.ranking` block (with `storyTerms`) but `uiHints` has **no `ranking` entry at all** — every other top-level section has one. An operator scrolling the plugin UI never learns `storyTerms` exists.
3. **You can't verify it worked.** The single-user ranked branch logs a kind tally, but only over `selected` (`hooks/auto-context.ts:210-216`) — if a story-classified result is in the candidate pool but still loses (or is cut by threshold), the tally shows nothing. The multi-user path's `format()` (`hooks/auto-context.ts:334-346`) logs no tally at all. The stated test procedure for this idea ("check whether story-tagged results move up in the logged composite tally") is not currently satisfiable from logs alone.

## 3. Proposed design

### 3.1 Operational core: what terms to pick

`storyTerms` should hold the **distinctive proper nouns of the active thread** — character names, project codenames, manuscript titles, invented terminology. Guidance to document in the manifest help text and follow in practice:

- 3–15 terms. Every term is checked per result per search; more terms = more false-positive surface, not more recall.
- Prefer distinctive multi-word phrases (`"lady of storms"`) and invented words (`"omuerta"`, `"junii"`) over common English words. Never add a term that appears in unrelated conversation ("book", "chapter", "draft").
- Terms are matched case-insensitively; store them lowercase for clarity (matching lowercases anyway).
- One list per deployment — this is "the active story," singular. If two threads are simultaneously hot, both sets of nouns go in the one list.

Example config:

```json
{
  "ranking": {
    "enabled": true,
    "storyTerms": ["lady of storms", "omuerta", "heath", "junii", "tevre"]
  }
}
```

**Derivation process (initial):** list the curated memories that define the active thread (`hyperspell_search` for the project title, or `client.listMemories()` / `hyperbrain memories` on the operator side) and pull the proper nouns from their titles and first lines. If the deployment uses `startup-orientation`, its "unfinished loops" output is a good second source — the loops name the live threads.

**Maintenance process:** revisit the list on story pivot, not on a calendar. Concretely: when the operator notices boosted-but-stale results (the debug tally, §3.4, makes this visible), prune. A stale term is worse than a missing one — it grants +0.35 to a dead thread's echoes. Add a line to the deployment's runbook/checklist: "changed active project → update `ranking.storyTerms`." Auto-deriving the list from a designated "story manifest" memory is a plausible follow-up but explicitly out of scope here (it adds a read dependency to a hot path that must stay fail-open).

### 3.2 Code change: word-boundary matching in `classifyResult`

Keep substring semantics for phrases and long terms (they're already selective) but require word boundaries for short single tokens, where false positives live. In `lib/ranking.ts`:

```ts
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Compiled matchers, cached per storyTerms array (config is stable per process).
const matcherCache = new WeakMap<string[], RegExp[]>();

function storyMatchers(storyTerms: string[]): RegExp[] {
	let ms = matcherCache.get(storyTerms);
	if (!ms) {
		ms = storyTerms
			.filter((t) => t.trim().length > 0)
			.map((t) => {
				const term = t.trim().toLowerCase();
				// \b only anchors against word chars; guard so terms with
				// leading/trailing punctuation still match.
				const lead = /^\w/.test(term) ? "\\b" : "";
				const tail = /\w$/.test(term) ? "\\b" : "";
				return new RegExp(`${lead}${escapeRe(term)}${tail}`);
			});
		matcherCache.set(storyTerms, ms);
	}
	return ms;
}
```

And in `classifyResult` (`lib/ranking.ts:80-82`), replace the `includes` check:

```ts
if (storyTerms.length > 0) {
	const hay = `${title}\n${r.highlights.map((h) => h.text).join("\n")}`.toLowerCase();
	if (storyMatchers(storyTerms).some((re) => re.test(hay))) return "story";
}
```

Two deliberate choices:

- **Boundary matching for everything, phrases included.** `\b`-anchored regex works identically for `"lady of storms"`; there is no reason to keep raw substring for any term class once the regex path exists. `"omuerta"` still matches `"the Omuerta magic system"` (boundaries are word↔non-word transitions), but `"ada"` no longer matches `"adaptation"`.
- **Join hay with `\n` instead of a space.** The current space-join lets a phrase term spuriously match across the seam of two unrelated highlights (or title↔highlight). `\b` doesn't fix that; the separator does (regex `\b...\b` with a literal space in the phrase won't cross `\n`... unless the term itself is matched with `.` — it isn't; terms are escaped literals).

`classifyResult`'s signature is unchanged, so `scoreResult`, `rerank`, and both call sites in `hooks/auto-context.ts` need no edits. The `WeakMap` cache means no per-result regex compilation; `cfg.ranking.storyTerms` is one array instance for the process lifetime (built once in `parseConfig`).

### 3.3 Config: normalize in `parseRanking`, add the missing `uiHints`

`config.ts:238-240` already parses `storyTerms` (array → `String` → drop empties). Tighten it to trim/lowercase/dedupe so the runtime never sees `"  Omuerta "` and `"omuerta"` as two terms:

```ts
storyTerms: Array.isArray(r.storyTerms)
	? [...new Set(
			(r.storyTerms as unknown[])
				.map((t) => String(t).trim().toLowerCase())
				.filter((t) => t.length > 0),
		)]
	: DEFAULT_RANKING.storyTerms,
```

`openclaw.plugin.json`: the `configSchema.ranking.storyTerms` entry already exists (no schema change needed — this is *not* another `relevanceThreshold`-class bug), but add the missing `uiHints.ranking` entry so the section is configurable from the UI at all:

```json
"ranking": {
	"label": "Composite Ranking",
	"help": "Rank memories by more than raw relevance: boost curated memory and the active story, penalize auto-saved conversation fragments.",
	"advanced": true,
	"properties": {
		"storyTerms": {
			"label": "Story Terms",
			"placeholder": "[\"lady of storms\", \"omuerta\"]",
			"help": "Names/terms of the active thread (characters, codenames, invented words). Matching results get the story boost on top of relevance. Use 3-15 distinctive terms; avoid common words. Update when the active story changes."
		}
	}
}
```

(Adjust the nesting to whatever shape the existing `uiHints` entries for object-valued sections like `hotBuffer`/`multiUser` use — mirror those exactly.)

### 3.4 Debug instrumentation: tally candidates, not just survivors

Goal: `debug: true` before/after runs must show story-tagged results moving up, per search, even when they lose. Two edits in `hooks/auto-context.ts`:

**Single-user ranked branch** (`hooks/auto-context.ts:198-217`): tally the full ranked candidate pool alongside the selected set, and log the moment unconditionally (today the tally only logs when `formatted` is truthy — a story match cut by threshold is exactly the case you need to see):

```ts
const tallyOf = (rs: RankedResult[]) =>
	rs.reduce(
		(acc, r) => ((acc[r._kind] = (acc[r._kind] ?? 0) + 1), acc),
		{} as Record<string, number>,
	)
// after rerank + selectRanked:
log.debug(
	`auto-context: ranked ${JSON.stringify(tallyOf(ranked))} candidates → selected ${JSON.stringify(tallyOf(selected))} (chatter cap ${ranking.chatterQuota})`,
)
if (cfg.debug) {
	for (const r of ranked.slice(0, 10)) {
		log.debug(
			`  [${r._kind}] ${r._base.toFixed(2)}→${r._composite.toFixed(2)} ${(r.title ?? r.resourceId).slice(0, 60)}`,
		)
	}
}
```

The per-result lines are the actual verification artifact: `[story] 0.47→0.82 writing — The Lady of Storms` vs the same line reading `[curated] 0.47→0.67` before `storyTerms` was set. Ten lines, debug-gated, one call per search — acceptable noise.

**Multi-user path** (`format()` closure, `hooks/auto-context.ts:334-346`): add the same candidates→selected tally line with a `personal`/`shared` label argument, so multi-user deployments aren't verification-blind. Same `tallyOf` helper (hoist it to module scope or export it from `lib/ranking.ts` — the latter is nicer since it's pure and testable).

### 3.5 What does NOT change

- `scoreResult` / `rerank` / `selectRanked` logic: untouched. Story results remain subject to `relevanceThreshold` and `maxResults`; they are exempt from the chatter quota only because they're not classified chatter (see Risks).
- No new config keys, no `ALLOWED_KEYS` changes, no schema additions.
- No new network calls; matching runs on fields the search already returned (fail-open property preserved).

## 4. Test plan

### 4.1 Unit tests — `lib/ranking.test.ts` additions

Follow the existing conventions (`node:test` + `node:assert/strict`, the `mk()` result factory, exact-composite assertions with `1e-9` tolerance):

```ts
test("story term beats chatter at EQUAL base relevance", () => {
	// The core promise of idea #1: topic wins over noise when similarity ties.
	const chatter = mk({
		title: "Unnamed Conversation",
		resourceId: UUID,
		score: 0.5,
		highlights: [{ id: "h", text: "we talked about writing again", score: 0.5 }],
	});
	const story = mk({
		title: null,
		resourceId: "mem-2",
		score: 0.5,
		highlights: [{ id: "h", text: "Junii finally confronts the Omuerta", score: 0.5 }],
	});
	const w = { ...DEFAULT_RANKING, storyTerms: ["omuerta"] };
	const ranked = rerank([chatter, story], w);
	assert.equal(ranked[0].resourceId, "mem-2");
	// story: 0.5 + 0.15 + 0.20 = 0.85 ; chatter: 0.5 − 0.20 = 0.30
	assert.ok(Math.abs(ranked[0]._composite - 0.85) < 1e-9);
	assert.ok(Math.abs(ranked[1]._composite - 0.3) < 1e-9);
});

test("story matching requires word boundaries — short terms don't match inside words", () => {
	const r = mk({ title: "notes on adaptation strategy", resourceId: "x" });
	assert.notEqual(classifyResult(r, ["ada"]), "story");
	assert.equal(classifyResult(mk({ title: "Ada's chapter", resourceId: "x" }), ["ada"]), "story");
});

test("story matching is case-insensitive and reaches highlights with a null title", () => {
	const r = mk({
		title: null,
		resourceId: UUID,
		highlights: [{ id: "h", text: "THE OMUERTA rises", score: 0.4 }],
	});
	assert.equal(classifyResult(r, ["Omuerta"]), "story");
});

test("phrase terms don't match across the seam of two highlights", () => {
	const r = mk({
		title: null,
		resourceId: "x",
		highlights: [
			{ id: "a", text: "spoke to the lady", score: 0.4 },
			{ id: "b", text: "of storms there were many", score: 0.4 },
		],
	});
	assert.notEqual(classifyResult(r, ["lady of storms"]), "story");
});
```

Plus a `config.test.ts` case: `parseRanking`-via-`parseConfig` with `storyTerms: ["  Omuerta ", "omuerta", ""]` → `["omuerta"]` (trim, lowercase, dedupe, drop empty). Run with `node --test --experimental-strip-types lib/ranking.test.ts config.test.ts`.

Note the existing test at `lib/ranking.test.ts:38-50` ("classify — story") already covers the happy path; the boundary test **changes** no existing assertion (both existing story fixtures match under boundary rules — verify this when implementing).

### 4.2 Live verification — before/after probe

Following the `docs/hotbuffer-verify.mjs` / `docs/issue42-resourceid-probe.mjs` precedent, add `docs/story-terms-verify.mjs`, run with `node --experimental-strip-types docs/story-terms-verify.mjs`:

1. Hard-code 5–10 real prompts that *should* surface story memory over topically-similar chatter (for the reference deployment: prompts about the manuscript, its characters, the current chapter).
2. For each prompt, call the live search API once (same request shape as `client.search`, `limit = maxResults × candidateMultiplier`).
3. Rerank the same result set twice locally by importing `rerank`/`selectRanked` from `../lib/ranking.ts` (strip-types makes this importable from an `.mjs` entry): once with `storyTerms: []`, once with the candidate term list.
4. Print a per-prompt table: `kind before → kind after`, `rank before → rank after`, `composite before → after`, and whether the result cleared threshold+selection. Success criterion: story-relevant results move into the selected set (or up within it) on ≥ 80% of the prompts, with no non-story result newly displaced below threshold except chatter.

Because step 3 is pure local re-scoring of one fetched result set, before/after is perfectly controlled (no index drift between runs) — strictly better than the "run the agent twice with debug on" procedure from the issue, though that end-to-end check (grep the new §3.4 debug lines for `[story]`) is still worth doing once after deploying the config.

### 4.3 Regression

Full suite (`node --test --experimental-strip-types` across `*.test.ts`) must stay green — 205 tests today. The only behavior-bearing changes are §3.2 matching and §3.3 normalization; `auto-context` changes are log-only.

## 5. Risks / tradeoffs

1. **Manual lists go stale.** This is curation-by-hand; after a story pivot the old terms keep granting +0.35 to a dead thread until someone edits config. The debug tally makes it observable but not self-healing. Accepted for v1; auto-derivation is the follow-up.
2. **The boost is large relative to score spreads.** `storyBoost + curationBoost = 0.35` (defaults) means a story match can beat a curated memory that is up to 0.15 more relevant, and any chatter up to 0.55 more relevant. That's the point — but with a false-positive term it's the failure mode too. Mitigations: word-boundary matching (§3.2), term-selection guidance (§3.1), and operators can lower `storyBoost` independently.
3. **Story terms reorder; they don't rescue recall.** A story memory below `relevanceThreshold − 0.35` on base score still won't surface, and one outside the fetched candidate pool can't be reranked at all. If the true fix for a given miss is recall, the levers are `candidateMultiplier` / `relevanceThreshold`, not this.
4. **Chatter about the story is boosted as story — and escapes the chatter quota.** `classifyResult` checks story terms *first* (`lib/ranking.ts:80-82`), so a hot-buffer echo (session-UUID resourceId) whose highlight mentions "omuerta" classifies as `story`: it gets +0.35 instead of −0.2, and `selectRanked`'s `chatterQuota` never counts it. With frequent chatter about the active story, injected context can be majority story-flavored echoes. This is arguably by design ("the story / its notes & threads" per the classifier comment) and this proposal deliberately does not change precedence — but the operator must know, and the §3.4 per-result debug lines expose it (`[story]` lines with UUID resourceIds). If it proves harmful in practice, a follow-up can add a `storyRequiresCuration`-style knob; don't pre-engineer it.
5. **Matching-semantics change for existing deployments.** Any deployment that already set `storyTerms` gets stricter matching after §3.2 (boundary vs substring). For well-chosen terms (proper nouns) nothing changes; a deployment relying on a deliberate prefix match (e.g. `"omuert"` to catch inflections) would silently lose it. Call it out in the changelog; the fix is adding the full inflected forms.

## 6. Rollout

- **Default:** `storyTerms` stays `[]` — the feature remains opt-in and the story lane stays dormant until an operator populates it. `DEFAULT_RANKING` is unchanged.
- **Backward compatibility:** additive-safe. No new config keys, no schema migration, no data migration. Empty/absent `storyTerms` short-circuits before any matching (`storyTerms.length > 0` guard is already there), so zero cost for non-users. The only behavior delta for existing users is §3.2's stricter matching (Risk 5) and slightly more debug log output under `debug: true`.
- **Release:** minor version bump (behavioral change for configured users + new uiHints), not patch. No feature flag needed — `ranking.enabled` already gates the whole pipeline.
- **Reference deployment:** populate `storyTerms` there first, run `docs/story-terms-verify.mjs` before/after, watch one day of `debug: true` logs for `[story]`-tagged UUID rows (Risk 4) before recommending in the README.

## 7. Effort estimate

**S** — the ranking lane, config parsing, and schema already exist; the delta is ~30 lines (matcher + normalization + debug lines), 4–5 unit tests, one probe script, and documentation.
