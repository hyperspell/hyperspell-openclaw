# Implementation guide — #80: retroactive cleanup for `excludeChannels` quarantine

## 0. Scope-determining finding: is already-synced content identifiable by channel?

**Partially yes — and the part that matters most (hot-buffer conversation content) is already tagged.** The answer differs per write path, and this determines the whole shape of the fix:

| Write path | Channel-identifiable after the fact? | How |
|---|---|---|
| Hot buffer (`hooks/hot-buffer.ts`) | **Yes**, for rows written since metadata tagging was enabled (verified live 2026-07-02) | Metadata `openclaw_channel_id` (plus `openclaw_session_id`, `openclaw_source: "hot_buffer"`). Metadata persists on the live hot row **and is unioned onto the server-consolidated vault Resource**, so consolidated resources carry the tag too. Also `resourceId === sessionId`, giving a secondary session-id join for untagged rows. |
| Hot buffer, rows written **before** tagging was enabled | **Not by metadata** — those rows were written content-only. | Only via the `resourceId === sessionId` identity: the operator can map the quarantined channel → session ids via OpenClaw's local session store and delete by resource id. |
| Auto-trace (`hooks/auto-trace.ts` → `client.sendTrace`) | **No.** Metadata carries `openclaw_source: "agent_end"`, `openclaw_user`, `openclaw_scope` — **no channel id, no session id in metadata**. `session_id` is sent as a first-class field but is not exposed by `listMemories` (yields only resourceId/source/title/metadata). | Traces are enumerable (`metadata.openclaw_source === "agent_end"`) but not channel-attributable without fetching each raw resource via `getMemory` and checking whether the backend echoes `session_id` (verify live — unconfirmed). This is a real gap; fix forward (below). |
| Emotional state (`hooks/emotional-state.ts`) | **No channel scoping at all.** Keyed by `relationshipId`; `deleteEmotionalState` is per-relationship, all-or-nothing. | Document as limitation. **⚠️ Stays a limitation even after issue #74 lands** (which tags register metadata with an unprefixed `channelId`, not `openclaw_channel_id` — a deliberate naming choice within the emotional-state metadata namespace, see #74's design decision 2): registers aren't reachable via `listMemories`/this command's enumeration path regardless of tagging, since they live behind `/emotional-state`, not the memories store. Don't assume #74 closes this row once it lands; if emotional-state purge is ever wanted, it needs its own lookup path against `getEmotionalState`/`getRecentEmotionalStates`, and would key on `metadata.channelId`, not `openclaw_channel_id`. |
| `hyperspell_remember` tool / `/remember` (`tools/remember.ts` → `addMemory`) | **No.** Metadata `openclaw_source: "command"`, `source: "openclaw_tool"` — no channel id. | Document as limitation; fix forward is optional (the tool is already suppressed in quarantined channels going forward via the tool-factory choke point). |
| Server-side extractions derived from traces (`extract: ["procedure","memory","mood"]`) | **Unknown** — derived resources are created backend-side; whether deleting the parent trace removes them is unverified. | File as a Hyperspell-backend follow-up (add to `docs/hyperspell-backend-followups.md`); document honestly. |

**Conclusion:** the `openclaw_channel_id` tag (same tag relevant to #74) makes this a much smaller lift than "full retroactive purge." A query+delete command keyed on that tag cleanly removes all hot-buffer-origin content written by any post-tagging version — which in the live deployment that motivated this issue is the dominant leak surface. Traces, pre-tagging hot rows, emotional state, and remember-tool writes need (a) forward-tagging fixes and (b) documented limitations, not heroics.

Discovery primitive: `client.listMemories()` yields metadata per memory but the SDK list endpoint exposes **no metadata filter** — so the purge enumerates and filters client-side. Don't use `search()` for purge: it's query-driven top-N, not exhaustive. Deletion primitive already exists: `client.deleteMemory(resourceId, { source, userId })`, 404-tolerant.

---

## 1. Deliverable A (guaranteed minimum): document the forward-only limitation

1. **`README.md`** — `excludeChannels` is currently *not documented at all*. Add a row to the Configuration Options table:
   ```
   | `excludeChannels` | string[] | `[]` | Conversation/channel ids fully quarantined from memory: no context injection, no memory writes, no memory tools. Threads inherit. **Forward-only** — see below. |
   ```
   and a short subsection (suggest after "Auto-Context"):
   > ### `excludeChannels` is forward-only
   > Adding a channel to `excludeChannels` stops all future injection/writes/tools for that conversation, but does **not** remove content that was synced before the channel was quarantined. Hot-buffer content written by plugin versions since 2026-07 is tagged with `openclaw_channel_id` and can be removed with `openclaw openclaw-hyperspell purge-channel <id>`. Auto-trace resources, emotional-state registers, `/remember` memories, and hot-buffer rows written by older versions are **not** channel-tagged and cannot be automatically purged — see the purge command's `--resource` escape hatch and the limitations note in its `--help`.

2. **`config.ts`** — extend the `excludeChannels` jsdoc with one line: `Forward-only: content synced before a channel is quarantined stays in Hyperspell; use the purge-channel CLI command to remove tagged content.`

3. **`openclaw.plugin.json`** — append to the `help` string: `Forward-only; already-synced content is not removed (see purge-channel CLI command).`

4. **`lib/exclude-channels.ts`** module doc — add one line noting the forward-only property and pointing at the purge command.

---

## 2. Deliverable B (forward-fix): close the tagging gaps so *future* pre-quarantine content is purgeable

The purge command is only as good as the tags. Two cheap, additive metadata changes:

1. **Auto-trace** (`hooks/auto-trace.ts`, inside `buildAutoTraceHandler` before the `client.sendTrace` call): resolve the conversation id with the existing helper and pass it through metadata:
   ```ts
   import { channelIdFromCtx } from "../lib/exclude-channels.ts"
   // ...
   const channelId = channelIdFromCtx(ctx)
   await client.sendTrace(history, {
     ...,
     metadata: {
       ...cfg.autoTrace.metadata,
       ...(channelId ? { openclaw_channel_id: channelId } : {}),
       openclaw_session_id: sessionId,
     },
   })
   ```
   (`sendTrace` already spreads caller metadata under the `openclaw_source`/user/scope tags — no client change needed.)

2. **Hot buffer** (`hooks/hot-buffer.ts`): replace the direct `ctx?.channelId` read with `channelIdFromCtx(ctx)` so sessions whose context lacks `channelId` but carries a parseable `sessionKey` still get tagged — mirroring exactly what the quarantine check matches on. This keeps tag-time identity and quarantine-time identity the same function, which is the invariant the purge relies on.

3. Optional, small: tag `tools/remember.ts` writes the same way (`metadata: { source: "openclaw_tool", ...(channelId ? { openclaw_channel_id: channelId } : {}) }`). Low value (tool is already blocked in quarantined channels) but makes the tag universal for the "quarantined later" scenario, which is precisely this issue.

4. Drive-by: the comment block at `lib/filters.ts` ("a `/messages` write carrying `metadata` … becomes NON-retrievable") is stale — it predates the 2026-07-02 verification. Update it to point at the current behavior so the two comments stop contradicting each other.

---

## 3. Deliverable C: `purge-channel` CLI command

A CLI command (not a slash command): purging is a destructive operator action and the CLI already hosts operator workflows (`network scan/complete/sync`).

### 3.1 New helper export in `lib/exclude-channels.ts`

The purge must match stored ids with the same semantics quarantine uses (exact or thread-suffix prefix, case-insensitive). Extract that predicate so both sites share it:

```ts
/** True when a stored conversation id belongs to `channel` (exact or thread suffix). */
export function conversationMatchesChannel(id: string, channel: string): boolean {
  const a = id.toLowerCase()
  const b = channel.toLowerCase()
  return a === b || a.startsWith(`${b}:`)
}
```
Rewrite the body of `isExcludedChannel`'s `.some()` to call it (net-zero LOC in that function).

### 3.2 New file `commands/purge-channel.ts`

Pure logic separated from CLI wiring so it's unit-testable with a stub client:

```ts
import type { HyperspellClient } from "../client.ts"
import type { HyperspellConfig, HyperspellSource } from "../config.ts"
import { conversationMatchesChannel } from "../lib/exclude-channels.ts"

export type PurgeMatch = {
  resourceId: string
  source: HyperspellSource
  title: string | null
  via: "channel_tag" | "session_id" | "explicit"
}
export type PurgeResult = { matched: PurgeMatch[]; deleted: number; failed: number }

export async function findChannelMemories(
  client: HyperspellClient,
  channelId: string,
  opts: { sources: HyperspellSource[]; userId?: string; sessionIds?: string[] },
): Promise<PurgeMatch[]> {
  const matches: PurgeMatch[] = []
  const sessionIds = new Set((opts.sessionIds ?? []).map((s) => s.toLowerCase()))
  for (const source of opts.sources) {
    for await (const m of client.listMemories({ source, userId: opts.userId })) {
      const tagged = m.metadata.openclaw_channel_id
      if (typeof tagged === "string" && conversationMatchesChannel(tagged, channelId)) {
        matches.push({ resourceId: m.resourceId, source: m.source, title: m.title, via: "channel_tag" })
      } else if (sessionIds.has(m.resourceId.toLowerCase())) {
        // Hot-buffer resource_id === sessionId — legacy untagged rows are
        // reachable only through this identity.
        matches.push({ resourceId: m.resourceId, source: m.source, title: m.title, via: "session_id" })
      }
    }
  }
  return matches
}

export async function deleteMatches(
  client: HyperspellClient,
  matches: PurgeMatch[],
  opts: { userId?: string },
): Promise<PurgeResult> {
  let deleted = 0, failed = 0
  for (const m of matches) {
    const r = await client.deleteMemory(m.resourceId, { source: m.source, userId: opts.userId })
    r.deleted ? deleted++ : failed++   // deleteMemory is already 404-tolerant
  }
  return { matched: matches, deleted, failed }
}
```

### 3.3 CLI wiring in `commands/setup.ts` (inside `registerCliCommands`)

```
openclaw openclaw-hyperspell purge-channel <channelId>
  --source <sources>    comma-separated; default "vault" (hot-buffer consolidation target
                        and cfg.hotBuffer.source default)
  --user <userId>       X-As-User to scan/delete under; default cfg.userId. In multiUser
                        deployments run once per mapped userId.
  --session <ids>       comma-separated OpenClaw session ids for legacy untagged hot-buffer
                        resources (resource_id === sessionId)
  --resource <ids>      explicit resource ids (escape hatch for traces/remember memories
                        the operator identified manually via hyperspell_search)
  --yes                 actually delete; WITHOUT --yes the command is a dry run that
                        prints the matched resources and exits 0
```

Action body mirrors `network scan`: `parseConfig(pluginConfig)` → `new HyperspellClient(cfg)` → `findChannelMemories` (+ append `--resource` ids as `via: "explicit"`) → print table (`resourceId  source  via  title`) → if `--yes`, `deleteMatches` and print counts; non-zero exit on `failed > 0`. Always print the standing-limitations footer: *traces (`openclaw_source: "agent_end"`) written before this version, emotional-state registers, and pre-2026-07 hot rows are not channel-tagged; see README.* Dry-run-by-default is the safety posture — no interactive prompt needed, which also keeps it usable from cron/exec like the `network` commands.

Also document the operator recipe for `--session` in the README section (how to extract session ids for a conversation from OpenClaw's session store, whose keys embed the conversation id — same format `conversationIdFromSessionKey` parses).

---

## 4. Tests

`package.json` runs an **explicit file list** under `node --test` — every new test file must be appended there.

1. **`commands/purge-channel.test.ts`** (new; add to the test script):
   - stub client with canned `listMemories` async generator + recording `deleteMemory`;
   - matches exact `openclaw_channel_id` and thread-suffixed ids (`chan-9:thread:1`), case-insensitively; skips other channels and untagged rows;
   - `--session` path: untagged memory whose `resourceId` equals a supplied session id is matched `via: "session_id"`;
   - dry run (`deleteMatches` not called) vs. delete path counts `deleted`/`failed` correctly when `deleteMemory` returns `{deleted:false}`;
   - multiple `--source` values each get a `listMemories` call with the right `source`/`userId`.
2. **`lib/exclude-channels.test.ts`** — add cases for the new `conversationMatchesChannel` export (exact, prefix, case, non-match `chan-90` vs `chan-9`).
3. **`hooks/auto-trace.test.ts`** — assert `sendTrace` is now called with `metadata.openclaw_channel_id` when ctx carries `channelId` (and via `sessionKey` fallback), plus `openclaw_session_id`; and that it's omitted when neither resolves.
4. **`hooks/hot-buffer.test.ts`** already asserts the tag from `ctx.channelId`; add one case proving the new `sessionKey` fallback tags too.

### Live verification (per the issue's test plan)
1. In a test deployment with hot buffer on, converse in channel X; confirm via `hyperspell_search`/probe that content is retrievable and rows carry `openclaw_channel_id`.
2. Add X to `excludeChannels`, restart gateway; confirm no new writes/injection and that pre-existing content **is still retrievable** — capture this as the documented current behavior.
3. Run `purge-channel X` (dry run) — matched list shows the session resources; run with `--yes`; confirm `hyperspell_search` no longer returns them (allow ~60s for hot-row consolidation; a direct delete of a pre-consolidation hot row can 404 — `deleteMemory` treats that as success, so re-run after consolidation if a row survives).
4. Verify the `getMemory` raw response for an `agent_end` trace to settle whether `session_id` is echoed (would upgrade future trace cleanup); record the finding in `docs/hyperspell-backend-followups.md` either way, alongside the derived-extraction-deletion question.

---

## Files touched

- `README.md` — document `excludeChannels` (config table + forward-only section + purge command docs)
- `config.ts` — jsdoc note on `excludeChannels` (no behavior change)
- `openclaw.plugin.json` — `excludeChannels` help text
- `lib/exclude-channels.ts` — module-doc note; new `conversationMatchesChannel` export; `isExcludedChannel` reuses it
- `lib/exclude-channels.test.ts` — helper tests
- `hooks/auto-trace.ts` — tag traces with `openclaw_channel_id` / `openclaw_session_id`
- `hooks/auto-trace.test.ts` — metadata assertions
- `hooks/hot-buffer.ts` — use `channelIdFromCtx` for tagging (quarantine/tag identity parity)
- `hooks/hot-buffer.test.ts` — sessionKey-fallback tag case
- `tools/remember.ts` — (optional) channel tag on tool writes
- `lib/filters.ts` — stale comment fix
- `commands/purge-channel.ts` — new: `findChannelMemories` / `deleteMatches`
- `commands/purge-channel.test.ts` — new
- `commands/setup.ts` — wire `purge-channel` subcommand into `registerCliCommands`
- `package.json` — append new test files to the `test` script
- `docs/hyperspell-backend-followups.md` — trace `session_id` echo + derived-extraction deletion questions
