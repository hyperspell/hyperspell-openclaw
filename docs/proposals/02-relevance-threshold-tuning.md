# Proposal 02 — Data-driven `relevanceThreshold` tuning

Idea #2 from the retrieval-relevance brainstorm (issue #66). This is an
implementation guide, not an implementation: the deliverable is a lightweight
instrumentation + review process that produces the data needed to justify (or
reject) raising the threshold. No functional code ships in this PR.

## 1. Summary

`relevanceThreshold` defaults to `0.6` and we have zero data on where real
signal vs. real fluff actually lands on this corpus — raising it blind is a
guess that could silently cut useful memory. The plan: add an opt-in,
env-var-gated JSONL score log to the auto-context pipeline that records every
candidate's composite score, kind, selection outcome, and a snippet of the
matched text; run it for ~a week of normal use; label each logged candidate
useful/noise with a small review script; then sweep candidate thresholds over
the labeled data and only adopt a value that keeps useful-recall high while
cutting a meaningful fraction of noise. The instrumentation is a no-op unless
explicitly enabled and degrades safely (a failed write can never break
retrieval).

## 2. Problem

The threshold is consumed in three places, always against a score whose
distribution we've never observed:

- `config.ts:576` — `relevanceThreshold: (cfg.relevanceThreshold as number) ?? 0.6`
  (typed at `config.ts:164`, allowed key at `config.ts:185`).
- `hooks/auto-context.ts` single-user path — when `cfg.ranking.enabled`,
  `selectRanked(ranked, cfg.maxResults, cfg.relevanceThreshold, ranking.chatterQuota)`
  (line ~202) filters on the **composite** score; the fallback
  `formatHighlightBullets(results, cfg.maxResults, cfg.relevanceThreshold)`
  (line ~219) filters on raw doc/highlight scores.
- `hooks/auto-context.ts` `multiUserSearch` — the same pipeline via the local
  `format()` closure (line ~334), applied separately to personal and shared
  result sets.

Two things make gut-feel tuning especially unreliable here:

1. **The threshold applies to the composite, not raw relevance.**
   `scoreResult` (`lib/ranking.ts:91`) computes
   `composite = base ± {curationBoost, storyBoost, chatterPenalty}` with
   defaults `+0.2 / +0.15 / −0.2` (`DEFAULT_RANKING`, `lib/ranking.ts:36`).
   A curated note at base 0.45 clears 0.6; a chatter fragment needs base 0.8.
   Raising the threshold therefore shifts the cut line *differently per kind*
   — it's partially redundant with `chatterPenalty` — and we can't reason
   about that interaction without seeing real numbers.
2. **The only existing visibility is a tally, not scores.** The debug line at
   `hooks/auto-context.ts:214` logs kind counts
   (`auto-context: injecting (ranked) {...} from N candidates`) but never the
   scores themselves, and terminal scrollback is not reviewable after the
   fact. There is currently no way to answer "what composite did that useless
   injection score?" a day later.

## 3. Proposed design

Three small pieces: (a) a selection-explainer in `lib/ranking.ts` so cut
reasons are first-class, (b) an opt-in JSONL score log in
`hooks/auto-context.ts`, (c) two ad hoc review/analysis scripts in `docs/`
(same standalone-`.mjs` precedent as `docs/hotbuffer-verify.mjs` and
`docs/filter-dialect-test.mjs`, except these read the local log file rather
than the live API).

### 3a. `explainSelection` in `lib/ranking.ts`

`selectRanked` (`lib/ranking.ts:128`) returns only the survivors; for tuning
we need every candidate annotated with *why* it was cut. Add a pure sibling
and re-implement `selectRanked` on top of it so the two can never drift:

```ts
export type SelectionCut = "threshold" | "max-results" | "chatter-quota" | null;

export type SelectionExplained = {
	result: RankedResult;
	selected: boolean;
	cut: SelectionCut;
};

/** One pass over ranked results, annotating each with its selection outcome.
 * Same policy as selectRanked; selectRanked is now derived from this. */
export function explainSelection(
	ranked: RankedResult[],
	maxResults: number,
	threshold: number,
	chatterQuota: number,
): SelectionExplained[] {
	const out: SelectionExplained[] = [];
	let chatter = 0;
	let kept = 0;
	for (const r of ranked) {
		if (r._composite < threshold) {
			out.push({ result: r, selected: false, cut: "threshold" });
			continue;
		}
		if (kept >= maxResults) {
			out.push({ result: r, selected: false, cut: "max-results" });
			continue;
		}
		if (r._kind === "chatter" && chatter >= chatterQuota) {
			out.push({ result: r, selected: false, cut: "chatter-quota" });
			continue;
		}
		if (r._kind === "chatter") chatter++;
		kept++;
		out.push({ result: r, selected: true, cut: null });
	}
	return out;
}

export function selectRanked(
	ranked: RankedResult[],
	maxResults: number,
	threshold: number,
	chatterQuota: number,
): RankedResult[] {
	return explainSelection(ranked, maxResults, threshold, chatterQuota)
		.filter((e) => e.selected)
		.map((e) => e.result);
}
```

Ordering note: the threshold check comes first so a below-the-bar result is
always attributed to `"threshold"` even when the max-results cap is already
full — that's the attribution the tuning analysis cares about. The *selected
set* is identical to today's `selectRanked` (existing tests in
`lib/ranking.test.ts` serve as the regression suite; see §4). One behavioral
nuance: the current loop `break`s at `maxResults` and never scores the tail,
while `explainSelection` walks the whole array — the pool is at most
`maxResults × candidateMultiplier` (default 3×) items, so the cost is nil.

### 3b. Score log in `hooks/auto-context.ts`

Gate on an environment variable, **not** a config key: this is temporary
instrumentation, and adding a config key would mean touching `ALLOWED_KEYS`
in `config.ts` *and* the `openclaw.plugin.json` `configSchema`
(`additionalProperties: false`) for something we hope to be done with in two
weeks. Read the env var at call time (not module load) so tests can set it.

```ts
import { appendFileSync } from "node:fs";
import { type SelectionExplained, explainSelection, rerank } from "../lib/ranking.ts";

/** Opt-in score sampling for relevanceThreshold tuning (proposal 02).
 * Writes one JSONL line per candidate when HYPERSPELL_SCORE_LOG names a file.
 * Must never throw into the retrieval path. */
function logScoreSamples(
	prompt: string,
	sessionId: string | undefined,
	scope: "single" | "personal" | "shared",
	explained: SelectionExplained[],
	threshold: number,
): void {
	const path = process.env.HYPERSPELL_SCORE_LOG;
	if (!path || explained.length === 0) return;
	const ts = new Date().toISOString();
	const lines = explained.map((e) => {
		const r = e.result;
		const top = [...r.highlights].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
		return JSON.stringify({
			ts,
			sessionId,
			scope,
			prompt: prompt.slice(0, 80),
			resourceId: r.resourceId,
			title: (r.title ?? "").slice(0, 60),
			kind: r._kind,
			base: Number(r._base.toFixed(4)),
			composite: Number(r._composite.toFixed(4)),
			threshold,
			selected: e.selected,
			cut: e.cut,
			snippet: (top?.text ?? "").replace(/\s+/g, " ").slice(0, 120),
		});
	});
	try {
		appendFileSync(path, `${lines.join("\n")}\n`);
	} catch {
		// instrumentation must never break retrieval
	}
}
```

Call sites (ranked path only — ranking is on by default via
`DEFAULT_RANKING.enabled`, and the non-ranked fallback has no composite to
tune against):

- **Single-user path** (`buildAutoContextHandler`): replace the
  `selectRanked` call at line ~202 with `explainSelection`, derive
  `selected` from it, and log every candidate:

  ```ts
  const ranked = rerank(results, ranking);
  const explained = explainSelection(
  	ranked, cfg.maxResults, cfg.relevanceThreshold, ranking.chatterQuota,
  );
  logScoreSamples(prompt, currentSessionId, "single", explained, cfg.relevanceThreshold);
  const selected = explained.filter((e) => e.selected).map((e) => e.result);
  ```

- **Multi-user path**: same substitution inside the `format()` closure in
  `multiUserSearch` (line ~334), with `scope` = `"personal"` / `"shared"`
  (thread a scope argument through the closure).

Also extend the existing debug tally line (line ~214) with the composite
range of what was injected — cheap corroboration in gateway logs even when
the JSONL isn't enabled:

```ts
log.debug(
	`auto-context: injecting (ranked) ${JSON.stringify(tally)} from ${results.length} candidates ` +
	`(chatter cap ${ranking.chatterQuota}, composite ${selected.at(-1)?._composite.toFixed(2)}–${selected[0]?._composite.toFixed(2)})`,
);
```

Known blind spot, accepted: `formatSelected` (line ~75) can still drop a
*selected* result whose highlights all fall below its floor. The log records
selection, which is what the threshold governs — final-injection divergence
is rare and out of scope here.

### 3c. Review workflow — labeling what was useful vs. noise

`docs/score-review.mjs` — a standalone Node script (no deps, follows the
`docs/*.mjs` precedent) that turns the raw log into labeled data:

- Read `HYPERSPELL_SCORE_LOG` (path via argv), group lines into search
  events by `(ts, sessionId, prompt)`.
- For each event, print the prompt then each candidate:
  `[kind] composite=0.71 (base 0.51) SELECTED  "snippet…"`.
- Prompt per candidate for a label: `u` (useful — you'd want this injected
  for that prompt), `n` (noise — chatter/irrelevant, glad to lose it),
  `s`/Enter (skip — can't judge). Labels are per **event × candidate**, not
  per memory: the same memory can be useful for one prompt and noise for
  another, and that context-dependence is exactly what the threshold has to
  navigate.
- Append `{ key: `${ts}|${resourceId}`, label }` to a sibling
  `<log>.labels.jsonl`; on restart, skip already-labeled keys so labeling is
  resumable in short sittings.

Label the **whole candidate pool**, not just what was injected — the cut
candidates (`cut: "threshold"`) are the false-negative evidence: if useful
memories are already being cut at 0.6, that argues for *lowering*, and only
labeled cut items can show it.

### 3d. Analysis — does a value separate the groups?

`docs/score-analyze.mjs` joins the log with the labels and prints:

1. **Distribution**: per label (useful/noise), count, min/median/max
   composite, and a coarse ASCII histogram in 0.05 buckets — the eyeball
   check the original idea asked for.
2. **Threshold sweep**: for each candidate `t` in `0.40 … 0.90` step
   `0.05`, report
   - `useful-recall(t)` = fraction of useful-labeled candidates with
     `composite ≥ t`
   - `noise-cut(t)` = fraction of noise-labeled candidates with
     `composite < t`
   overall **and broken down by kind** — because the composite already bakes
   in ±0.2 kind adjustments, a global threshold move is not kind-neutral,
   and the per-kind view reveals whether the right lever is actually the
   threshold or `chatterPenalty`/`chatterQuota` instead.
3. The same sweep against `base` (raw relevance), to expose how much of the
   separation is the boosts doing the work vs. the underlying similarity.

**"Supported by the data" means, concretely:** adopt the largest `t` such
that

- `useful-recall(t) ≥ 0.90` (we accept losing at most 1 in 10 genuinely
  useful injections),
- `noise-cut(t) − noise-cut(0.6) ≥ 0.15` (the move must cut at least 15
  percentage points more noise than the status quo — otherwise it's churn),
- the sample has **≥ 40 useful and ≥ 40 noise** labels, drawn from **≥ 5
  distinct days** of use (guards against one day's topic dominating),
- and the per-kind sweep doesn't show the gain coming entirely from one kind
  that a targeted weight (`chatterPenalty`) would handle more surgically.

If no `t` clears all four, the correct outcome is: **keep 0.6 and record
that the threshold is not the binding lever** — that is a successful result
of this exercise, not a failure.

## 4. Test plan

Unit tests (`node --test --experimental-strip-types`, plain `node:test` +
`node:assert`, mock data via the `mk()` fixture style already in
`lib/ranking.test.ts`):

1. **Equivalence**: for a fixture pool mixing all four kinds around the
   threshold (reuse/extend the existing `selectRanked` fixtures),
   `explainSelection(...).filter(e => e.selected).map(e => e.result)` deep-equals
   the pre-refactor `selectRanked` output. All existing `selectRanked` tests
   pass unchanged (they now exercise the derived implementation).
2. **Cut attribution**: sub-threshold → `"threshold"` even when the cap is
   full; third chatter item with quota 2 → `"chatter-quota"`; above-threshold
   item past `maxResults` → `"max-results"`.
3. **Logging is inert by default**: with `HYPERSPELL_SCORE_LOG` unset, the
   auto-context handler (mock client `as unknown as HyperspellClient`
   returning fixture results) writes nothing and returns the same
   `prependContext` as before.
4. **Logging shape**: with `HYPERSPELL_SCORE_LOG` pointed at a temp file, one
   JSON-parseable line per candidate, `selected`/`cut` consistent with the
   injected block, snippets newline-free and ≤120 chars.
5. **Failure isolation**: point the env var at an unwritable path
   (e.g. a directory) — the handler still injects normally.

Live procedure (repeatable):

1. On a real instance with a mature corpus, set `HYPERSPELL_SCORE_LOG` in the
   gateway's environment (note: the *gateway process*, not your shell) and
   restart. Optionally set `debug: true` for the corroborating tally lines.
2. Use normally for 5–7 days. Expected volume: one line per candidate per
   prompt ≈ `maxResults × candidateMultiplier` (default 15) lines/turn —
   a few thousand lines/week, kilobytes each. No rotation needed.
3. Label in 2–3 sittings with `docs/score-review.mjs` until the ≥40/≥40
   floor is met (a few hundred candidates ≈ 15–30 min each sitting).
4. Run `docs/score-analyze.mjs`, apply the §3d decision rule.
5. If a new value is adopted: set `relevanceThreshold` in plugin config,
   then **re-run the capture for 2–3 days at the new value** and confirm
   useful-recall held — the one-shot sweep is an estimate, not a guarantee.

## 5. Risks / tradeoffs

- **Small, biased sample.** One person's one week of prompts is not the
  corpus's long-run query distribution; a threshold tuned to it can overfit
  (e.g. a week of heavy project work under-represents personal/story recall,
  where quiet-but-true memories score lowest). Mitigations: the ≥5-distinct-days
  rule, the conservative 0.90 recall bar, and the post-change re-capture in
  §4 step 5. Accept that this yields a *defensible* value, not an optimal one.
- **Subjective labels.** "Useful" is a judgment call, made by the same person
  who wants the threshold raised. Labeling from the logged snippet without
  the full conversation also loses context. Keep the `skip` option cheap and
  prefer skipping over guessing; require the 15-point noise-cut margin so a
  few mislabels can't flip the decision.
- **Composite conflation.** The threshold cuts on composite, so this tunes
  the threshold *jointly with the current weights*; change `chatterPenalty`
  or `curationBoost` later and the tuned threshold is stale. The per-kind and
  base-score sweeps (§3d) make this visible but don't remove it. Record the
  weight values alongside the adopted threshold.
- **Plaintext transcript snippets on disk.** The log contains prompt
  prefixes and memory excerpts. It's opt-in, local, and bounded, but the
  procedure must end with deleting the log + labels files.
- **Selection refactor risk.** Rewriting `selectRanked` over
  `explainSelection` touches the live injection path; the equivalence tests
  plus the untouched existing suite are the guard. Alternative considered:
  leave `selectRanked` alone and have the logger re-derive membership by
  identity — rejected because two copies of the quota policy *will* drift.
- **Manifest gap (pre-existing, found while writing this).**
  `relevanceThreshold` is accepted by `config.ts` (`ALLOWED_KEYS`,
  `config.ts:185`) and written by `commands/setup.ts:361`, but is **absent
  from `openclaw.plugin.json`'s `configSchema`**, which declares
  `additionalProperties: false`. If the gateway enforces the manifest schema,
  setting the tuned value in config may be rejected. Verify, and add the
  property (+ `uiHints` entry) as part of applying any new value.

## 6. Rollout

- **Phase 1 (code PR, small):** `explainSelection` + `selectRanked` refactor,
  `logScoreSamples` + call sites, debug-line extension, tests, and the two
  `docs/*.mjs` scripts. Ships fully inert: without `HYPERSPELL_SCORE_LOG`
  the only behavioral delta is the extra text on an already-debug-gated log
  line. Safe for the published npm package.
- **Interaction with `cfg.debug`:** deliberately decoupled. The JSONL log is
  gated solely by the env var (setting it *is* the opt-in; requiring
  `debug: true` too would force noisy console output on anyone tuning).
  `cfg.debug` continues to gate the human-readable tally line via
  `log.debug` (`logger.ts:26`).
- **Phase 2–3:** capture → label → analyze → (maybe) change the config value
  + fix the manifest gap, per §4. Delete the log/labels files when done.
- **Keep or remove the instrumentation?** Keep it. It's ~40 lines, inert by
  default, and re-tuning will be needed whenever ranking weights change, the
  corpus shifts regime, or the backend's scorer changes — the marginal cost
  of keeping is near zero and `explainSelection` is independently useful for
  debugging "why didn't X surface?". If the team disagrees, removal is one
  function + three call-site lines.

## 7. Effort estimate

**S** — the code is ~40 lines of instrumentation plus two dependency-free
scripts and tests (≈ one day); the real cost is calendar time (a week of
capture) and ~an hour of labeling, not engineering.
