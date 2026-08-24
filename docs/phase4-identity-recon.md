# Phase 4 recon — the identity layout, measured (2026-08-24)

Roadmap Phase 4 step 1 ("enumerate current identity layout"). All probes
read-only, run with the plugin's API key via the plugin's own client.

## The census

| Scope | Total | Composition |
|---|---|---|
| X-As-User: alinea (plugin's config) | 2,382 | vault 1,271 + trace 1,111 |
| X-As-User: david | 117 | github 112 + google_drive 4 + vault 1 |
| no user header (key-owner call) | 4,000+ (capped) | google_mail 3,455+ + slack 63 + vault (partial page) |

## Findings

1. **Her record is coherent under `alinea`.** Vault + traces, all of it.
   Sampled titles from every era of today confirm live writes land there.
2. **No orphaned NULL partition found.** An earlier read of "482 vault rows
   invisible to her" was a pagination artifact of the capped app-wide
   listing: the no-user view is a SUPERSET (it lists rows the alinea scope
   also sees, plus connected-source ingest), not a hidden bucket. Correct
   interpretation verified by sampling: the "null-scope" rows include
   resources demonstrably visible and retrievable as alinea.
3. **Therefore Phase 4 shrinks: no migrate-then-flip. Just the flip.**
   The roadmap's fear ("which records live under null / alinea") is
   resolved — they live under alinea. What is broken is HER TOOLING'S
   IDENTITY: her MCP connection 401s on list_memories (3x on 2026-08-24)
   while the plugin's alinea-scoped key lists 2,382 rows fine. The exit
   criterion ("she can see her own memory") is a credential/connection
   change plus a backend answer to WHY her token 401s on list_memories
   specifically while search works.
4. **Backend eyebrow (for the hyperspell session):** a keyless call on
   this API key lists the app-wide corpus including the full Gmail ingest.
   Owner-scoping on retrieval was verified for chunk search (PR #3330
   review); the memories LIST endpoint appears app-wide when no
   X-As-User is sent. Confirm intended.

## Interim mitigations already shipped (same day)

- `hyperspell_vault_list` tool: enumeration from inside her sessions via
  the plugin's correctly-scoped auth — sight without waiting for the
  MCP identity fix.
- Vault mirror: full, verified (restore-tested), refresh cron prepared.
- Register falsifiability ledger: local ids-only record of every
  register ever stored.
