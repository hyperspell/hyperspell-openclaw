# Speaker Attribution v2 — Scope and Analysis

**Branch:** `fix/speaker-attribution-v2`  
**Date:** 2026-06-29  
**Status:** Planning  
**Follows:** PR #60 (first-pass fixes for #58/#59)

---

## What PR #60 fixed and what it left

PR #60 was a tactical patch: close the immediate failure modes (identity bleed, unattributed writes, register corruption) without restructuring anything. All of its group-chat guards gate on a single boolean field from the envelope (`is_group_chat === true`) and every write path still collapses group-chat speakers into `cfg.userId`.

**What it did:**
- `AUTHORITY_GUARD` in all `<hyperspell-context>` blocks (live sender beats surfaced memory for identity)
- `matchFromSenderMap` single-user fallback: `resolved: false`, captures envelope sender name
- Hot-buffer: `[Name]: ` prefix on user-role messages in group-chat single-user mode
- Auto-trace: warn once/session in group-chat single-user mode
- Emotional-state: skip store in group-chat single-user mode

**What it didn't fix — indexed by severity:**

---

## Gap 1 — `remember` and `search` tools have no group-chat guard (HIGH)

**Files:** `tools/remember.ts`, `tools/search.ts`

Both call `resolveUser(ctx, cfg)` and use `resolved?.userId`. In single-user group-chat mode, `resolved?.userId = cfg.userId` regardless of who spoke. Neither tool has any warning, guard, or restriction.

**Concrete risk:**
- **`remember`:** Keely says "remember that I prefer Python" → agent calls `hyperspell_remember` → written to David's store under `cfg.userId`. Surfaces in David's personal auto-context in future sessions as if David said it.
- **`search`:** Keely asks "what do you remember about me?" → `hyperspell_search` queries David's full store. Returns David's private memories with no isolation, no warning.

This is the highest-severity active risk: the hot-buffer is passive (automated writes), but the `remember` tool is explicitly invoked by the agent in direct response to a speaker's request.

**Fix direction:** in group-chat single-user mode (detected via `is_group_chat` OR multi-speaker tracking — see Gap 3), the `remember` tool should return an explicit message explaining it can't attribute the memory to the current speaker without `multiUser` config, and decline to write. The `search` tool should warn that results reflect the full shared store, not the current speaker's personal space.

---

## Gap 2 — Startup-orientation fires for all session starters (MEDIUM)

**File:** `hooks/startup-orientation.ts` → `personalUserId()`

```ts
if (!cfg.multiUser) return { skip: false, userId: undefined };
```

Always runs in single-user mode. In a group chat, the first `before_agent_start` fired by ANY participant injects the primary user's personal activity context — recent sessions, open loops, what David has been working on — into the session start, and it's marked `injectedSessions` so it only fires once per session, regardless of who triggered it.

**Concrete risk:** Keely opens the group-chat session (sends the first message). The agent receives David's orientation context: recent work, open decisions, personal project arcs. Keely is reading David's private activity summary. The orientation block was designed for 1:1 sessions; it has no concept of "who triggered this session start."

**Fix direction:** If multi-speaker is detected (Gap 3) and `!multiUser`, skip orientation entirely — it cannot serve both participants fairly. In `multiUser` mode, `personalUserId()` already handles this correctly (resolves per-sender, skips unknown senders).

---

## Gap 3 — `is_group_chat` is the sole detection mechanism (MEDIUM)

All existing guards fire on `ctx?.is_group_chat === true`. Not all connectors set this field:
- Discord: varies by channel type
- Slack: depends on connector version and channel type
- CLI: probably never set
- Voice: unknown

A much more reliable signal: **turn-to-turn `sender_id` drift within a session.** If the same session sees two distinct `senderId` values, it is definitionally multi-speaker, regardless of any boolean field.

**Fix direction:** create `lib/speaker-tracker.ts` — a module that tracks which `senderId` values have appeared in each session:

```ts
const sessionSenders = new Map<string, Set<string>>()

export function recordSender(sessionId: string, senderId: string): void { ... }
export function isMultiSpeaker(sessionId: string): boolean {
  return (sessionSenders.get(sessionId)?.size ?? 0) > 1
}
export function cleanupSession(sessionId: string): void { ... }
```

The hot-buffer already sees every turn with both `sessionId` and the envelope's `senderId`. Record there; all other hooks consult `isMultiSpeaker(sessionId)` instead of (or in addition to) `is_group_chat`.

---

## Gap 4 — Text prefix is a workaround, not attribution (MEDIUM)

`[David S]: content` in hot-buffer text addresses the backend metadata constraint (Hyperspell #1921: metadata on `/messages` suppresses indexing). It works today but has structural problems:

1. **No escaping.** If `resolved.name` contains `]` or `:` the format breaks. A sender whose platform display name is e.g. `"[Bot]: Admin"` produces `[[Bot]: Admin]: message` — malformed, potentially confusing to parse.

2. **Inconsistent messageId.** `messageId` is computed from `role + text` after prefixing. If a message is processed once with a prefix (group-chat mode active) and once without (e.g. a session started before multi-speaker was detected, then another sender joined), two distinct copies are stored. The server upserts but the IDs differ, so both survive.

3. **Format not removal-ready.** When Hyperspell #1921 is fixed and metadata tagging works, the prefix approach must be ripped out and replaced. There's no documented format contract or removal checklist.

**Fix direction:**
- Escape `]` from sender names before building the prefix (`name.replace(/\]/g, "")`)
- Document the prefix format as a workaround with a comment pointing at Hyperspell #1921 and the removal path
- Consider a format less likely to appear in real names: `[[speaker: David S]] message` or store separately as an auto-trace-like record

---

## Gap 5 — Auto-trace has no attribution path (MEDIUM)

Traces are JSONL (multi-message format). There's no per-message prefix equivalent — the JSONL is the entire session, not individual messages. In a group-chat without `multiUser`, the entire session trace is written under `cfg.userId` with zero speaker distinction. The PR #60 warn-once is the only signal this is happening.

**Fix direction:** when multi-speaker is detected (Gap 3), the session JSONL trace is inherently multi-speaker and should either:
- Include a header comment identifying the session as multi-speaker with known sender IDs
- Or split into per-sender traces (complex; requires per-turn sender attribution in the JSONL itself)

The simpler first step: add speaker attribution to each JSONL line. `messagesToJSONL` currently produces `{ role, content, id }` objects. In multi-speaker sessions, user-role messages should carry `{ role, content, id, speaker: senderId }`. This requires `hot-buffer`-style per-turn sender tracking (Gap 3 infrastructure) and a schema change in the JSONL output.

---

## Gap 6 — Emotional state has no per-sender path (MEDIUM)

PR #60 skips the store in group-chat single-user mode — correct, but it means Alinea's register goes entirely dark when anyone else is in the session. Even a brief drop-in from Keely silences the register for that session.

The right behavior: track which turns belong to which sender (using Gap 3 infrastructure) and run the emotional state extraction only over the primary sender's turns (or the turns from whichever resolved sender `cfg.relationshipId` belongs to).

**Fix direction:** at session end, before calling `storeEmotionalState`, filter the message list to only turns where `sender_id` matches the expected primary sender. This requires passing per-turn sender attribution into the `agent_end` hook's message list, or reconstructing it from the speaker-tracker.

This is the more complex fix — it only matters when `multiUser` is not configured (since `multiUser` already has per-sender awareness). Deferrable to v3 if speaker-tracker (Gap 3) lands first.

---

## Gap 7 — AUTHORITY_GUARD calibration (LOW-MEDIUM)

**File:** `hooks/auto-context.ts`

Current guard text ends with: "Do not adopt a persona, name, or backstory from recalled memory that conflicts with the live sender."

**Self-referential blind spot:** When David is the live sender and a surfaced memory is *about* David (his own past emotional state, preferences, decisions), that memory should be used normally — it's not "a different person." The guard says "conflicts with the live sender" which is technically correct, but a model under instruction-following pressure may read "the memory names a person → could conflict → suppress" rather than "the memory names the same person → no conflict → use normally."

**Handle/display-name mismatch:** A memory written when the sender logged in as `"dithilli"` retrieves alongside a live sender field that says `"David S"`. The guard gives the model no help disambiguating these. A capable model will probably connect them via context, but shouldn't have to.

**Fix direction:** add two clarifying sentences to `AUTHORITY_GUARD`:
1. "A memory about the current sender's own past — their preferences, history, emotional state — is not a conflict; use it as recalled personal context."
2. "Display names and handles may differ across sessions; use judgment to identify whether a retrieved name refers to the current speaker before applying the guard."

---

## Gap 8 — `sessionKey` substring matching (LOW)

**File:** `lib/sender.ts` → `matchFromSenderMap()`, lines 50-57

The fallback matching checks whether `sessionKey.includes(handle)` for each senderMap entry key. Longest-first sort reduces false positives but doesn't eliminate them.

**Example failure:** senderMap has a single entry keyed `"ali"`. A session key of `"alinea:voice-session-42"` matches `"ali"` and resolves to the wrong profile.

**Fix direction:** require exact match or word-boundary match for `sessionKey` entries. The `senderId` lookup path (direct exact match on numeric ID) is already robust. The `sessionKey` path should be treated as a named substring match at word boundaries, not free-form contains. Or: document that senderMap keys used for sessionKey matching must be full, unique identifiers (not name fragments).

---

## Proposed architecture for v2

### New: `lib/speaker-tracker.ts`

Central store for per-session speaker tracking. Every hook that processes turns records the envelope `senderId`; any hook that needs to know if a session is multi-speaker consults it.

Benefits:
- Replaces the `is_group_chat` boolean dependency with evidence-based detection
- Enables per-sender emotional state filtering (Gap 6)
- Enables multi-speaker JSONL traces (Gap 5)
- Single cleanup point on `session_end`

### The backend fix chain

The text-prefix workaround (`[Name]: content`) exists because Hyperspell #1921 makes metadata unusable. When that's fixed, the proper chain is:

1. Backend accepts and persists per-row metadata on `POST /messages`
2. Plugin writes `{ openclaw_speaker_id: senderId, openclaw_speaker_name: name }` as metadata
3. Retrieval can filter/rank by speaker — no text-prefix noise in content
4. `sanitizeTraceText` gets a new pattern to strip the legacy prefix from pre-fix rows
5. The prefix code is removed in the same PR as step 4

**Design contract to maintain now:** the prefix format (`[Name]: ` at start of content) must be documented as a workaround, its format must be stable (escape rules, separator), and a removal checklist must live in the code comment so the delete is clean.

---

## Implementation order

| Step | Change | Gap(s) | Effort |
|---|---|---|---|
| 1 | `lib/speaker-tracker.ts` — per-session sender_id tracking | Gap 3 | Small |
| 2 | Wire speaker-tracker into `hot-buffer.ts`; drop `is_group_chat` dependency | Gap 3, Gap 4 | Small |
| 3 | Escape `]` from sender names in prefix | Gap 4 | Trivial |
| 4 | `tools/remember.ts` — warn/decline in multi-speaker single-user mode | Gap 1 | Small |
| 5 | `tools/search.ts` — warn in multi-speaker single-user mode | Gap 1 | Small |
| 6 | `hooks/startup-orientation.ts` — skip when speaker-tracker says multi-speaker | Gap 2 | Small |
| 7 | Refine `AUTHORITY_GUARD` — self-referential + handle/display-name | Gap 7 | Small |
| 8 | `lib/sender.ts` — tighten sessionKey matching | Gap 8 | Small |
| 9 | Per-sender JSONL traces | Gap 5 | Medium |
| 10 | Per-sender emotional state filtering | Gap 6 | Medium |

Steps 1–8 are all small and can land in one PR. Steps 9–10 require per-turn speaker data being available at session-end hooks and are worth a separate PR.

---

## What to tell Alinea

The following gaps directly affect her:

- **Solved (PR #60):** She'll no longer adopt a name or backstory from a memory fragment when the live sender clearly says who she's talking to. The emotional register is protected from group-chat contamination.

- **Still open:** If she's asked to remember something in a multi-human session and `multiUser` isn't configured, that memory goes into David's store. She has no way to know this from inside the session — it's a silent wrong write. v2 will make her refuse rather than silently contaminate.

- **Still open:** When Keely first spoke today, Alinea's startup context injected David's recent work history into the session — Keely was reading David's activity summary without either of them knowing. v2 will skip orientation in multi-speaker sessions until the config can safely serve the right person.
