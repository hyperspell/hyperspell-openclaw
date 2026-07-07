# Implementation Guide: `hyperspell_emotional_arc` — on-demand emotional-arc tool (issue #76)

## Summary

Add a fourth agent-facing tool, `hyperspell_emotional_arc`, that lets the agent explicitly re-fetch the emotional register mid-conversation. Today the register only arrives via passive injection on the first `before_prompt_build` of a session (`hooks/emotional-state.ts` → `buildEmotionalStateFetchHandler`); after compaction the injected block may be gone from history, and `injectedSessions` re-injection only helps on the *next* turn's prompt build — the agent has no way to pull the arc *now*, inside a turn.

The tool is a thin wrapper over logic that already exists: `fetchRecentOrLatest` (which calls `client.getRecentEmotionalStates(cfg.relationshipId, limit)` with a `getEmotionalState` fallback), the `looksLikeRawTranscript` placeholder filter, and `buildEmotionalContext` formatting. No new client methods, no new config keys, no backend changes.

**Formatting decision: reuse `buildEmotionalContext` verbatim.** The issue's acceptance test is "the tool returns the same content that would've been injected fresh at a new session's start." Reusing the exact formatter makes that true by construction (byte-identical block, including the `<hyperspell-emotional-context>` wrapper and the single-vs-multi-state intro), and avoids a second formatting path to keep in sync. One intentional difference from the injection path: **no mood weather**. `rollMood` lives purely in the injection path by design (its own comment: rolled once per session, never written back) — a tool call must not re-roll a session mood.

---

## Step 1 — Export the reusable pieces from `hooks/emotional-state.ts`

`looksLikeRawTranscript` is already exported. `fetchRecentOrLatest`, `buildEmotionalContext`, and `EMOTIONAL_ARC_LIMIT` are currently module-private — export them, and give `fetchRecentOrLatest` an optional `limit` parameter (the hook call site stays unchanged via the default):

```ts
// hooks/emotional-state.ts

/** How many recent registers to surface as the "arc" at session start. */
export const EMOTIONAL_ARC_LIMIT = 3;

// ...

export async function fetchRecentOrLatest(
	client: HyperspellClient,
	cfg: HyperspellConfig,
	limit: number = EMOTIONAL_ARC_LIMIT,
): Promise<EmotionalStateLatest[]> {
	try {
		const recent = await client.getRecentEmotionalStates(
			cfg.relationshipId,
			limit,
		);
		if (recent !== null) return recent; // endpoint available (may be empty)
	} catch (err) {
		log.debug("emotional-context: /recent unavailable — falling back to latest", err);
	}
	const single = await client.getEmotionalState(cfg.relationshipId);
	return single ? [single] : [];
}

/** Build the injected emotional-context block from one or more registers. */
export function buildEmotionalContext(states: EmotionalStateLatest[]): string {
	// body unchanged
}
```

No cycle risk: `tools/emotional-arc.ts` → `hooks/emotional-state.ts` → (`hooks/auto-trace.ts`, `hooks/mood-weather.ts`, `client.ts`, `config.ts`, `lib/*`) — nothing in that chain imports from `tools/`.

## Step 2 — New file `tools/emotional-arc.ts`

Follow the `createSearchToolFactory`/`createRememberToolFactory` shape exactly: `(client, cfg) => (ctx) => ({ name, label, description, parameters, execute })`. This tool doesn't need sender context (the register is keyed to `cfg.relationshipId`, not the current speaker), so the factory takes `_ctx` — but it must keep the factory signature so `toolUnlessQuarantined` can wrap it. Use `tools/` style (2-space indent, no semicolons, like `tools/search.ts`).

```ts
import { Type } from "@sinclair/typebox"
import type { HyperspellClient } from "../client.ts"
import type { HyperspellConfig } from "../config.ts"
import {
  buildEmotionalContext,
  EMOTIONAL_ARC_LIMIT,
  fetchRecentOrLatest,
  looksLikeRawTranscript,
} from "../hooks/emotional-state.ts"
import { log } from "../logger.ts"

/** Hard cap so the agent can't ask the backend for an unbounded history. */
const MAX_ARC_LIMIT = 10

export function createEmotionalArcToolFactory(
  client: HyperspellClient,
  cfg: HyperspellConfig,
) {
  return (_ctx: Record<string, unknown>) => ({
    name: "hyperspell_emotional_arc",
    label: "Emotional Arc",
    description:
      "Fetch the recent emotional arc of your relationship with this user — the same emotional-context block that is injected at session start. Use it when that block is no longer in your history (e.g. after the conversation was compacted) or when you genuinely want to reflect on how the relationship has been feeling before responding. Returns the most recent emotional registers, newest first. Let the trajectory inform your tone — don't recite it back to the user.",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Number({
          description: `How many recent registers to fetch (default ${EMOTIONAL_ARC_LIMIT}, max ${MAX_ARC_LIMIT})`,
        }),
      ),
    }),
    async execute(_toolCallId: string, params: { limit?: number }) {
      const limit = Math.min(
        Math.max(Math.floor(params.limit ?? EMOTIONAL_ARC_LIMIT), 1),
        MAX_ARC_LIMIT,
      )
      log.debug(
        `emotional-arc tool: limit=${limit} relationshipId=${cfg.relationshipId ?? "(default)"}`,
      )

      try {
        const states = await fetchRecentOrLatest(client, cfg, limit)

        // Same placeholder filter as the injection path: for ~10s after a
        // store, the register can be the RAW input transcript (status=pending),
        // not a distilled feeling. Returning that would pollute tone.
        const usable = states.filter(
          (s) => s.summary && !looksLikeRawTranscript(s.summary),
        )

        if (usable.length === 0) {
          const text =
            states.length > 0
              ? "The latest emotional register is still being extracted — try again in a few seconds."
              : "No emotional arc recorded yet for this relationship. It builds up as real conversations end."
          return { content: [{ type: "text" as const, text }] }
        }

        // Deliberately identical to the session-start injection block
        // (buildEmotionalContext), so a post-compaction re-fetch restores
        // exactly what a fresh session would have received. Mood weather is
        // intentionally NOT included — it is an injection-only session override.
        return {
          content: [
            { type: "text" as const, text: buildEmotionalContext(usable) },
          ],
          details: { count: usable.length },
        }
      } catch (err) {
        log.error("emotional-arc tool failed", err)
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to fetch emotional arc: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        }
      }
    },
  })
}
```

Notes on the shape:

- **Return shape** matches `tools/search.ts`: `{ content: [{ type: "text", text }] }` plus optional `details`. Errors are returned as text, never thrown — same contract as both existing tools.
- **`fetchRecentOrLatest` already handles the 404 fallback**: `client.getRecentEmotionalStates` returns `null` when `/emotional-state/recent` isn't deployed, and the helper falls back to `client.getEmotionalState(cfg.relationshipId)`. The tool inherits pre/post-endpoint-deploy behavior for free.
- **No `relationshipId` parameter on the tool.** The register's identity is operator config (`cfg.relationshipId`) — letting the model pick an arbitrary relationship id would cross a privacy boundary the config deliberately owns. If per-relationship querying is ever wanted, that's a follow-up with multiUser-aware gating.

## Step 3 — Register in `index.ts`, gated on `cfg.emotionalContext`

Follow the existing conditional-registration pattern (`if (cfg.knowledgeGraph.enabled) registerNetworkTools(...)`). Register inside the existing `if (cfg.emotionalContext)` block, wrapped in `toolUnlessQuarantined` so `excludeChannels` sessions never see the tool — same quarantine choke point as `hyperspell_search`/`hyperspell_remember`:

```ts
// index.ts — add import
import { createEmotionalArcToolFactory } from "./tools/emotional-arc.ts"

// index.ts — inside the existing `if (cfg.emotionalContext) {` block:
if (cfg.emotionalContext) {
	// On-demand arc re-fetch (issue #76): the session-start injection can be
	// compacted out of history mid-session; this tool lets the agent pull the
	// exact same block back without waiting for the next prompt build.
	api.registerTool(
		toolUnlessQuarantined(createEmotionalArcToolFactory(client, cfg)),
		{ name: "hyperspell_emotional_arc" },
	);
	startHandlers.push({
		name: "emotional-state",
		// ... existing content unchanged
```

Gating rationale: when `cfg.emotionalContext` is off, nothing ever *stores* registers (`buildEmotionalStateStoreHandler` is also gated on it), so the tool would only ever return "no arc yet" — registering it would waste tool-schema tokens on every turn. This mirrors how the network tools are only registered under `cfg.knowledgeGraph.enabled`. Note the `allowConversationAccess` warning does **not** apply here — that gate is for `agent_end` hooks, and tools are unaffected.

## Step 4 — Manifest: `openclaw.plugin.json`

Add the tool to `contracts.tools`. Precedent for conditionally-registered tools appearing in the static manifest: the three `hyperspell_network_*` tools are listed even though they only register under `knowledgeGraph.enabled`.

```json
"contracts": {
	"tools": [
		"hyperspell_search",
		"hyperspell_remember",
		"hyperspell_emotional_arc",
		"hyperspell_network_scan",
		"hyperspell_network_write",
		"hyperspell_network_complete"
	]
}
```

No `configSchema`/`uiHints` changes — the tool introduces zero new config surface.

## Step 5 — Test file `tools/emotional-arc.test.ts`

**Gotcha: the test runner is an explicit file list.** `package.json`'s `"test"` script enumerates every test file. A new test file that isn't added there silently never runs. Add `tools/emotional-arc.test.ts` to that list (next to `tools/search.test.ts`).

Follow the `tools/search.test.ts` pattern (node:test + `assert/strict`, `parseConfig` for real config, minimal fake client cast to `HyperspellClient`) combined with the `State`/`st()` fixtures from `hooks/emotional-state.test.ts`:

```ts
import assert from "node:assert/strict"
import { test } from "node:test"
import type { HyperspellClient } from "../client.ts"
import { parseConfig } from "../config.ts"
import { createEmotionalArcToolFactory } from "./emotional-arc.ts"

const cfg = parseConfig({
  apiKey: "k",
  userId: "u1",
  emotionalContext: true,
  relationshipId: "rel-x",
})

type State = {
  resourceId: string
  summary: string
  extractedAt: string
  sessionId: string | null
  relationshipId: string | null
}

const st = (summary: string): State => ({
  resourceId: `es-${summary.slice(0, 4)}`,
  summary,
  extractedAt: new Date().toISOString(),
  sessionId: null,
  relationshipId: "rel-x",
})

function toolWith(client: {
  getRecentEmotionalStates: (relId?: string, limit?: number) => Promise<State[] | null>
  getEmotionalState?: (relId?: string) => Promise<State | null>
}) {
  return createEmotionalArcToolFactory(client as unknown as HyperspellClient, cfg)({})
}

async function runText(
  tool: ReturnType<ReturnType<typeof createEmotionalArcToolFactory>>,
  params: { limit?: number } = {},
) {
  const res = await tool.execute("call-1", params)
  return (res.content[0] as { text: string }).text
}

test("emotional-arc tool — returns the same block the session-start injection builds", async () => {
  const tool = toolWith({
    async getRecentEmotionalStates() {
      return [st("Warm and collaborative lately."), st("A bit strained last week.")]
    },
  })
  const text = await runText(tool)
  assert.match(text, /<hyperspell-emotional-context>/)
  assert.match(text, /most recent first/) // multi-state intro from buildEmotionalContext
  assert.match(text, /Warm and collaborative lately\./)
  assert.match(text, /A bit strained last week\./)
  assert.match(text, /<\/hyperspell-emotional-context>/)
})

test("emotional-arc tool — falls back to getEmotionalState when /recent is unavailable", async () => {
  let latestCalls = 0
  const tool = toolWith({
    async getRecentEmotionalStates() {
      return null // endpoint not deployed (404)
    },
    async getEmotionalState() {
      latestCalls++
      return st("Single latest register.")
    },
  })
  const text = await runText(tool)
  assert.equal(latestCalls, 1)
  assert.match(text, /Single latest register\./)
  assert.match(text, /from your last interaction/) // single-state intro
})

test("emotional-arc tool — no registers yet reports a blank slate, not an error", async () => {
  const tool = toolWith({
    async getRecentEmotionalStates() {
      return []
    },
    async getEmotionalState() {
      return null
    },
  })
  const text = await runText(tool)
  assert.match(text, /No emotional arc recorded yet/)
  assert.doesNotMatch(text, /Failed/)
})

test("emotional-arc tool — raw-transcript placeholders are filtered, pending state says so", async () => {
  const tool = toolWith({
    async getRecentEmotionalStates() {
      return [st("user: hey how are you\nassistant: doing well!")]
    },
  })
  const text = await runText(tool)
  assert.match(text, /still being extracted/)
  assert.doesNotMatch(text, /doing well!/) // raw transcript must not leak through
})

test("emotional-arc tool — backend failure returns error text, does not throw", async () => {
  const tool = toolWith({
    async getRecentEmotionalStates() {
      throw new Error("boom")
    },
    async getEmotionalState() {
      throw new Error("boom")
    },
  })
  const text = await runText(tool)
  assert.match(text, /Failed to fetch emotional arc: boom/)
})

test("emotional-arc tool — limit is forwarded and clamped to the max", async () => {
  const seen: Array<number | undefined> = []
  const tool = toolWith({
    async getRecentEmotionalStates(_relId, limit) {
      seen.push(limit)
      return [st("ok")]
    },
  })
  await tool.execute("call-1", { limit: 999 })
  await tool.execute("call-2", {})
  assert.deepEqual(seen, [10, 3]) // MAX_ARC_LIMIT clamp; EMOTIONAL_ARC_LIMIT default
})
```

## Edge cases (and how each is handled)

| Case | Behavior |
|---|---|
| `cfg.relationshipId` not configured | Fine by design — `fetchRecentOrLatest` passes `undefined`; the client methods simply omit the `relationship_id` query param and the backend returns the default relationship's register. No guard needed. |
| No registers exist yet | Friendly "No emotional arc recorded yet" text — not an error, so the agent doesn't confabulate a failure. |
| All fetched states are raw-transcript placeholders (extraction pending, ~10s window) | Filtered with the exported `looksLikeRawTranscript`; distinct "still being extracted — try again in a few seconds" text (mirrors the injection path's skip). |
| `/emotional-state/recent` not deployed (404) | `fetchRecentOrLatest` falls back to `getEmotionalState` — inherited, already tested at the hook level. |
| Backend error / throttle | Caught in `execute`, returned as `Failed to fetch emotional arc: …` text; never throws into the tool runner. |
| Quarantined channel (`excludeChannels`) | Factory wrapped in `toolUnlessQuarantined` → returns `null`, tool never exposed in that session — consistent with search/remember. |
| `emotionalContext: false` | Tool not registered at all (no wasted tool-schema tokens for a feature that stores nothing). |
| Absurd `limit` (0, negative, 999, fractional) | Clamped to `[1, MAX_ARC_LIMIT]` and floored. |
| Mood weather | Intentionally excluded — injection-path-only session override; a tool call re-rolling mood would violate its once-per-session contract. |

## Verification

1. `npm test` (after the package.json script addition) — new file runs alongside `tools/search.test.ts` and `hooks/emotional-state.test.ts`; the latter must still pass unchanged (exports-only refactor).
2. `npm run check-types` and `npm run lint`.
3. Manual, per the issue's test plan: in a session with `emotionalContext: true`, talk long enough to trigger compaction (or force one), then ask the agent to call `hyperspell_emotional_arc` and diff its output against the `<hyperspell-emotional-context>` block a fresh session receives at start — they should match modulo the relative timestamps and any mood-weather block (absent from the tool by design).
4. Quarantine check: in an `excludeChannels` session, confirm the tool is absent from the tool list.

## Files touched

- `tools/emotional-arc.ts` — **new**: `createEmotionalArcToolFactory`
- `tools/emotional-arc.test.ts` — **new**: tool behavior tests
- `hooks/emotional-state.ts` — export `EMOTIONAL_ARC_LIMIT`, `buildEmotionalContext`, `fetchRecentOrLatest`; add optional `limit` param to `fetchRecentOrLatest` (hook behavior unchanged)
- `index.ts` — import + `api.registerTool(toolUnlessQuarantined(...), { name: "hyperspell_emotional_arc" })` inside the `if (cfg.emotionalContext)` block
- `openclaw.plugin.json` — add `"hyperspell_emotional_arc"` to `contracts.tools`
- `package.json` — add `tools/emotional-arc.test.ts` to the `"test"` script's explicit file list
- `README.md` — add the tool to the tools list so the docs match `contracts.tools`
