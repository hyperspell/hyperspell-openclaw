# Proposal 11 — Per-source weighting in composite ranking

Implementation guide for idea #11 from the retrieval-relevance brainstorm
([#66](https://github.com/hyperspell/hyperspell-openclaw/issues/66)). Design
doc only — no functional code in this PR.

## 1. Summary

Add an optional `ranking.sourceWeights` map (`Record<string, number>`, e.g.
`{"notion": 1.15, "slack": 0.85}`) that multiplies a result's **base
relevance** — before the existing kind-based boost/penalty is added — by a
per-source factor. Any source not listed (including sources that don't exist
yet) falls back to a neutral `1.0`, so the feature is a mathematical no-op
until explicitly configured. This gives the composite ranker a signal it is
currently blind to: *which system the memory came from* is real evidence of
how deliberate that memory is, independent of whether it happens to carry a
title.

## 2. Problem

`classifyResult` (`lib/ranking.ts:75-88`) decides curated-vs-chatter using
only two structural facts: title presence/shape and whether `resourceId` is a
bare UUID. It never reads `r.source`, even though every `SearchResult`
carries one (`client.ts:16-19`, `source: HyperspellSource`, the string union
defined at `config.ts:6-19`: `reddit | notion | slack | google_calendar |
google_mail | box | google_drive | vault | web_crawler | dropbox | github |
trace | microsoft_teams`).

The consequence: a deliberately written Notion doc and an off-hand Slack
message that happens to have a title both classify as `"curated"` and receive
the identical `curationBoost` in `scoreResult` (`lib/ranking.ts:91-103`). At
equal raw relevance they tie exactly, and the tie-break is sort order — the
ranker has no way to express "a journaled Notion page is more intentional
memory than a titled Slack aside on the same topic."

Note what source weighting does **not** replace: the `vault` source contains
both curated memories *and* hot-buffer session fragments (that mixture is
exactly why the UUID-shape classifier exists). Source is an additional,
orthogonal signal — it cannot substitute for kind classification, which is
why the design below composes the two rather than merging them.

Also distinct from the existing `sources` config (`config.ts:249-290`,
`parseSources`): that field **filters** which sources are searched at all.
This proposal **weights** sources that are already in the result set. The two
are complementary — "don't search Reddit" is `sources`; "search Slack but
trust it a bit less" is `sourceWeights`.

## 3. Proposed design

### 3.1 Composite formula: multiplier on base relevance, before kind adjustments

Current formula (`lib/ranking.ts:97-102`):

```
composite = base + kindAdjustment
  where kindAdjustment = +storyBoost+curationBoost | +curationBoost | −chatterPenalty | 0
```

Proposed:

```
composite = base × sourceWeight(r.source) + kindAdjustment
```

Three placements were considered; multiplying only the base is the right one:

- **Additive term** (`composite = base + kindAdjustment + sourceBonus`) is
  rejected because it double-counts the "this is deliberate" signal with
  `curationBoost` in the same additive currency — a flat `+0.1` for every
  vault hit is indistinguishable from a second curation boost, and it lifts
  *irrelevant* results over `relevanceThreshold` just as much as relevant
  ones. A multiplier scales with relevance: it can't push a near-zero match
  over the threshold.
- **Multiplier on the whole composite**
  (`composite = (base + kindAdjustment) × weight`) is rejected because it
  entangles knobs: a `slack: 0.8` weight would also shrink the effective
  `chatterPenalty` for Slack results by 20%, so tuning one knob silently
  retunes another.
- **Multiplier on base only** keeps the two signals semantically orthogonal:
  `sourceWeights` answers *"how much do I trust raw similarity from this
  system?"* while the kind adjustments answer *"is this deliberately kept
  memory?"* — measured in the same additive units as before, unaffected by
  the weight. No double-counting, because the weight and the boosts act on
  different terms.

`_base` on `RankedResult` (`lib/ranking.ts:51-55`) stays the **unweighted**
`baseScore` for debuggability; the weight is visible only in `_composite`.
`selectRanked`'s threshold (`lib/ranking.ts:128-146`) applies to the composite
as today, so a sub-1.0 weight can legitimately push a marginal result below
threshold — that is intended behavior, not a side effect.

### 3.2 `lib/ranking.ts` changes

```ts
export type RankingWeights = {
	enabled: boolean;
	curationBoost: number;
	chatterPenalty: number;
	storyBoost: number;
	storyTerms: string[];
	candidateMultiplier: number;
	chatterQuota: number;
	/** Per-source multiplier on BASE relevance (applied before the kind-based
	 * boost/penalty). Keyed by Hyperspell source name; any source not listed —
	 * including sources that don't exist yet — is neutral (1.0). */
	sourceWeights: Record<string, number>;
};

export const DEFAULT_RANKING: RankingWeights = {
	// ...existing fields unchanged...
	sourceWeights: {},
};

/** Weight for a source; anything unlisted or malformed is neutral, never zero. */
export function sourceWeight(w: RankingWeights, source: string): number {
	const v = w.sourceWeights[source];
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 1;
}

export function scoreResult(
	r: SearchResult,
	w: RankingWeights,
): { kind: ResultKind; base: number; composite: number } {
	const kind = classifyResult(r, w.storyTerms);
	const base = baseScore(r);
	let composite = base * sourceWeight(w, r.source);
	if (kind === "story")
		composite += w.storyBoost + w.curationBoost;
	else if (kind === "curated") composite += w.curationBoost;
	else if (kind === "chatter") composite -= w.chatterPenalty;
	return { kind, base, composite };
}
```

The lookup-time guard in `sourceWeight` is the safety floor the repo style
demands: an unrecognized or unweighted source degrades to neutral, never
crashes and never zeroes out.

### 3.3 `config.ts` parsing

Extend `parseRanking` (`config.ts:230-247`) — the top-level `ALLOWED_KEYS`
(`config.ts:171-191`) already contains `"ranking"`, so only the sub-object
grows:

```ts
function parseSourceWeights(raw: unknown): Record<string, number> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof v !== "number") continue; // match num()'s silent-fallback convention
		if (!Number.isFinite(v) || v <= 0) {
			throw new Error(
				`ranking.sourceWeights.${k} must be a positive number (got ${v}); ` +
					`to exclude a source entirely, use the "sources" filter instead`,
			);
		}
		out[k.trim().toLowerCase()] = v;
	}
	return out;
}

function parseRanking(raw: unknown): RankingWeights {
	// ...existing fields unchanged...
	return {
		// ...
		sourceWeights: parseSourceWeights(r.sourceWeights),
	};
}
```

Two deliberate validation choices, both consistent with existing convention:

- **Non-numeric values are silently skipped**, matching how `num()` silently
  falls back for every other ranking field.
- **Explicit non-positive weights throw at parse time**, matching how
  `parseSources` throws on an invalid source name (`config.ts:261-265`): a
  weight of `0` would silently zero out a source's relevance, which is a
  filtering decision wearing a weighting costume — `sources` is the right
  tool for that, and the error message says so.
- **Keys are lowercased but NOT validated against `VALID_SOURCES`.** This
  diverges from `parseSources` on purpose — see the schema rationale below.

### 3.4 `openclaw.plugin.json` schema

The manifest's `configSchema.properties.ranking` has
`additionalProperties: false`, so `sourceWeights` needs an explicit entry:

```json
"sourceWeights": {
	"type": "object",
	"additionalProperties": { "type": "number", "exclusiveMinimum": 0, "maximum": 5 },
	"description": "Per-source multiplier on base relevance before ranking boosts/penalties (e.g. {\"notion\": 1.15, \"slack\": 0.85}). Sources not listed default to 1.0."
}
```

**Why `additionalProperties: {type: "number"}` rather than enumerating the 13
known source names:** Hyperspell adds sources on the backend independently of
this plugin's release cycle. An enumerated schema would make a config that
weights a newly-launched source *fail manifest validation* until the plugin
ships a release whose only change is a longer enum — a hard failure for what
should be a soft, forward-compatible knob. The asymmetry with `sources` (which
does fail-fast on unknown names) is justified by the failure modes: an invalid
entry in `sources` is sent to the API and silently returns nothing, so
fail-fast protects the user; an unmatched key in `sourceWeights` is a harmless
no-op (every real result still gets 1.0). The cost is that typos
(`"gogle_drive": 1.2`) are not caught — mitigation: at plugin startup, log at
debug level any configured weight key not in `VALID_SOURCES`, without failing.

No `uiHints` change is required — `uiHints` currently has no `ranking` entry
at all, and a free-form weight map is poorly served by a text field. If we
later want it surfaced, follow the `sources` hint style with
`"advanced": true`.

### 3.5 Starting default weight table

**The shipped default is `{}` — every source at 1.0, a strict no-op.** The
table below is a *documented suggestion* for operators (README "Composite
ranking" section), not code. These are priors to seed tuning, explicitly not
final values — idea #2's measurement harness is where real values come from.

| Source | Suggested weight | Reasoning |
| --- | --- | --- |
| `notion` | 1.15 | Journaled/authored pages; writing there is always deliberate. |
| `google_drive`, `box`, `dropbox` | 1.1 | Authored documents; slightly less consistently "kept" than a journal. |
| `vault` | 1.0 | Baseline — the plugin's own memory home; mixes curated notes and hot-buffer fragments, and the kind classifier (not the weight) is what separates those. |
| `github` | 1.0 | Deliberate but task-scoped; relevance already tracks intent well. |
| `google_mail`, `google_calendar` | 0.95 | Mostly-received rather than authored; mild discount. |
| `slack`, `microsoft_teams` | 0.85 | Conversational exhaust even when titled — the exact case idea #11 targets. |
| `reddit`, `web_crawler` | 0.85 | External/ambient content, not the user's own memory. |
| `trace` | 0.8 | Auto-captured agent traces; the least intentional source. |

Magnitudes are intentionally small (±15–20%): at typical relevance scores
(~0.4–0.7) a 0.85-vs-1.15 split moves composites by ~0.15–0.2, comparable to
one `curationBoost` — enough to break ties and reorder near-ties, not enough
to let source identity override a large relevance gap.

## 4. Test plan

All in `lib/ranking.test.ts`, using the existing `mk()` fixture helper (which
already accepts `source` overrides). Run with
`node --test --experimental-strip-types lib/ranking.test.ts`.

**(a) The core fixture from issue #66 — identical title/relevance, different
sources.** First pin current behavior, then show the weighted version
differentiates:

```ts
test("sourceWeights — identical title+relevance: unweighted ties, weighted differentiates", () => {
	const notionDoc = mk({
		title: "Q3 retrieval roadmap",
		resourceId: "notion-abc123",
		source: "notion" as SearchResult["source"],
		score: 0.6,
	});
	const slackAside = mk({
		title: "Q3 retrieval roadmap",
		resourceId: "slack-C042-p1699",
		source: "slack" as SearchResult["source"],
		score: 0.6,
	});

	// Today (and with default {}): both classify curated, exact composite tie.
	const plain = rerank([slackAside, notionDoc], DEFAULT_RANKING);
	assert.ok(Math.abs(plain[0]._composite - plain[1]._composite) < 1e-9);

	// Weighted: the Notion doc clearly outranks the same-topic Slack aside.
	const w = { ...DEFAULT_RANKING, sourceWeights: { notion: 1.15, slack: 0.85 } };
	const ranked = rerank([slackAside, notionDoc], w);
	assert.equal(ranked[0].source, "notion");
	// notion: 0.6×1.15 + 0.2 = 0.89 ; slack: 0.6×0.85 + 0.2 = 0.71
	assert.ok(Math.abs(ranked[0]._composite - 0.89) < 1e-9);
	assert.ok(Math.abs(ranked[1]._composite - 0.71) < 1e-9);
});
```

**(b) Unknown/unweighted source is neutral — never errors, never zeroes:**

```ts
test("sourceWeights — unlisted and unknown sources default to neutral 1.0", () => {
	const w = { ...DEFAULT_RANKING, sourceWeights: { notion: 1.15 } };
	const vaultNote = mk({ title: "Writing Notes", resourceId: "mem-1", score: 0.5 }); // source: vault, unlisted
	const future = mk({
		title: "Linear ticket",
		resourceId: "lin-1",
		source: "linear" as SearchResult["source"], // source this plugin has never heard of
		score: 0.5,
	});
	for (const r of [vaultNote, future]) {
		const { composite } = scoreResult(r, w);
		assert.ok(Math.abs(composite - (0.5 + w.curationBoost)) < 1e-9, "weight is exactly 1.0");
	}
});
```

**(c) Orthogonality — weight does not distort kind adjustments.** A weighted
chatter result: `composite = base×weight − chatterPenalty`, asserting the
penalty magnitude is unchanged by the weight (this pins the
multiplier-on-base-only decision from §3.1).

**(d) Regression — empty map is a no-op.** Score a fixture list with
`DEFAULT_RANKING` before/after the change lands; all existing tests
(including the `0.67`/`0.42` exact-value assertions in the "kept note
out-ranks louder echo" test) must pass byte-identically.

**(e) `config.test.ts` additions:** `sourceWeights` absent → `{}`; mixed-case
keys lowercased; non-numeric values skipped; `{"slack": 0}` and
`{"slack": -1}` throw with the "use sources filter" message.

## 5. Risks / tradeoffs

- **Double-counting with kind-based boosts.** A Notion doc will usually get
  *both* a >1.0 weight and `curationBoost` — that is by design (two
  independent pieces of evidence for intentionality), but it means large
  weights compound with the boost. The multiplier-on-base placement bounds
  this (the boost itself is never scaled), and the suggested magnitudes stay
  small; the guardrail worth keeping in review is "weights break ties, boosts
  express kind" — if someone reaches for `notion: 2.0`, the tuning
  conversation belongs in `curationBoost` instead. The schema's `maximum: 5`
  is a backstop, not an endorsement.
- **Evolving source list.** The lenient schema means typos in weight keys are
  silently neutral. The debug-log mitigation in §3.4 softens this; the
  alternative (enum) fails hard on new backend sources, which is worse for a
  soft knob.
- **Another guessed-not-measured knob.** The table in §3.5 is priors, not
  measurements — exactly the failure mode idea #2 (data-driven ranking
  tuning, also in #66) exists to fix. This proposal deliberately ships
  neutral defaults so that idea #2's eval harness can *derive* per-source
  weights from real retrieval outcomes instead of us hardcoding vibes. If #2
  lands first, its harness should treat `sourceWeights` as a tunable output;
  if #11 lands first, the README suggestion table should say "measure before
  you set these."
- **Weight-vs-filter confusion.** Users may reach for a tiny weight to
  "mostly hide" a source; the parse-time error on `<= 0` plus README wording
  keeps the boundary crisp (`sources` filters, `sourceWeights` weights).

## 6. Rollout

Purely additive and backward-compatible:

- `DEFAULT_RANKING.sourceWeights = {}` → `sourceWeight()` returns 1.0 for
  everything → `composite = base × 1.0 + kindAdjustment`, bit-identical to
  today. No existing config, test, or ranking outcome changes until an
  operator explicitly sets weights.
- The manifest schema change only *adds* an optional property; existing
  configs validate unchanged.
- No API surface, network behavior, or stored-data change; entirely a local
  re-ranking concern. Safe to enable on a live agent (alinea included) with
  zero behavioral delta, then experiment per-deployment.

## 7. Effort estimate

**S** — one pure-function multiplier, one config field with parse + schema
plumbing, and tests; no I/O, no new dependencies, no migration.
