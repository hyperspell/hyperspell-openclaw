# Proposal 03 — Instrument whether `chatterQuota` is actually binding

Idea #3 from the retrieval-relevance brainstorm ([#66](https://github.com/hyperspell/hyperspell-openclaw/issues/66)). Design doc only; no functional code ships with this PR.

## 1. Summary

`chatterQuota` (default 2) hard-caps how many "chatter" results — auto-saved hot-buffer conversation fragments — may be injected per search, but we have no data on how often that cap actually fires. If chatter rarely reaches 3+ above-threshold candidates in a single search, tuning the quota is a no-op and the perceived fluff is coming from somewhere else (most likely items misclassified as "curated"). This proposal adds cheap, debug-gated instrumentation: `selectRanked` reports which chatter results it cut *because of the quota* (as opposed to the threshold or `maxResults`), the caller logs one line per affected search, and after a ~1-week observation window a simple grep over gateway logs yields a drop rate that feeds a concrete keep/deprioritize decision rule.

## 2. Problem

The quota is enforced in exactly one place, the selection loop in `selectRanked` (`lib/ranking.ts:128-146`):

```ts
export function selectRanked(
	ranked: RankedResult[],
	maxResults: number,
	threshold: number,
	chatterQuota: number,
): RankedResult[] {
	const out: RankedResult[] = [];
	let chatter = 0;
	for (const r of ranked) {
		if (r._composite < threshold) continue;
		if (r._kind === "chatter") {
			if (chatter >= chatterQuota) continue;   // ← the quota "binding" event, currently invisible
			chatter++;
		}
		out.push(r);
		if (out.length >= maxResults) break;
	}
	return out;
}
```

Three different mechanisms can cut a chatter result here, and today's logs cannot tell them apart:

1. **Threshold** — `_composite < threshold` (line 137). The `chatterPenalty` already pushed it below the bar.
2. **Quota** — `chatter >= chatterQuota` (line 139). The only case where the quota is the *binding* constraint.
3. **`maxResults`** — the `break` at line 143 fires before the result is ever considered.

The sole production caller is the single-user path of the auto-context hook (`hooks/auto-context.ts:202-207`), which already logs a per-injection tally (`hooks/auto-context.ts:214-216`):

```
auto-context: injecting (ranked) {"chatter":2,"curated":1} from 12 candidates (chatter cap 2)
```

That tally shows what got *in*, never what the quota kept *out*. `{"chatter":2}` is ambiguous between "exactly 2 chatter candidates cleared the threshold" (quota irrelevant) and "9 cleared it and 7 were cut" (quota doing heavy lifting). Until we can distinguish those, any change to `chatterQuota` — idea-level or config-level — is a guess. Notably, if quota-drops turn out to be near zero while injected context still feels fluffy, the fluff is arriving under the `curated`/`other` labels, which points at `classifyResult` (`lib/ranking.ts:75-88`) rather than at the quota.

## 3. Proposed design

### 3.1 Where the signal lives: three options

`selectRanked` is a pure function in `lib/ranking.ts` with no `log` import (the module imports only a type from `client.ts`). Three ways to get the drop count out:

**(i) Import `logger.ts` into `lib/ranking.ts` and log inline.**
Smallest diff, zero call-site changes. But it couples pure ranking math to a runtime singleton (`initLogger` state), makes the unit tests either noisy or dependent on logger setup, and strands the drop info inside the function — the caller, which owns the `auto-context:` log context (candidate count, cap value, session), can't include it in its existing tally line. Rejected.

**(ii) Return quota-drop metadata alongside the selected array (change the return type). — RECOMMENDED**
The function stays pure and fully unit-testable; the caller decides what to log. The cost is a breaking signature change, but there is exactly one production call site (`hooks/auto-context.ts:202`) and one test file (`lib/ranking.test.ts`), both in-repo — this is not a published API surface (the npm package exports the plugin, not `lib/ranking.ts` internals). Returning the dropped *results* (not just a count) is free — they're already in hand at the `continue` — and their `_composite` scores answer the follow-up question "were the dropped echoes barely over the bar, or genuinely competitive?" without a second instrumentation pass.

**(iii) Optional mutable out-param, e.g. `selectRanked(..., stats?: { quotaDrops: RankedResult[] })`.**
No call-site breakage for callers that don't care, but out-params are un-idiomatic in this codebase, the caller still has to be edited to pass and read the object, and optional side-channels are easy to silently drop in a refactor. A `selectRankedWithStats` wrapper variant has the same shape with extra API surface. Rejected — (ii) is barely more churn and strictly more honest.

### 3.2 The modified `selectRanked`

```ts
export type SelectOutcome = {
	selected: RankedResult[];
	/** Chatter that cleared the threshold but was cut ONLY by the quota.
	 * Ranked order preserved; every entry is a search the quota changed. */
	quotaDropped: RankedResult[];
};

export function selectRanked(
	ranked: RankedResult[],
	maxResults: number,
	threshold: number,
	chatterQuota: number,
): SelectOutcome {
	const selected: RankedResult[] = [];
	const quotaDropped: RankedResult[] = [];
	let chatter = 0;
	for (const r of ranked) {
		if (r._composite < threshold) continue;
		if (r._kind === "chatter") {
			if (chatter >= chatterQuota) {
				quotaDropped.push(r);
				continue;
			}
			chatter++;
		}
		selected.push(r);
		if (selected.length >= maxResults) break;
	}
	return { selected, quotaDropped };
}
```

Correctness property worth stating explicitly: because the loop `break`s the moment `maxResults` is reached, any chatter sitting *after* the break point is never examined and therefore never counted as a quota drop. That is the desired semantics — such a result would have been cut by `maxResults` regardless, so the quota was not the binding constraint for it. Conversely, every `quotaDropped` entry was skipped while output slots were still open, i.e. the quota genuinely altered what got injected (either a lower-ranked non-chatter result took the slot, or the slot went unfilled — both are output changes).

### 3.3 The caller change (`hooks/auto-context.ts`)

```ts
const { selected, quotaDropped } = selectRanked(
	ranked,
	cfg.maxResults,
	cfg.relevanceThreshold,
	ranking.chatterQuota,
)
formatted = formatSelected(selected, cfg.relevanceThreshold)
if (quotaDropped.length > 0) {
	log.debug(
		`auto-context: chatter quota (${ranking.chatterQuota}) dropped ${quotaDropped.length} above-threshold candidate(s), top dropped composite ${quotaDropped[0]._composite.toFixed(2)}`,
	)
}
```

Two deliberate choices:

- **A dedicated line, not a field folded into the existing tally.** The tally at `hooks/auto-context.ts:214-216` only fires `if (formatted)`, but a quota drop can occur even when nothing is injected (e.g. `chatterQuota: 0` with only chatter clearing the threshold → `selected` is empty, `formatSelected` returns null). The drop line must be unconditional on `formatted` or the count under-reports exactly in the configurations we'd most want to study. A stable prefix (`chatter quota`) also makes the later grep trivial.
- **Log the top dropped composite.** One number, already computed, distinguishes "dropped an echo at 0.61 with threshold 0.6" (quota barely mattered) from "dropped an echo at 0.88" (quota is suppressing highly competitive chatter — which is either working as designed or starving recall, depending on your priors; either way it's the interesting case).

Multi-user path note: `multiUserSearch` (`hooks/auto-context.ts:242+`) does not call `selectRanked` today, so no change there. If ranking ever lands on that path, the outcome type carries the instrumentation along for free.

### 3.4 Aggregate signal: logs + grep, no in-process counters

Rejected alternative: a module-level running counter (total drops / total searches) reported periodically. The plugin runs inside a long-lived gateway process but restarts on every `plugins update` / gateway restart, so in-memory counters silently reset and mislead; persisting them adds a write path this diagnostic doesn't deserve. The idea's own test framing ("add a debug log line, run for a while, check the count") matches the repo's existing practice: emit structured-enough debug lines, aggregate offline with grep.

Both the numerator and the denominator already exist or come from this change, and both are `log.debug` (so consistently gated together):

- **Denominator** — searches performed: `auto-context: searching for "..."` (`hooks/auto-context.ts:183`).
- **Numerator** — searches where the quota bound: the new `chatter quota (N) dropped ...` line.

Aggregation over a gateway log window:

```sh
D=$(grep -c 'auto-context: searching for' gateway.log)
N=$(grep -c 'auto-context: chatter quota' gateway.log)
echo "quota bound in $N of $D searches"
# distribution of drops per event + how competitive the dropped items were:
grep 'auto-context: chatter quota' gateway.log \
  | sed -E 's/.*dropped ([0-9]+) .*composite ([0-9.]+).*/\1 \2/' | sort | uniq -c
```

### 3.5 Decision rule

Observation window: at least **7 days of normal use and ≥200 searches** on a live deployment with `debug: true` (alinea is the natural candidate — this is a pure read-path observation, no data mutation). Then:

- **Drop rate < 5%** → the quota is not the binding constraint. Deprioritize idea #3's follow-ons (lowering `chatterQuota`); redirect attention to `classifyResult` precision — sample injected "curated" items from the same window and check for mislabeled conversational noise (bare-UUID rows that acquired titles, synced fragments with human-looking names).
- **Drop rate ≥ 20%** → the quota binds routinely. It is doing real work; tuning it (or the `chatterPenalty` upstream) has leverage. Check the top-dropped-composite distribution: if drops cluster far above `relevanceThreshold`, also sanity-check that recall isn't being starved before tightening further.
- **5–20%** → inconclusive; extend the window, and segment the drop events by prompt type before deciding.

Whatever the outcome, record it with a dated note (`docs/` findings file, matching `docs/hotbuffer-verification-results-*.md` precedent) so the next relevance session doesn't redo the measurement.

## 4. Test plan

### Unit tests (`lib/ranking.test.ts`)

Existing `selectRanked` tests (`lib/ranking.test.ts:93-113`) update mechanically: `const sel = selectRanked(...)` becomes `const { selected } = selectRanked(...)`. New cases, in the file's existing style (`node:test` + `node:assert`, the `ranked(kind, composite, id)` helper at line 86):

```ts
test("selectRanked — reports chatter cut ONLY by the quota, in ranked order", () => {
	// 5 above-threshold echoes, quota 2 → exactly 3 reported dropped.
	const list = [
		ranked("chatter", 0.9, "c1"),
		ranked("chatter", 0.85, "c2"),
		ranked("chatter", 0.8, "c3"),
		ranked("curated", 0.7, "k1"),
		ranked("chatter", 0.65, "c4"),
		ranked("chatter", 0.62, "c5"),
	];
	const { selected, quotaDropped } = selectRanked(list, 10, 0.6, 2);
	assert.deepEqual(quotaDropped.map((r) => r.resourceId), ["c3", "c4", "c5"]);
	assert.equal(selected.filter((r) => r._kind === "chatter").length, 2);
});

test("selectRanked — below-threshold chatter is a threshold cut, not a quota drop", () => {
	const list = [ranked("chatter", 0.9, "c1"), ranked("chatter", 0.5, "c2")];
	const { quotaDropped } = selectRanked(list, 10, 0.6, 1);
	assert.deepEqual(quotaDropped, [], "c2 fell to the threshold; quota never saw it");
});

test("selectRanked — chatter past the maxResults break is not counted as a quota drop", () => {
	// maxResults=1: the curated result fills the only slot and the loop breaks
	// before the echoes are examined — maxResults bound, not the quota.
	const list = [ranked("curated", 0.9, "k1"), ranked("chatter", 0.8, "c1"), ranked("chatter", 0.7, "c2")];
	const { selected, quotaDropped } = selectRanked(list, 1, 0.6, 2);
	assert.deepEqual(selected.map((r) => r.resourceId), ["k1"]);
	assert.deepEqual(quotaDropped, []);
});

test("selectRanked — quota 0 reports every above-threshold echo as dropped", () => {
	const list = [ranked("chatter", 0.9, "c1"), ranked("chatter", 0.8, "c2")];
	const { selected, quotaDropped } = selectRanked(list, 10, 0.6, 0);
	assert.deepEqual(selected, []);
	assert.deepEqual(quotaDropped.map((r) => r.resourceId), ["c1", "c2"]);
});

test("selectRanked — non-chatter never appears in quotaDropped", () => {
	const list = [ranked("curated", 0.9, "k1"), ranked("other", 0.7, "o1"), ranked("story", 0.65, "s1")];
	const { quotaDropped } = selectRanked(list, 10, 0.6, 0);
	assert.deepEqual(quotaDropped, []);
});
```

Run with the repo convention: `node --test --experimental-strip-types lib/ranking.test.ts`, plus the full suite and `tsc` (the signature change must compile cleanly at the one call site — remember, biome lint output is noise here; tsc/build is the real gate).

### Live observation

No new verification script is needed (unlike `docs/hotbuffer-verify.mjs` etc., there is no API behavior to probe — this is purely local selection logic). Procedure:

1. Deploy to a live agent with `debug: true` and ranking enabled (defaults: `chatterQuota: 2`, `relevanceThreshold` per config).
2. Optionally smoke the wiring on day one: issue a prompt known to be echo-heavy (a topic discussed across many sessions) and confirm either the drop line fires or the tally shows `chatter` below quota — i.e. confirm the instrumentation path executes, not that drops occur.
3. Let it run ≥7 days / ≥200 searches; run the grep aggregation from §3.4.
4. Apply the §3.5 decision rule; write the dated findings note.

## 5. Risks / tradeoffs

- **Signature break.** `SelectOutcome` breaks any out-of-tree caller of `selectRanked`. None are known (it's an internal lib of a plugin, not a documented export), and the type system converts silent misuse into a compile error — a caller that ignores the change fails `tsc` rather than misbehaving.
- **Debug-gated denominator bias.** Both numerator and denominator lines are debug-level, so they appear and disappear together — the *rate* is unbiased. But the measurement only happens on deployments running `debug: true`; if the observed agent's usage is atypical (e.g. alinea's memory-review-heavy sessions skew chatter density upward), say so in the findings note rather than generalizing.
- **Retained references.** `quotaDropped` holds `RankedResult` objects until the search handler returns — bytes per search, freed immediately after; not a real memory concern.
- **Log volume.** One extra line per quota-binding search, debug-gated. Negligible next to the existing per-search debug output.
- **Interpretation trap.** A low drop rate says the *quota* isn't binding; it does not say chatter isn't a problem — chatter may be losing to the threshold (penalty working) or sneaking in as misclassified "curated" (penalty bypassed). The §3.5 rule routes each outcome explicitly to avoid this misread.

## 6. Rollout

Ship the return-shape change and the caller's drop line **always-on in code, debug-gated in output** — `log.debug` already no-ops unless `initLogger(..., debug)` was called with `debug: true` (`logger.ts`), so production deployments with debug off pay only an array allocation per search. No new config key, no `openclaw.plugin.json` schema change, no behavior change to what gets injected. Degrades safely by construction: the instrumentation cannot alter selection output, only report on it. Enable `debug: true` on the observation deployment for the measurement window, then leave the instrumentation in place — it is the permanent answer to "is the quota doing anything?" for all future tuning, not a temporary probe to rip out.

## 7. Effort estimate

**S** — a ~10-line change to one pure function, a 5-line caller edit, and mechanical test updates plus five new cases; the only care point is not conflating quota drops with threshold/maxResults cuts, which §3.2 pins down.
