# Group Chat — Configuration Guide

**Audience:** Operators deploying OpenClaw agents in multi-human environments (Discord, Slack group channels, shared voice rooms)

---

## The default behavior (single-user mode)

Out of the box, OpenClaw Hyperspell operates in single-user mode: all memory reads and writes use `cfg.userId` as the Hyperspell user account. In a private 1:1 channel this is fine. In a group chat with multiple humans it produces three concrete problems:

1. **No speaker attribution** — every human's turns are written to the same store under `cfg.userId`. Retrieval cannot separate who said what.
2. **Emotional register collapse** — if `emotionalContext` is enabled, group-chat transcripts are blocked from updating the relationship register (as of PR #60), but without `multiUser` the register has no per-sender concept at all.
3. **Identity bleed** — when `auto-context` surfaces a memory fragment that names a person other than the current live sender, the agent has no reliable ground truth about who it's talking to right now. The `AUTHORITY_GUARD` (PR #60) addresses the retrieval-authority side of this, but not the underlying attribution gap.

The speaker-prefix workaround (PR #60) partially mitigates (1): user messages are stored as `[Name]: content`, so attribution survives in the text when an envelope sender is present. This helps retrieval in practice but is not a substitute for proper per-user memory spaces.

---

## The proper fix: `multiUser` config

Add a `multiUser` block to the `openclaw-hyperspell` plugin config in `~/.openclaw/openclaw.json`:

```json
{
  "openclaw-hyperspell": {
    "config": {
      "userId": "alinea",
      "multiUser": {
        "sharedUserId": "alinea-shared",
        "includeSharedInSearch": false,
        "senderMap": {
          "<sender_id_1>": { "userId": "person-a", "name": "Person A" },
          "<sender_id_2>": { "userId": "person-b", "name": "Person B" }
        }
      }
    }
  }
}
```

### Getting sender IDs

The `sender_id` comes from the platform connector's inbound envelope field `sender_id`. You can find it in the gateway debug log — look for `ctx.senderId` or `ctx.sender` entries. For Discord/Slack, these are stable numeric account IDs.

As a shortcut: enable `debug: true` in the plugin config for one session, observe the logs, then disable it.

### What `multiUser` unlocks

| Feature | Without `multiUser` | With `multiUser` |
|---|---|---|
| Memory ownership | All turns → `cfg.userId` | David's turns → `userId: "david"`, Keely's → `userId: "keely"` |
| `auto-context` search | Searches full shared store | Personal search for known sender + optional shared |
| Identity preamble | None | "You are speaking with David S." injected each turn |
| Unknown senders | Treated as `cfg.userId` | Falls back to `sharedUserId` |
| Emotional register | Store skipped in group chats | Needs per-sender `relationshipId` (see below) |
| `resolved` flag | Always `false` (single-user default) | `true` for senderMap matches, `false` for unknowns |

### Per-sender emotional registers

The `emotionalContext` feature uses `cfg.relationshipId` as the store key. With `multiUser`, you need separate `relationshipId`s per sender. This isn't directly supported via a senderMap field today — the workaround is either:

1. Run separate agent instances per relationship (each with its own `relationshipId`)
2. Disable `emotionalContext` in group-chat sessions and store emotional state only in private sessions

---

## The speaker-prefix workaround (interim, no config required)

PR #60 adds a content-level attribution workaround that fires automatically when:
- `is_group_chat: true` is present in the inbound envelope
- No `multiUser` config is set
- The envelope carries a real `sender` or `username` (not just `cfg.userId`)

User messages are stored as:
```
[David S]: what they actually said
```

This makes attribution searchable in the text content. Limitations:
- Both speakers still share the same Hyperspell user space — cross-user search isolation is impossible
- Auto-trace JSONL has no equivalent prefix (full multi-message format, not per-message content)
- The Hyperspell metadata filter dialect issues (#40) still apply to these rows

The prefix is stripped by `sanitizeTraceText` in the auto-trace and auto-context sanitization pipeline — so it won't re-appear as a "recalled memory" prefix. It only affects the stored representation.

---

## Decision tree

```
Is the agent used in a group chat with multiple humans?
  └─ No → single-user mode is fine; no changes needed
  └─ Yes
       └─ Do you need per-user memory separation?
            └─ No → PR #60 speaker-prefix workaround is enough for basic attribution
            └─ Yes → add multiUser config with senderMap
                       └─ Do you need per-user emotional registers?
                            └─ No → multiUser config is sufficient
                            └─ Yes → separate agent instances per relationship, or disable emotionalContext
```

---

## Diagnostics

**Confirm group-chat attribution is working (single-user mode):**
Look in the gateway log for:
```
hot-buffer: group chat detected but multiUser is not configured — all turns written under cfg.userId with no speaker attribution
```
This fires once per session. If you see it, the speaker-prefix workaround is active but you're in degraded mode. Consider `multiUser` config.

**Confirm multiUser resolution is working:**
Enable `debug: true` in the plugin config. Look for:
```
sender resolved via senderId: 689590407323189323 -> david
```
If you see `sender unresolved, falling back to sharedUserId` for a sender you expect to be known, their `sender_id` isn't in `senderMap` — add it.

**Check what's being stored:**
Search hot-buffer rows for the `[Name]: ` prefix pattern using the Hyperspell search tool with a query like `"[David S]:"`. If hits come back, speaker attribution is landing in stored content.
