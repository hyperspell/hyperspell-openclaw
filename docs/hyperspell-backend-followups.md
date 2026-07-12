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
