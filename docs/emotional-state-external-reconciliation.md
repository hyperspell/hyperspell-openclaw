# External fetch contract: emotional-state registers

How an external process — a nightly consolidator, a reconciliation job, any
daily-synthesis pipeline that does **not** run inside this plugin — fetches a
day's stored emotional-state registers from the Hyperspell API.

Two independent judgments of a day can exist: an external nightly synthesis
(e.g. a local-LLM map-reduce over the day's material) and the live per-session
registers Tin Man (`hooks/emotional-state.ts`) stores as sessions end.
Reconciling them — divergence scoring, thresholds, where flags surface — is
the **external process's job**, and that design conversation lives on
[issue #75](https://github.com/hyperspell/hyperspell-openclaw/issues/75). This
document is the other half of the contract: the stable, verified way to fetch
the registers to reconcile against.

Endpoint facts below were **verified live against the production API on
2026-07-07**; the metadata caveat was proven live on **2026-07-12**
([#116](https://github.com/hyperspell/hyperspell-openclaw/issues/116)).

## What a register is

At session end, Tin Man distills a sanitized session transcript into a
second-person prose `summary` — an emotional register, not a factual recap. It
is keyed by the plugin's configured `relationshipId` (e.g. `david-alinea`),
timestamped `extracted_at`, and stored with metadata
`{ source: "openclaw_agent_end" }` plus, since 0.19.0, the session's
`channelId` when resolvable (Postmark, #74).

**Volume is deliberately low.** Stores are debounced to at most one per 3
minutes of active talk (`STORE_DEBOUNCE_MS`), and sessions triggered by
cron/heartbeat/memory events, multi-speaker sessions, and short conversations
are skipped entirely. A typical day yields a handful of registers, and a quiet
day may legitimately produce **zero** — an empty day is not divergence.

## The fetch contract

The `hyperspell` npm SDK (0.35.1) has **no emotional-state surface**; the
plugin itself uses raw `fetch` (`client.ts`, "Emotional State" section), and an
external consumer must call REST directly the same way.

Base URL: `https://api.hyperspell.com`

| Fact | Detail |
|---|---|
| `GET /emotional-state` | The single latest register, or JSON `null`. Optional `?relationship_id=`. |
| `GET /emotional-state/recent` | Array, newest first. Optional `?relationship_id=`, `?limit=`. Deployed (the 404 fallback in `client.ts` is a legacy guard only). |
| `limit` cap | **20.** `limit=100` returns 422: `Input should be less than or equal to 20`. |
| Date filtering | **None.** `after`/`before` params are silently ignored (an impossible `before=2000-01-01` window still returned rows). Assemble "a day" client-side — see the recipe below. |
| Response shape (GET) | `{ resource_id, summary, extracted_at, session_id, relationship_id }` — five plain fields, nothing else. No `status` (only `POST /emotional-state` returns one) and **no `metadata`** (see below). |
| Auth | `Authorization: Bearer <apiKey>`; add `X-As-User: <userId>` when the plugin config sets `userId` (mirrors `rawHeaders()` in `client.ts`). |
| Timestamps | `extracted_at` is ISO 8601 UTC with offset, e.g. `2026-06-03T22:45:16.287450+00:00`. |

### No metadata on GET (#116)

Proven live 2026-07-12
([#116](https://github.com/hyperspell/hyperspell-openclaw/issues/116)): the
GET endpoints **do not echo stored metadata**. Registers are written with
`source: "openclaw_agent_end"` and (since 0.19.0) a `channelId`, but both
`GET /emotional-state` and `GET /emotional-state/recent` return empty/absent
metadata for all of them. Until #116 is fixed backend-side, consumers get
**only the five plain fields above** — no `channelId` for per-channel
attribution, and no future depth signals (e.g. Ballast's `depth_score` /
`turn_count`, #68). Do not design an external pipeline around metadata
round-tripping today.

### Pending-extraction placeholder

For roughly 10 seconds after a store, `summary` can still be the *raw input
transcript* rather than a distilled register. The plugin detects this with
`looksLikeRawTranscript()` (`hooks/emotional-state.ts` — role-prefixed lines
like `user:` / `assistant:`); since GET carries no `status` field, external
consumers need the same heuristic. A nightly job running hours after the last
session will essentially never hit this, but filter for it anyway (the recipe
below does).

## Recipe: "a day's registers"

There is no server-side date filtering, so fetch the recent window and filter
client-side:

1. `GET /emotional-state/recent?relationship_id=<REL_ID>&limit=20`
2. Filter `extracted_at` into the day window **in the operator's timezone** —
   timestamps are UTC, but a "day" for a nightly consolidator is a local-time
   concept, so choose the boundary explicitly.
3. Drop pending placeholders with the transcript heuristic.

curl (placeholders only — never a real key):

```bash
# Latest ≤20 registers for a relationship, newest first
curl -s "https://api.hyperspell.com/emotional-state/recent?relationship_id=REL_ID&limit=20" \
  -H "Authorization: Bearer $HYPERSPELL_API_KEY" \
  -H "X-As-User: $HYPERSPELL_USER_ID"   # omit if the plugin config has no userId
```

A runnable zero-dependency version of the full recipe ships as
[`scripts/fetch-day-registers.mjs`](../scripts/fetch-day-registers.mjs):

```bash
HYPERSPELL_API_KEY=... REL_ID=david-alinea node scripts/fetch-day-registers.mjs 2026-07-06
```

It is read-only and prints the day's registers as JSON — what your nightly
synthesis compares its own day-read against.

### Reachability limit

`limit=20` newest-first comfortably covers "yesterday" for a nightly job, but
**does not support arbitrary historical days**: once more than 20 registers
have accumulated since the target day, that day is unreachable via this
endpoint. Historical validation (issue #75's "pick a handful of past days and
compare by hand") is constrained to recent days until the backend grows
date-range parameters.

## The consumer's responsibility

Divergence scoring, thresholds, and where flags surface are the external
process's design decisions. Nothing merges automatically: this plugin never
reads the consolidator's output, and the consolidator's judgment is never
written back into the register store by this contract. If the two disagree,
that disagreement is signal for the external process to surface — see
[issue #75](https://github.com/hyperspell/hyperspell-openclaw/issues/75) for
the design conversation.

## Known limitations / backend follow-ups

Tracked in [`hyperspell-backend-followups.md`](hyperspell-backend-followups.md):

- No server-side date-range params (`after`/`before` accepted but ignored).
- `limit` capped at 20 with no pagination — historical days can become
  unreachable.
- No `status` field on GET, forcing the transcript heuristic.
- No `metadata` echoed on GET (#116) — blocks channel attribution and future
  depth signals for external consumers.
