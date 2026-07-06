# Hot Buffer: a gateway restart mid-session resends the entire transcript instead of just the new turns

**Where:** client-side (this plugin), `hooks/hot-buffer.ts`. Not a Hyperspell backend bug — fixed in this repo.
**Date:** 2026-07-06

## Summary

`agent_end` fires on every turn with the **full session history**, not a diff. `hot-buffer.ts` has always relied on a per-session `sentBySession` map (message-id set) to turn that into "only post what's new" — see the #42/#45 fix that made `resourceId`/dedup key off the stable `ctx.sessionId` instead of a fresh random id every turn.

What that fix didn't account for: `sentBySession` is a **module-scope, in-memory-only** `Map`. It's cleared on `session_end` — but a bare gateway restart does not fire `session_end`, it just kills the process. The next `agent_end` for a session that was already in progress hits an empty in-memory map, looks exactly like a brand-new session, and re-posts every prior message in one shot. The server upserts on message id, so this is not a correctness bug (no duplicate rows), but it is a real write-amplification / backend-load bug, and it produced actual duplicate-looking noise in the vault from the resend.

## Live evidence

Normal hot-buffer flushes write 2-10 messages per turn. Two flushes on 2026-07-06 wrote **499** and **503** messages in a single `POST /messages` call — both immediately after gateway restarts triggered while working on unrelated cron changes. Log line shape:

```
hyperspell: hot-buffer: wrote 503 message(s) to <session-id> (user=alinea)
```

against sessions that had been running well before that count of turns.

## Root cause

```ts
// hooks/hot-buffer.ts, pre-fix
const sent = sentBySession.get(sessionId) ?? new Set<string>();
```

`sentBySession` has no persistence beyond the process. A restart wipes it silently; there is no signal (no `session_end`, no error) to distinguish "new session" from "same session, memory forgot." Everything downstream (batching, upsert) behaves correctly on the resent data — it's the volume that's wrong.

## Fix

Mirror the in-memory set to a small per-session JSON file on disk (`<workspaceDir>/hot-buffer-sent/<sessionId>.json`), so a restart degrades to "reload from disk" instead of "resend everything":

- `loadPersistedSent(root, sessionId)` — read-through when the in-memory map has no entry for this session (covers both "brand new" and "process restarted mid-session"; the former just gets an empty set back).
- `persistSent(root, sessionId, sent)` — written after every successful `sendMessages` call, alongside the existing in-memory update.
- `deletePersistedSent(root, sessionId)` — called from `buildHotBufferSessionCleanupHandler` on real `session_end`, same as the in-memory `.delete()` it already did.

Chose disk persistence over asking Hyperspell "what message ids already exist for this resourceId" per turn: a server round-trip adds latency to every turn's fire-and-forget write, and the backend's filter/list semantics are independently unreliable right now (see `docs/hyperspell-backend-followups.md` issues #1/#2) — not something to build a correctness guarantee on top of.

`buildHotBufferHandler`/`buildHotBufferSessionCleanupHandler` both take an optional `opts.stateRoot`, defaulting to `getWorkspaceDir()`. Tests pass an explicit temp dir so the suite never touches a developer's real `~/.openclaw` workspace.

## Verification

1. Unit tests (`hooks/hot-buffer.test.ts`): a restart is simulated by dropping just the in-memory entry for a session (`__simulateRestartForTest`, test-only export) while leaving the on-disk state — this is precisely what a real restart does (module state gone, disk intact). Confirms only the new turns are sent, not the whole transcript. A second test confirms real `session_end` still clears the persisted file (no unbounded disk growth for sessions that end normally).
2. **Real two-process end-to-end check** (not just an in-process simulation): spawned the actual handler in one `node` process for turn 1, let that process exit completely, then spawned a **second, brand-new `node` process** with the same `stateRoot`/session id for turn 2 (full history + one new pair) — this is what an actual gateway restart looks like, not an approximation.
   - Against the **pre-fix** code: turn 2 sent `["turn-1", "reply-1", "turn-2"]` — the whole transcript, reproducing the bug exactly.
   - Against the **fixed** code: turn 2 sent only `["reply-1", "turn-2"]`.
3. `tsc --noEmit` clean; full existing suite (199 tests) still green.

## Follow-up

The two restart-triggered resends on 2026-07-06 (499 and 503 messages) landed duplicate-looking hot-buffer rows in Alinea's live Hyperspell account. Since the server upserts by message id, these aren't duplicate *rows* in the strict sense, but worth a pass to confirm the account doesn't have any leftover mess from those two incidents before considering this fully closed.
