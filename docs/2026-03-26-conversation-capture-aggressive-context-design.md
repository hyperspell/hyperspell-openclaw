# Conversation Capture & Aggressive Context Retrieval

**Date:** 2026-03-26
**Status:** Approved
**Repo:** hyperspell-openclaw

## Problem

The Hyperspell OpenClaw plugin currently:

1. Only reads from Hyperspell (auto-context search) but never writes conversation data back
2. Starts every new session with a blank slate — no awareness of prior conversations
3. Gives up too easily when searches return few or low-relevance results

Users lose continuity between sessions and the agent lacks context that it discussed in previous interactions.

## Goals

1. **Capture every conversation turn** to Hyperspell so prior sessions become searchable context
2. **Warm-start new sessions** with recent conversation history so the agent has continuity
3. **Try harder on search** before deciding there's nothing relevant — broader fallback searches

## Design

### 1. Conversation Capture (`agent_end` hook)

After every agent turn completes, capture the user prompt and assistant response as a single memory.

**Handler:** New file `hooks/conversation-capture.ts`

**Behavior:**
- Registered on the `agent_end` event
- Extracts user and assistant messages from `event.messages` (same structure the LanceDB plugin uses: array of `{ role, content }` objects)
- Formats as a conversation transcript:
  ```
  User: <user message>

  Assistant: <assistant message>
  ```
- Calls `client.addMemory()` with:
  - `collection`: `"openclaw_conversations"` (defined as `CONVERSATION_COLLECTION` constant in `config.ts`)
  - `title`: First ~80 chars of user prompt
  - `resourceId`: Deterministic ID `openclaw_conv_{sessionId}_{turnIndex}` where turnIndex is derived from the message count (prevents duplicates on retries)
  - `metadata`: `{ openclaw_source: "conversation", session_id: event.sessionId }`
- Fire-and-forget — errors are logged but don't block the user
- Skipped if `event.success` is false or messages are empty
- Gated by config: `captureConversations` (default: `true`)

**Content extraction:** Handles both string content and array content blocks (same pattern as LanceDB plugin — type-guard for `{ type: "text", text: string }` blocks). Combined content truncated to 10,000 chars max.

**Note on `client.addMemory()`:** The existing method hardcodes `openclaw_source: "command"` in metadata. This will be changed so that caller-provided metadata keys take precedence — the hardcoded default only applies when the caller does not provide `openclaw_source`.

### 2. Session Start Context (`session_start` hook)

When a new session begins, fetch recent conversation history and inject it as context.

**Handler:** New file `hooks/session-context.ts`

**Behavior:**
- Registered on `session_start` event
- Uses `client.listMemories()` (not `search()`) filtered to `collection: "openclaw_conversations"` to fetch recent memories — this avoids needing a query string since there's no user prompt yet
- Client-side filters to memories within `recentContextHours` (default 48h) using `metadata.created_at`
- If no recent results: falls back to `client.search()` with a generic query like `"recent conversations and context"` across all collections, limited to `maxResults`
- Formats results as prepended context
- Returns `{ prependContext: formattedString }`
- **Total context budget:** Max 5 conversation memories on session start, with each truncated to 500 chars preview. This caps the injected context at ~3,000 chars to avoid blowing up the LLM context window.

**Context format:**
```
<hyperspell-session-context>
The following is a summary of your recent conversations with this user.
Use this to maintain continuity — reference prior discussions naturally.

## Recent Conversations
- [time] title
  content preview...
...
</hyperspell-session-context>
```

### 3. Enhanced Auto-Context ("try harder" fallback)

Modify the existing `before_agent_start` handler to do a broader search when initial results are poor.

**File:** `hooks/auto-context.ts` (modified)

**Trigger conditions (OR):**
- Fewer than 3 results returned
- All returned results have relevance score below the configured threshold (default 0.30, configurable via `minRelevanceScore`)

**Fallback behavior:**
- Run `client.searchWithAnswer()` with the same query — this does a broader search and generates an LLM-synthesized answer
- Merge fallback results with initial results, deduplicating by `resourceId`
- Include the synthesized answer in the context block if available
- The merged + enhanced context replaces the original sparse context

**Latency note:** `searchWithAnswer()` involves an LLM call and adds ~1-3s latency. This is acceptable because the fallback only triggers when the initial search failed to find good results — in the normal case (plenty of relevant memories), the fast path is unchanged. No config gate needed since the trigger conditions already limit when this fires.

**Enhanced context format** (when answer is available):
```
<hyperspell-context>
...existing format...

## Synthesized Context
<answer from searchWithAnswer>
</hyperspell-context>
```

### 4. Configuration

New fields added to `HyperspellConfig`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `captureConversations` | boolean | `true` | Capture conversation turns to Hyperspell |
| `recentContextHours` | number | `48` | Hours of recent history to fetch on session start |
| `minRelevanceScore` | number | `0.30` | Minimum relevance score (0-1) before "try harder" fallback triggers |

Added to `openclaw.plugin.json` config schema and UI hints.

**Shared constant:** `CONVERSATION_COLLECTION = "openclaw_conversations"` defined in `config.ts`.

### 5. Registration (index.ts)

New hooks registered alongside existing ones:

```typescript
// Conversation capture
if (cfg.captureConversations) {
  const captureHandler = buildConversationCaptureHandler(client, cfg)
  api.on("agent_end", captureHandler)
}

// Session start context
if (cfg.autoContext) {
  const sessionContextHandler = buildSessionContextHandler(client, cfg)
  api.on("session_start", sessionContextHandler)
}
```

Session context uses the same `autoContext` gate since it's conceptually the same feature (automatic context injection).

## Files Changed

| File | Change |
|------|--------|
| `config.ts` | Add `captureConversations`, `recentContextHours`, `minRelevanceScore`, and `CONVERSATION_COLLECTION` constant |
| `client.ts` | Fix `addMemory()` metadata merge so caller-provided keys take precedence over defaults |
| `hooks/conversation-capture.ts` | **New** — `agent_end` handler for conversation capture |
| `hooks/session-context.ts` | **New** — `session_start` handler for recent history injection |
| `hooks/auto-context.ts` | Add "try harder" fallback with `searchWithAnswer()` |
| `index.ts` | Register new hooks |
| `openclaw.plugin.json` | Add new config fields to schema + uiHints |
| `README.md` | Document new features and config options |

## Edge Cases

- **Long messages:** Truncate combined user+assistant content to 10,000 chars before sending to `addMemory()`
- **Tool-heavy turns:** Still captured — the user prompt alone is valuable context
- **Duplicate captures:** Deterministic `resourceId` (`openclaw_conv_{sessionId}_{turnIndex}`) prevents duplicates on retries or plugin restarts
- **API failures:** All Hyperspell calls in new hooks are wrapped in try/catch. Failures log warnings but never break the user's session
- **Session-start context overflow:** Capped at 5 conversations, 500 chars each (~3,000 chars total)
- **`session_start` vs `before_agent_start`:** If `session_start` doesn't support returning `prependContext`, fall back to detecting "first turn" in `before_agent_start` (track session IDs seen in a Set)
- **`addMemory` metadata:** Caller-provided `openclaw_source` takes precedence over the default `"command"` value
