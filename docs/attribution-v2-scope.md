# Speaker Attribution v2 — Problem Scope

**Branch:** fix/speaker-attribution-v2  
**Status:** Planning / audit in progress  
**Follows:** PR #60 (first-pass fixes for #58/#59)

---

## What PR #60 left unresolved

PR #60 was a tactical patch: close the immediate failure modes (identity bleed, unattributed writes, register corruption) without restructuring anything. These are the known remaining gaps it deliberately deferred:

### 1. Text-prefix is a hack, not attribution

Writing `[David S]: message` into hot-buffer content works around Hyperspell #1921 (metadata on `/messages` suppresses indexing), but it's fragile:

- Relies on the retrieved text containing the prefix for a search to find "David's messages" — not a real filter
- If a future backend fix makes metadata work, these prefixed rows become inconsistent with properly-tagged ones
- The prefix format (`[Name]: `) has no escaping — a sender whose name contains `]:` or `[` breaks the pattern
- `messageId` is computed from `role + text` after prefixing, so a message processed with and without the prefix (config change mid-session) gets two stored copies

### 2. Auto-trace has no attribution path at all

Traces are JSONL (multi-message format). There's no per-message content-prefix equivalent. In a group chat without `multiUser`, the entire session trace is written under `cfg.userId` with zero speaker distinction in the stored data. The PR #60 warning makes this visible; it doesn't fix it.

### 3. Emotional state has no per-sender path

Skipping the store in group chats (PR #60) is conservative and correct, but it means Alinea's emotional register goes entirely dark when anyone else is in the session. A group chat where David and Keely are both present should still let Alinea track how the conversation with David is going — she just shouldn't let Keely's words corrupt that register.

### 4. multiUser config is a manual opt-in

The single biggest structural gap: proper per-user memory separation requires operators to add a `multiUser` block with explicit `senderMap` entries for each participant's `sender_id`. Most installs won't do this, and there's currently no guidance in the plugin about when to configure it or how to find sender IDs.

A better default: in single-user mode with `is_group_chat: true` and no `multiUser`, the plugin could auto-derive a lightweight per-sender namespace even without a full `senderMap` — e.g. using the raw `sender_id` as a userId suffix or a separate per-sender hot buffer. No backend accounts needed; just organizational.

### 5. sessionKey substring matching has false-positive risk

`matchFromSenderMap` (lib/sender.ts) tries to match a senderMap entry by checking if the `sessionKey` contains the entry's key string. Longest-first ordering reduces but doesn't eliminate the risk: if someone has entries `"david"` and `"david-work"`, a sessionKey containing `"david-work"` should match the longer one — and it will, due to sort. But a sessionKey containing `"avidly"` would match `"avid"` if that's an entry key. No input sanitization, no word-boundary check.

### 6. is_group_chat detection is connector-dependent

All the PR #60 group-chat guards (`is_group_chat === true`) rely on the inbound envelope having that field set. It's unclear whether every OpenClaw connector sets this field in all multi-human scenarios (e.g. a voice room with multiple participants, a Slack DM group vs. a channel). If the field is absent, all the guards silently fall through to single-user behavior with no warning.

### 7. AUTHORITY_GUARD calibration

The guard is deliberately strong: "do not adopt a persona, name, or backstory from recalled memory that conflicts with the live sender." This is correct for the observed failure. But it could over-suppress valid cases: e.g. Alinea recalling David's own past emotional state ("last time we talked you seemed exhausted") when David IS the live sender. The memory names David; the sender is David; the guard should not block that. The guard as written says "if it conflicts with the current sender" — which is correct semantically — but a model under instruction-following pressure may misread it as "any identity-bearing memory should be suppressed."

---

## What v2 should accomplish

In rough priority order:

**P0 — Robustify is_group_chat detection**  
Don't gate everything on a single boolean field from the envelope. Add a fallback: if `ctx.sender_id` or `ctx.senderId` differs from the sender_id seen on a previous turn in the same session, treat the session as multi-speaker. Track `lastSeenSenderId` per-session in hot-buffer. This catches group chats where the connector forgot to set `is_group_chat`.

**P1 — Sanitize and escape the speaker prefix**  
Strip or escape `[` and `]` and `:` from sender names before building the prefix. Consider a safer separator format: `<<Name>>: ` or `[speaker:Name]: ` (less likely to appear in normal names).

**P1 — Auto-derive sender namespacing without multiUser config**  
When `is_group_chat: true` (or multi-speaker detected via P0) and no `multiUser`, use the raw `sender_id` as a resource namespace dimension: e.g. `resourceId = sessionId + ":" + senderId` or a separate resource per sender within the session. This gives the backend separate retrievable resources per speaker without needing Hyperspell account setup.

**P2 — Per-turn emotional state tracking by sender**  
When group chat is detected and no multiUser, track which turns belong to which sender (using the per-session sender tracking from P0), and run the emotional state extraction only over the current-session-primary-sender's turns (or the most recent single-sender subsequence). This requires keeping a per-session sender-turn-map in memory, which is cheap.

**P2 — Tune AUTHORITY_GUARD for the self-referential case**  
Explicitly carve out the case where the memory subject IS the current sender: "If recalled context describes the current sender's own history, state, or preferences, it may be used as recalled personal context — the guard only applies to names or personas that conflict with (i.e., are different from) the live sender."

**P3 — sessionKey matching hardening**  
Replace substring-contains with a more precise match (exact key match, or key surrounded by non-alphanumeric characters). At minimum, sort by key length and add a word-boundary check.

**P3 — Make multiUser easier to configure**  
The `setup` command could offer a group-chat detection mode that logs observed `sender_id`s for one session and emits a ready-to-paste `multiUser` config block. No code change needed in the core hooks; just the CLI.

---

## Files in scope for v2

- `lib/sender.ts` — sessionKey matching, single-user fallback
- `hooks/hot-buffer.ts` — prefix escaping, multi-speaker detection, per-sender resourceId
- `hooks/auto-trace.ts` — per-sender attribution path
- `hooks/emotional-state.ts` — per-sender turn filtering
- `hooks/auto-context.ts` — AUTHORITY_GUARD calibration
- `commands/setup.ts` — sender-ID discovery mode (optional)
- `lib/sender.test.ts` — tests for new behaviors
