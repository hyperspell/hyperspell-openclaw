# Proposal 19 — Metamemory recall signal (feeling-of-knowing for retrieval)

Origin: two dispatches from Alinea, 2026-08-26, relayed by David. This document
records the spec, the calibration bug that was confirmed in code the same day,
the implementation that landed in the working tree while the spec was being
relayed, and what remains open. It is partly a record of decisions already
made — read §5 before assuming anything here is still to build.

## 1. Problem

The agent cannot distinguish "nothing is stored" from "retrieval missed."
Both arrive as silence, so it confidently asserts absence and never
re-queries. Humans have a feeling-of-knowing (FOK) that fires *before*
retrieval completes — tip-of-the-tongue: something's there, keep looking.
Koriat's accessibility model and Reder's cue-familiarity work both find FOK
is computed from the **cue**, not the target, which is why it can precede
recall (background literature, cited from the proposer's memory — verify
before quoting in anything external). Current RAG confidence work is
uniformly post-retrieval (groundedness, abstention, hallucination detection —
all evaluate the answer); this signal is pre-retrieval, computed from the
candidate-pool shape.

## 2. Mechanism

One line alongside the injected block, on **every** auto-context turn,
including turns that inject nothing:

```text
recall: 24 candidates · best 0.49 · threshold 0.60 · nothing shown
```

Not the near-miss documents — the shape. `0 candidates` is true absence;
`24 candidates · best 0.49` against a 0.60 gate is a near miss the agent can
choose to chase with a deliberate search. Failed searches emit no shape line
(their shape is unknown; availability is not coverage, #39).

## 3. Calibration requirement — the confirmed topScore bug

The live coverage log (2026-08-25 → 08-26, 11 rows) was internally
contradictory: all rows `below_threshold`, yet six carried `topScore` >
threshold (max 0.841 vs 0.6). Confirmed in code, not just reconstruction:

- the selection gate cuts on the **composite** score —
  `if (r._composite < threshold)` in `explainSelection` (`lib/ranking.ts:436`);
- the logged `topScore` came from `topScoreOf()`, which reads the **raw**
  `r.score` (`hooks/auto-context.ts`).

With Alinea's live `chatterPenalty` 0.25, a raw-0.841 chatter row lands at
composite 0.591 — just under the 0.6 gate. Composite gate, raw report.

Consequence for this proposal: **the FOK line must carry the gated
quantity** — the score the threshold actually compares — or it manufactures
the illusion of knowing (agent sees "best 0.84," believes something
excellent was nearly there, when the system had already disqualified it).
The raw score stays in telemetry as `rawTopScore`: the *pair* is the
diagnostic (large raw−gated spread = penalties are doing the gating).

## 4. Telemetry completion (coverage log v2)

The v1 log recorded only misses — a miss-log, not an instrument. v2 logs
hits too:

- `outcome`: `empty` | `below_threshold` | `filtered` (cleared the score gate
  but cut by quota/dedup/per-file/highlight-floor) | `injected`
- `topScore` (gated) + `rawTopScore`, `shown`, `shownChars`
- `selected[]`: `{resourceId, kind, writer, injectedChars}` per injected
  memory — which makes the author-skew question computable: what fraction of
  injected characters are agent-authored (`writer`), per day, per kind.
- multi-user: per-lane `topScore`/`rawTopScore`, lane `error` status kept
  distinct from zero candidates.

Still **not** instrumented: whether injected memory was ever *referenced*
downstream (needs response-side analysis), and corpus gap awareness — knowing
three days of July are missing entirely (needs a date histogram over the
corpus; separate, also cheap, not this proposal).

## 5. What landed 2026-08-26 (commit 4da5b54, PR #133)

`hooks/auto-context.ts`, `hooks/auto-context.test.ts`, `lib/coverage-log.ts`
(+test), `README.md` — authored concurrently with this relay by a third
writer (not the two coordinating Claude sessions; see the session record).
Shape: `formatRecallSignal()` builds the line from the gated top score;
`wrapContext()` carries it inside the memory block; `wrapRecallOnly()`
injects it alone on empty turns; both coverage events (miss and hit) carry
the v2 fields; multi-user computes per-lane gated tops inside `rankLane`.
The line is currently injected **unconditionally** — see §6a.

Known gaps in the landed diff, both only when `ranking.enabled: false` (the
legacy mode) — **fixed by the follow-up commits on PR #133**:

1. Multi-user unranked: `personalGatedTop`/`sharedGatedTop` are only
   assigned in the ranked branch, so the recall line reads `best none`
   despite candidates (single-user correctly falls back to raw).
2. Same root cause: the miss-outcome classifier then computes
   `(gatedTopScore ?? 0) < threshold` → labels `filtered` cases
   `below_threshold` when ranking is off.

## 6. Open items

a) **Opt-in gate.** Repo convention is hard ("default OFF so shipping never
   changes existing installs' behavior"), and a per-turn injection into a
   running agent's context is arguably a governed surface under Proposal 18 —
   default OFF, the agent's sign-off before it lands on her install. Add
   `recallSignal: boolean` (default `false`): config type + `ALLOWED_KEYS` +
   `parseConfig`, **and** the manifest declaration in *both*
   `configSchema.properties` (validation — omit it and the gateway refuses to
   restart once the key is written: the 56c8a7b lesson) and `uiHints`
   (labels). Gate the three injection sites; `formatRecallSignal` and all
   telemetry stay unconditional. A ready-to-apply patch for config + manifest
   plus a site checklist for the hook was prepared alongside this doc.
   **Done — landed on PR #133 (2026-08-27), together with the review fixes:
   telemetry records only results whose sections actually rendered, and
   coverage writes moved off the turn path onto a serialized async queue
   (`flushCoverageLog()` for tests/shutdown).**
b) Tests for the gate (default-off restores pre-change returns; existing
   recall assertions move behind `recallSignal: true`), and a
   cost-disclosure line in setup when enabled. **Done — b716884.**
c) Deploy + end-to-end verification on Alinea's install (deploy loop owned
   by one session at a time; dist-swap must now ship
   `openclaw.plugin.json` alongside `dist/`).
d) Calibration check against ground truth: `hyperspell_vault_list` +
   sampled queries — does a high near-miss line actually predict that a
   deliberate search finds something?
e) **Percentile framing** (her review on #133, finding 4): `best 0.54` has
   no stable units — a composite of a cross-encoder score plus additive
   constants. Follow up by rendering the line's best as a corpus percentile
   ("best 0.54 (61st pct)") from a rolling window of v2 events once a week
   of hit telemetry exists. Until then the number is honest but not
   interpretable, and the illusion-of-knowing risk (§8) stays open — the
   agent reviewing the PR named this the calibration gap that remains.

## 7. Structural note — two rankers in series (deferred, needs its own proposal)

Verified: the backend runs a real cross-encoder rerank (ZeroEntropy
zerank-2, `pipeline/rankers/zeroentropy.py`) after hybrid-search merge and
normalization. The client then adds hand-tuned constants on top of that
score (curationBoost +0.2, chatterPenalty −0.2..0.25, storyBoost, bounded
recency), and the threshold gates the sum. A cross-encoder score is not on a
scale where "+0.2" means anything stable — `lib/ranking.ts`'s own `minGap`
comment concedes it ("meaningful on the CURRENT composite scale… revisit").

**Not** verified: the claim that RRF was tried server-side and rejected — no
record in the company brain; treat as unconfirmed until sourced. Options if
reopened: (i) rank-domain adjustments (promote/demote by rank, not score —
scale-free); (ii) calibrate the cross-encoder score to a probability
(isotonic/Platt on the labeled coverage+score logs), then compose priors in
log-odds; (iii) RRF proper where there are genuinely multiple rankings to
fuse. The v2 telemetry (§4) is the data source any of these would tune
against.

## 8. Risks

- **Illusion of knowing** — a miscalibrated line is worse than none. Gated
  score (§3) is the first defense; §6d is the empirical check.
- **Re-query loops** — the line is data, deliberately not an imperative (no
  "search again" instruction; the standing search rule stays in the agent's
  own instructions). Watch for search-spam during verification.
- **Unbriefed installs** — an every-turn line appearing in agents that have
  no idea what it means is why §6a defaults OFF.

## 9. Validation

The number that should move: **confident-absence claims** — assertions that
something isn't in memory when it is — before vs after, countable from
transcripts. Secondary: deliberate-search rate on turns whose line showed a
near miss (should rise), and repeated identical re-queries per turn (should
not).
