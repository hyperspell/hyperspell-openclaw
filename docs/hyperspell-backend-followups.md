# Hyperspell backend follow-ups

Open questions that need answers from (or changes in) the Hyperspell backend,
not this plugin. Filed from the #80 purge-channel work; verify live and record
findings here.

## 1. Is `session_id` echoed on `GET /memories/{id}` for trace resources?

`sessions.add` sends `session_id` as a first-class field, but `listMemories`
exposes only `resource_id`/`source`/`title`/`metadata` — so traces written
before the `openclaw_session_id`/`openclaw_channel_id` metadata tags (added
with the purge-channel work) are not channel-attributable via enumeration.
If `getMemory` echoes `session_id` on the raw resource, legacy trace cleanup
could be upgraded to fetch-and-match per trace. Unverified either way.

## 2. Does deleting a parent trace remove its derived extractions?

Traces sent with `extract: ["procedure", "memory", "mood"]` produce derived
resources backend-side. Whether `DELETE /memories/{id}` on the parent trace
cascades to those extractions is unknown. If it does not, purging a channel's
traces still leaves derived memories behind, and the backend needs either a
cascade or a parent-id link exposed on derived resources.

## 3. Date-range params on `GET /emotional-state/recent` (filed 2026-07-12, from #75)

External daily-reconciliation consumers (see
`emotional-state-external-reconciliation.md`) must assemble "a day's
registers" client-side: `after`/`before` query params are accepted but
**silently ignored** — verified live 2026-07-07, an impossible
`before=2000-01-01` window still returned rows. Ask: honor `after`/`before`
(or `since`/`until`) server-side so a specific day is directly addressable.

## 4. `limit` cap of 20 on `GET /emotional-state/recent` (filed 2026-07-12, from #75)

`limit=100` returns 422 (`Input should be less than or equal to 20`) and there
is no pagination, so any day preceding the last 20 stored registers is
unreachable via the API. Ask: raise the cap or add pagination — moot for
"which day" access if follow-up 3 lands first, but still needed for
high-volume days.

## 5. `status` field on emotional-state GET responses (filed 2026-07-12, from #75; nice-to-have)

Only `POST /emotional-state` returns `status`; GET responses omit it, so
consumers must re-implement the raw-transcript heuristic
(`looksLikeRawTranscript()` in `hooks/emotional-state.ts`) to skip
pending-extraction placeholders. Ask: echo `status` on
`GET /emotional-state[/recent]`. Related: **#116** established the same GET
endpoints also drop stored `metadata` entirely — the highest-leverage combined
fix is a single backend change that echoes both `status` and `metadata` on
reads, unblocking external channel attribution (#74) and Ballast's depth
signals (#68) at the same time.
