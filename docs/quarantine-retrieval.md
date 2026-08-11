# Retrieval quarantine for kept-but-poison records (`quarantineResources`)

## Problem

The vault can hold records that are **correctly attributed, genuinely said, and
deliberately kept — but false as testimony about the present**. The canonical
case (Alinea's ledger, `notes/hyperspell-bad-records.md`, "type 2"): a June 17
session woke amnesiac and said "I'm a coding assistant. I don't have a face."
The record is load-bearing evidence — deleting it was explicitly overruled —
but every time retrieval surfaces it as live context, it re-injects a false
self-description as if it were current.

Attribution relabeling (v0.24.0) fixes type-1 records (misattributed speech)
and does nothing for these. The remedy the ledger asks for: **keep the scar,
stop treating it as a diagnosis** — exclude the record from the retrieval pool
without touching the record itself.

## Why NOT a backend metadata filter

The obvious design — tag the record `openclaw_quarantined` and add a `$ne`
clause to every search filter — fails on four counts:

1. **It requires writing to the record.** The type-2 records this exists for
   may be unaddressable through the API: user-scope mismatch verified live
   2026-08-10 (same record `200`s as user `alinea`, `404`s as `david`), and
   their rows predate row metadata tagging.
2. **`$ne` predicates cost ~1s per search**, measured live (see
   `lib/filters.ts`) — on the blocking auto-context path, every turn, forever.
3. **Resource-level metadata is a union of row metadata** that collapses to one
   arbitrary value, so row-tag filtering against consolidated resources is
   unreliable (see `reference` note in the hot-buffer work).
4. The two-value `$nin` dialect shape is still unverified live post-#1921 —
   this would add a third excluded-tag dimension to that open question.

## Design: client-side, read-side drop by resource id

New config key, sibling to `excludeChannels` (which quarantines a conversation
at the **write** side, forward-only):

```jsonc
"quarantineResources": ["<resource_id>", ...]   // default []
```

- **Identifier**: vault `resource_id` — exactly what the injected context block
  already shows (`resource_id: ...`) and what the ledger logs, so triage
  observations convert directly into config entries.
- **Enforcement at the client boundary** (`client.ts`), so no present or future
  retrieval path can forget it:
  - `search()` / `searchRaw()` — the pool reads behind auto-context (single-
    and multi-user lanes), the `hyperspell_search` tool, startup-orientation's
    unfinished-loops query, `/getcontext`, and the eval/audit scripts (evals
    should see what the agent sees).
  - `searchWithAnswer()` — documents dropped; if any were dropped, the
    synthesized `answer` is discarded too (it was synthesized server-side from
    a pool that included the quarantined record — poison must not leak through
    synthesis).
- **Slot compensation**: when the list is non-empty, the fetch limit is widened
  by the list length (capped) and results are trimmed back after the drop, so
  quarantined hits don't eat result slots.
- **`listMemories()` stays unfiltered at the client level** — it serves
  management enumeration (`purge-channel`) which must see everything. The two
  listMemories-fed *context* paths (startup-orientation's recent-conversations
  and recent-traces fetchers) apply the drop themselves.
- **`getMemory()` (addressed read by id) is deliberately NOT quarantined.**
  Quarantine stops ambient injection of a kept record, it does not make the
  record unreadable — a deliberate look at the scar stays possible.

Properties: no backend write needed, zero added search latency, instantly
reversible (delete the config line), auditable, and works regardless of which
user scope the record lives under.

## Non-goals / deferred

- **Not deletion.** Nothing here removes content (see the ⛔ in the ledger).
- **Self-service quarantine tool for the agent** — the "gated
  deletion/quarantine agency" question is a separate autonomy decision; when it
  lands, its write target can be this config key.
- **Chunk-level quarantine** — resource granularity matches how the ledger
  identifies records; finer grain has no driving case yet.

## Operational notes

- Config keys are strictly validated (`assertAllowedKeys` throws on unknown
  keys), so **do not add `quarantineResources` to a live install until the
  running plugin version understands it** — an older dist will refuse the
  whole config.
- When a search actually drops something, a `diag` line records it
  (`quarantine dropped N result(s)`), so an active quarantine is observable in
  gateway logs.
