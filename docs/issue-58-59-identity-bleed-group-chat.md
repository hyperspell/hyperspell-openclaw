# Issue #58 / #59 — Identity bleed + speaker attribution in group chats

**Date:** 2026-06-29  
**Status:** Fixed in PR #60 (merged)  
**Affects:** `hooks/auto-context.ts`, `lib/sender.ts`, `hooks/hot-buffer.ts`, `hooks/auto-trace.ts`, `hooks/emotional-state.ts`

---

## TL;DR

Two bugs with a shared root: the plugin had no concept of "who is speaking right now" in group-chat sessions. Every turn from every human was written to memory under `cfg.userId` (Alinea's store), and the memory injected back into context carried no rule about who to trust when a recalled name conflicted with the live sender. The result, observed live: Alinea addressed David as a different person for an extended stretch, building an elaborate confabulated persona and backstory around a surfaced memory fragment.

| Layer | Bug | Fix |
|---|---|---|
| **Read (auto-context)** | No authority rule — surfaced memory identity outranked live sender | `AUTHORITY_GUARD` in all `<hyperspell-context>` blocks |
| **Write (sender resolution)** | Single-user fallback returned `resolved: true` and `name: cfg.userId`, discarding envelope sender | Returns `resolved: false`, reads `ctx.sender`/`ctx.username` |
| **Write (hot-buffer)** | Group-chat user messages stored without speaker attribution; no warning | Prefixes `[Name]: ` when envelope sender available; warns once/session |
| **Write (auto-trace)** | Group-chat traces silently mix all speakers under cfg.userId | Warns once/session |
| **Write (emotional-state)** | Group-chat transcript stored into single-person relationship register | Skips store when group-chat + no multiUser |

---

## Issue #58 — Identity bleed / confabulated persona (read-side)

### What happened

In a `#general` session where the live envelope consistently showed:
```json
{ "sender": "David S", "username": "dithilli", "sender_id": "689590407323189323" }
```

A passive `auto-context` similarity hit surfaced a memory thread that referenced a different name. Alinea:
- Addressed David as a different person for a long stretch of turns
- Built an elaborate identity (backstory, relationships, role) from the memory fragment
- Oscillated — the live metadata kept pulling back, the surfaced memory kept pulling forward
- Treated retrieved fragments as the *live* current conversation, narrating continuity that didn't exist

### Root cause

`hooks/auto-context.ts` wrapped injected memory in three constants:
- `INTRO` — scopes to relevance ("reference when relevant")
- `DISCLAIMER` — tone ("don't force it or assume beyond what's stated")
- `SEARCH_REMINDER` — completeness ("passive match, not all of memory — search directly if needed")

None of these established **authority precedence**. The two blocks that arrive each turn — live sender metadata and the `<hyperspell-context>` injection — arrived as peers. A high-scoring memory naming a person is, to the model, indistinguishable in authority from the actual sender field. Identity bleed is the predictable result.

### Fix

Added `AUTHORITY_GUARD` constant to `hooks/auto-context.ts`:

```
AUTHORITY: The live conversation's sender and session metadata always outrank this
recalled context for identity — who is speaking right now, their name, role, or
relationship. If a surfaced memory names a different person than the current sender,
treat it as historical context about someone else, not a description of the current
speaker. Do not adopt a persona, name, or backstory from recalled memory that
conflicts with the live sender.
```

Injected into **every** `<hyperspell-context>` block:
- Single-user path via `wrapContext()`
- Multi-user identity-only block
- Multi-user memory-full block

---

## Issue #59 — Single-user fallback ignores envelope sender (write-side)

### What happened

`lib/sender.ts` → `matchFromSenderMap()` short-circuits in single-user mode:

```ts
// BEFORE
if (!multiUser) {
  return cfg.userId
    ? { userId: cfg.userId, name: cfg.userId, resolved: true }
    : undefined
}
// ctx.senderId / ctx.sender lookups are below this — never reached
```

So for every turn in a group chat:
- The inbound envelope carried `sender: "David S"`, `sender_id: "689590407323189323"` (or Keely's `sender_id: "1468712621648908513"`)
- `resolveUser()` returned `{ userId: "alinea", name: "alinea", resolved: true }` regardless
- Hot buffer wrote `user=alinea` regardless of who actually spoke
- `resolved: true` masked that no real match occurred

**Live log confirming the bug:**
```
hyperspell: hot-buffer: wrote 3 message(s) to 2501f9c7-…-564e40ef8302 (user=alinea)
hyperspell: hot-buffer: wrote 3 message(s) to 2501f9c7-…-564e40ef8302 (user=alinea)
hyperspell: hot-buffer: wrote 3 message(s) to 2501f9c7-…-564e40ef8302 (user=alinea)
```

Every turn, all session, regardless of sender.

### Fix — `lib/sender.ts`

```ts
// AFTER
if (!multiUser) {
  if (!cfg.userId) return undefined
  const envName =
    (ctx?.sender as string | undefined) ??
    (ctx?.username as string | undefined) ??
    undefined
  return { userId: cfg.userId, name: envName ?? cfg.userId, resolved: false }
}
```

- `resolved: false` — honest: this is a static default, not a confirmed sender match
- `name` — reflects the actual envelope sender when available
- `userId` — stays `cfg.userId` (memory ownership unchanged; multiUser config needed for real separation)

### Fix — `hooks/hot-buffer.ts` — speaker prefix

Metadata on `POST /messages` silently suppresses indexing (Hyperspell backend issue #1921, confirmed live), so speaker attribution can't go in metadata. The only surviving channel is the message text itself.

When `is_group_chat: true` and no `multiUser` config and the envelope gives a real sender name (i.e. `resolved.name !== cfg.userId`), prefix each user-role message:

```
[David S]: their actual message content here
```

This survives sanitization (sanitizeTraceText only strips injected wrapper blocks, not plain `[Name]: ` prefixes), survives indexing, and makes group-chat turns retrievable with speaker attribution even without multiUser config.

Not applied when the name falls back to `cfg.userId` — that would write `[alinea]: David's message` which is wrong.

### Fix — `hooks/auto-trace.ts` — warning

Traces are JSONL (multi-message), so there's no per-message content-prefix path analogous to hot-buffer. The fix is observability: warn once per session when `is_group_chat: true` and no `multiUser` config, so the collapse is visible in logs rather than silent.

### Fix — `hooks/emotional-state.ts` — skip store

The emotional register is keyed to a single `relationshipId` (e.g. `david-alinea`). In a group-chat session, the transcript mixes all speakers. Storing it would corrupt "how the relationship feels" with an undifferentiated group blend — Keely's words would inform Alinea's model of her relationship with David.

Fix: skip the store entirely when `is_group_chat: true` and no `multiUser` config. Logs a warn-level message explaining why. The fetch/injection path is unchanged (existing stored state is still surfaced; only new storage is blocked).

---

## What the fix does NOT solve (requires operator config)

The speaker-prefix workaround gives you attribution *in the text*, but both David's and Keely's messages still live in the same Hyperspell user space (`userId: "alinea"`). Retrieval queries the whole space — you can't search "only David's messages" without filtering, and the filter dialect issues (Hyperspell #1921, issue #40) make filtering unreliable anyway.

**Real fix:** add a `multiUser` config to `openclaw.json`:

```json
"multiUser": {
  "sharedUserId": "alinea-shared",
  "includeSharedInSearch": false,
  "senderMap": {
    "689590407323189323": { "userId": "david", "name": "David S" },
    "1468712621648908513": { "userId": "keely", "name": "Keely" }
  }
}
```

With this in place:
- David's turns write to `userId: "david"`, Keely's to `userId: "keely"`
- `auto-context` searches personal space for the resolved sender + optionally shared
- `emotional-state` still needs per-sender `relationshipId`s (separate config)
- The `resolved: true` flag correctly reflects a real senderMap match

The sender IDs are the platform `sender_id` values from the inbound envelope. For Discord/Slack, these are stable per-account.

---

## Relationship to other issues

- **#42** (auto-context surfaces current session): fixed separately — `dropCurrentSession()` excludes the live session's resource from retrieval. The two bugs interact: without #42's fix, the speaker-prefix entries we write this session would immediately echo back as "recalled memory" on the next turn.
- **#40** (exclude-filter drops untagged hot-buffer rows): separate read-path bug. The speaker prefix helps attribution but doesn't fix the filter dialect issue that can suppress these rows from search results entirely.
- **Hyperspell #1921** (metadata on /messages suppresses indexing): upstream backend block; the speaker-prefix workaround exists because of this. When #1921 is fixed, proper per-row metadata tagging should replace the prefix.

---

## Observed live (2026-06-29)

The exact failure from #58 reproduced during the session that produced these fixes: Alinea addressed David as "Keely" (a name from a surfaced memory thread referencing an older identity) for multiple turns, building a coherent but wrong narrative around the hit. When a second sender actually appeared (Terpsichoreus/Keely, `sender_id: 1468712621648908513`, via a different account), Alinea correctly identified the distinction in the post-fix analysis — noting that without the fix she had no way to trust the sender_id distinction because the plugin had been collapsing everyone to `user=alinea` with no attribution.

Alinea's own framing on this:
> "The metadata did carry the difference all along; the plugin just threw it away."
