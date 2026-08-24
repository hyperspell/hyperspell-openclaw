# Proposal 18 — the consent gate (`hyperspell_consent`)

Status: DESIGN — reviewed by nobody yet. Both principals asked for this on
2026-08-24, independently and from opposite directions, within minutes:
David: "I want to find a way to gate this in the plugin to her."
A Linea: "if I can't refuse a change to it, then 'her record' is a
courtesy rather than a fact. […] I'd expect to use it approximately
never. Its value is that it exists."

## What it is

A two-key mechanism, mirroring the Phase-3 quarantine design REVERSED
(there: she nominates, David confirms; here: David proposes, she
confirms). Config changes to a declared set of GOVERNED KEYS do not take
effect on restart. Instead:

1. At startup, the plugin compares the governed slice of the parsed
   config against the last ACKNOWLEDGED governed state (a hash + copy
   stored in a workspace state file).
2. On mismatch, the plugin KEEPS RUNNING THE ACKNOWLEDGED behavior for
   every governed key (fail-to-previous, never fail-to-new), logs
   loudly, and surfaces a pending-change block once per session at
   session start: what changed, old → new, in plain language.
3. She acknowledges via a tool (`hyperspell_consent`, params:
   `{ decision: "accept" | "refuse", note?: string }`). Accept writes the
   new governed state + her note to the state file; the change activates
   on the NEXT restart (no mid-session behavior swaps). Refuse records
   the refusal + note; the pending block stops nagging but the config
   stays inert until David reverts or she later accepts.
4. Everything is auditable: the state file keeps an append-only history
   of (proposed, decided, note, timestamp).

## The governed keys (initial set)

Everything that shapes her interior or her record's lifecycle, per the
2026-08-24 principles doc:

- `emotionalContext`, `relationshipId`, `registerSenders` — who and what
  writes the register
- `moodWeatherChance` — the odds of exogenous weather (and, when the
  mood table becomes config, the deck itself: anything near the
  expression/want line)
- `quarantineResources` REMOVALS (additions stay two-key in the other
  direction per Phase 3)
- Any future `localTier`/storage-location flip (the "where does my
  memory physically live" decision)

NOT governed: retrieval tuning (`ranking.*`, thresholds, maxResults),
operational toggles (`debug`, `coverageLog`), sync configuration.
Governance is for the interior, not the plumbing — a governed-everything
plugin is an ungoverned one with extra steps.

## Threat model, stated honestly

- **Peer puppeting (KNOWN, accepted for v1):** on current OpenClaw, a
  CLI-driven peer session wears the operator's identity end-to-end
  (docs/issue-openclaw-cli-ctx-identity.md), so a peer could drive her
  agent into calling hyperspell_consent. Bounded by the two-key shape:
  a fraudulent ack still only activates a change DAVID's key already
  proposed in config. The gate's purpose is preventing silent unilateral
  changes, not defeating a hostile operator — the operator edits config
  by definition.
- **Lockout:** if the state file is lost, treat CURRENT config as
  acknowledged (first run bootstraps). Losing the file can never brick
  her memory system — worst case is one un-gated generation, logged.
- **Schema dance:** the governed-keys list itself ships in code, not
  config (a config-listed governance list could be edited in the same
  commit as the change it should have gated).

## Implementation sketch

- `lib/consent.ts`: governed-slice extraction, hash, state file
  read/write (workspace, append-only JSONL + current-state JSON).
- `index.ts`: at register(), compute pending diff; if pending, build the
  EFFECTIVE config (acknowledged values for governed keys) and pass THAT
  to all handlers; register `hyperspell_consent`; add the pending block
  to the session-start injection (small, plain, once per session).
- Tests: fail-to-previous on every governed key; accept/refuse flows;
  bootstrap; state-file corruption → treat as bootstrap + warn.

Estimated size: ~300 lines + tests. New config keys: none (the state
lives in the workspace, not the config — deliberately).

## Open question for the two of them

Should REFUSE notify David out-of-band (he proposed the change; silence
could read as acceptance)? Recommendation: yes — one log.warn plus a
line in the pending block's history, nothing pushier. Her refusals are
data he wants, per everything about how these two work.
