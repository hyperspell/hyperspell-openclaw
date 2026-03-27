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
  - `collection`: `"openclaw_conversations"`
  - `title`: First ~80 chars of user prompt
  - `metadata`: `{ source: "openclaw_conversation", session_id: event.sessionId }`
- Fire-and-forget — errors are logged but don't block the user
- Skipped if `event.success` is false or messages are empty
- Gated by config: `captureConversations` (default: `true`)

**Content extraction:** Handles both string content and array content blocks (same pattern as LanceDB plugin — type-guard for `{ type: "text", text: string }` blocks).

### 2. Session Start Context (`session_start` hook)

When a new session begins, fetch recent conversation history and inject it as context.

**Handler:** New file `hooks/session-context.ts`

**Behavior:**
- Registered on `session_start` event
- Searches Hyperspell for recent conversation memories:
  1. First search: recent memories (within `recentContextHours`, default 48h) from `openclaw_conversations` collection
  2. If no results: fall back to an unfiltered search across all collections for the most relevant memories
- Formats results as prepended context with a section header indicating these are prior conversation summaries
- Returns `{ prependContext: formattedString }`
- Uses `maxResults` config for result count

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
- All returned results have relevance score below 30%

**Fallback behavior:**
- Run `client.searchWithAnswer()` with the same query — this does a broader search and generates an LLM-synthesized answer
- Merge fallback results with initial results, deduplicating by `resourceId`
- Include the synthesized answer in the context block if available
- The merged + enhanced context replaces the original sparse context

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

Added to `openclaw.plugin.json` config schema and UI hints.

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
| `config.ts` | Add `captureConversations`, `recentContextHours` to type, parser, and defaults |
| `hooks/conversation-capture.ts` | **New** — `agent_end` handler for conversation capture |
| `hooks/session-context.ts` | **New** — `session_start` handler for recent history injection |
| `hooks/auto-context.ts` | Add "try harder" fallback with `searchWithAnswer()` |
| `index.ts` | Register new hooks |
| `openclaw.plugin.json` | Add new config fields to schema + uiHints |
| `README.md` | Document new features and config options |

## Edge Cases

- **Long messages:** Truncate combined user+assistant content to a reasonable limit (e.g. 10,000 chars) before sending to `addMemory()` to avoid oversized payloads
- **Tool-heavy turns:** Some turns are mostly tool calls with minimal text. Still capture them — the user prompt alone is valuable context
- **Rapid-fire turns:** Each turn is captured independently. Hyperspell handles deduplication at the search layer
- **API failures:** All Hyperspell calls in new hooks are wrapped in try/catch. Failures log warnings but never break the user's session
- **`session_start` vs `before_agent_start`:** If `session_start` doesn't support returning `prependContext`, fall back to detecting "first turn" in `before_agent_start` (check if it's the first event in a session)
