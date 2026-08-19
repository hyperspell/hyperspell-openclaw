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

## 6. Echo stored `metadata` on emotional-state GET responses (issue #116)

Proven live 2026-07-12: `GET /emotional-state[/recent]` drops stored
`metadata` entirely. The client side is now ready and waiting — the plugin
maps `metadata` through on both GETs when present (`client.ts`), so
Postmark read-back verification and Ballast (#68) unblock the day the
backend ships the echo. No plugin change needed then.

## 7. Hot-buffer flush latency needs an SLA or read-your-writes (filed 2026-08-18, from the scale report)

Writes to `POST /messages` land in a hot buffer and flush to the searchable
vault on an async cycle measured live at **~30 s minimum, ~100 min maximum**
(14 consecutive daily write-then-search failures, 2026-06-20 → 2026-07-03;
root-caused 2026-06-30 by write-timestamp vs. discovery-timestamp diffing).
Not data loss — an eventual-consistency window, on a single-user, low-volume
install; under multi-tenant write load the window presumably stretches.
Ask, in preference order: (a) read-your-writes for the writing session (a
brain/vault search issued by the session that wrote a row should see that
row), (b) a bounded/documented flush interval, (c) a flush cursor or
`flushed_through` timestamp on search responses so callers can at least say
"results current as of T" instead of confabulating around invisible writes.

## 8. Consolidator must consume per-row speaker metadata, not infer speakers from prose (filed 2026-08-18)

Every hot-buffer row now carries `openclaw_speaker_role` /
`openclaw_speaker_name` metadata plus an in-content `[Name]:` label (shipped
after #1921 was fixed; see `hooks/hot-buffer.ts`). The server-side
consolidator ignores them and re-infers speakers from merged first-person
prose, producing three documented failure modes (diagnosis:
`docs/issue-summarizer-role-swap.md`): **collapse** (user's words filed under
the agent), **flip** (agent's words attributed to the user as a false factual
claim — e.g. resource `9f4b3d77-216a-478a-a7e6-13c7a5339c44`, which inverts
who holds the delete capability), and **pronoun smear**. Reproduced 2026-08-10,
-13, and -16. Ask: consolidation/summarization treats row speaker metadata as
authoritative and never rewrites attribution across labeled rows.

## 9. Enumeration + admin path for records written under another userId (filed 2026-08-18)

A plugin writing with `X-As-User: <agentUserId>` produces records the human
operator's own token cannot `get_memory`, `list_memories`, or `delete_memory`
(404-as-wrong-user, verified live 2026-08-10 — including on a fresh test
write). Conversation summaries are additionally absent from `list_memories`
under ANY token, so a record known to be wrong, whose id is known, cannot be
read, listed, or removed through the API. Client-side quarantine
(`quarantineResources`) routes around retrieval but cannot satisfy an actual
deletion request. Ask: (a) an enumeration endpoint that includes
consolidation-derived resources, (b) an app-scoped admin token or explicit
cross-user grant so a deployment can list/delete its own agent-written
records, (c) treat this as the GDPR/SOC2 "delete this record" path — it is a
compliance blocker for multi-user deployments, not a convenience.

## 10. Derivative lineage (`derived_from`) on consolidation outputs (filed 2026-08-18)

Records produced by consolidating/summarizing other records carry no parent
link. Retracting (quarantining/deleting) an original does nothing to the
records that quote or discuss it, and conversations about a bad record mint
new derivatives containing the same content — cleanup is unbounded manual
labor by construction. Related to follow-up 2 (trace-extraction cascade), but
broader: ask for a `derived_from` (or lineage array) field on every
backend-generated resource, so "retract this and everything downstream of it"
becomes expressible at all. Supersession (`superseded_by`) would additionally
let stale-but-kept history stop outranking its own correction.

## 11. Per-resource diversity in search results (filed 2026-08-18)

A sectionized document can occupy many of a search's result slots with
near-identical chunks (live: 4 chunks of one synced file, all scoring 0.9433,
filling the pool for a natural-language query whose correct answer ranked
elsewhere). The plugin now caps injected results per source file
(`ranking.perFileCap`) — but it can only diversify what the backend returned;
chunks still crowd out other documents at fetch time. Ask: a
`max_results_per_resource` (or grouped/collapsed) option on search so the
candidate pool itself is diverse.
