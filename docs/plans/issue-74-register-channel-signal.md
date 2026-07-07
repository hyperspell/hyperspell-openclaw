# Implementation guide: tag the emotional register with the channel it came from (#74)

## Summary

`hooks/hot-buffer.ts` already tags every `POST /messages` write with `openclaw_channel_id` resolved from `ctx.channelId`, but the Tin Man register store in `hooks/emotional-state.ts` sends only `metadata: { source: "openclaw_agent_end" }`. This PR threads the channel id into `storeEmotionalState`'s metadata — **data capture only**. Nothing about the injected prose changes.

## Design decisions (read before coding)

1. **Resolve via the existing `channelIdFromCtx` helper, not a new inline check.** `lib/exclude-channels.ts:40-44` already exports the canonical "resolve the conversation id from any hook context" helper: it prefers `ctx.channelId` and falls back to parsing the composite `sessionKey` (`agent:<agentId>:<provider>:<kind>:<id>` → `<id>`). This subsumes hot-buffer's inline direct-only pattern and is already unit-tested. Reusing it means zero new resolution logic and slightly better coverage than hot-buffer gets today (e.g. a context that carries only a composite `sessionKey`).
2. **Metadata key: `channelId`.** The emotional-state metadata namespace already uses an unprefixed key (`source: "openclaw_agent_end"`), unlike the `/messages` namespace which prefixes (`openclaw_source`, `openclaw_channel_id`). Stay consistent *within* the emotional-state document type. (If cross-resource analysis uniformity ever matters, a follow-up can dual-write `openclaw_channel_id`; don't do that now.)
3. **The field must be optional — spread it in conditionally, exactly like hot-buffer does.** See "Is `channelId` always resolvable?" below.
4. **No client type change needed.** `client.ts:569-585` — `storeEmotionalState` already accepts `metadata?: Record<string, string | number | boolean>` and passes it straight through to the request body. Arbitrary string fields are accepted today.

## Is `channelId` always resolvable for the triggers that reach the store?

No — and that's fine. The store handler already excludes `cron` / `heartbeat` / `memory` via `NON_CONVERSATIONAL_TRIGGERS`, but the remaining reachable cases are `user`, `overflow`, `manual`, and **`undefined`** (there's an explicit test that an undefined trigger still stores). A `manual` CLI run or an undefined-trigger context has no conversation target, so `channelIdFromCtx` returns `undefined` (its `conversationIdFromSessionKey` fallback explicitly returns `undefined` for "cron runs, bare UUIDs, …"). The conditional spread makes absence a silent no-op, never a crash, matching the hot-buffer precedent.

## The change

### 1. `hooks/emotional-state.ts`

Add the import (there are already imports from `../lib/`):

```ts
import { channelIdFromCtx } from "../lib/exclude-channels.ts";
```

In `buildEmotionalStateStoreHandler`, replace the store call:

```ts
try {
	// Tag the register with the medium it was extracted from (voice vs Discord vs
	// DM), mirroring hot-buffer's openclaw_channel_id tag. Capture-only: analysis/
	// debugging metadata, deliberately NOT surfaced in the injected prose (#74).
	const channelId = channelIdFromCtx(ctx as Record<string, unknown>);
	const result = await client.storeEmotionalState(transcript, {
		relationshipId: cfg.relationshipId,
		metadata: {
			source: "openclaw_agent_end",
			...(channelId ? { channelId } : {}),
		},
	});
```

That's the whole runtime change. (The local `AgentContext` type doesn't need a `channelId` field because `channelIdFromCtx` takes `Record<string, unknown>`, and the handler already casts `ctx` that way for `resolveCurrentSessionId` / `isMultiSpeaker`. Adding `channelId?: string` to the type is optional polish; skip it to keep the diff minimal.)

### 2. `hooks/emotional-state.test.ts`

Widen `makeStoreClient` to capture metadata:

```ts
function makeStoreClient() {
	const stores: Array<{
		transcript: string;
		opts: { relationshipId?: string; metadata?: Record<string, string | number | boolean> };
	}> = [];
	const client = {
		async storeEmotionalState(
			transcript: string,
			opts: { relationshipId?: string; metadata?: Record<string, string | number | boolean> },
		) {
			stores.push({ transcript, opts });
			return { resourceId: "es-x", status: "pending", summary: "", extractedAt: "", sessionId: null, relationshipId: opts?.relationshipId ?? null };
		},
	};
	return { client, stores };
}
```

Add three tests after the debounce test. **Gotcha:** `lastStoreAt` is module-scoped and keyed by `relationshipId`, so each test must use a unique relationship id (existing tests already follow this pattern) or the debounce will eat the store.

```ts
test("emotional-state store — tags metadata with channelId from ctx (#74)", async () => {
	const { client, stores } = makeStoreClient();
	const handler = buildEmotionalStateStoreHandler(
		client as unknown as Parameters<typeof buildEmotionalStateStoreHandler>[0],
		storeCfg("rel-chan-direct"),
	);
	await handler(
		{ success: true, messages: richMessages },
		{ trigger: "user", channelId: "chan-42" } as never,
	);
	assert.equal(stores.length, 1);
	assert.deepEqual(stores[0].opts.metadata, {
		source: "openclaw_agent_end",
		channelId: "chan-42",
	});
});

test("emotional-state store — resolves channelId from composite sessionKey when ctx.channelId is absent", async () => {
	const { client, stores } = makeStoreClient();
	const handler = buildEmotionalStateStoreHandler(
		client as unknown as Parameters<typeof buildEmotionalStateStoreHandler>[0],
		storeCfg("rel-chan-skey"),
	);
	await handler(
		{ success: true, messages: richMessages },
		{ trigger: "user", sessionKey: "agent:main:discord:channel:222" },
	);
	assert.equal(stores.length, 1);
	assert.equal(stores[0].opts.metadata?.channelId, "222");
});

test("emotional-state store — omits channelId when unresolvable, still stores (no crash)", async () => {
	const { client, stores } = makeStoreClient();
	const handler = buildEmotionalStateStoreHandler(
		client as unknown as Parameters<typeof buildEmotionalStateStoreHandler>[0],
		storeCfg("rel-chan-none"),
	);
	// e.g. a manual CLI run: no channelId, sessionKey has no conversation segment.
	await handler({ success: true, messages: richMessages }, { trigger: "user" });
	assert.equal(stores.length, 1);
	assert.deepEqual(stores[0].opts.metadata, { source: "openclaw_agent_end" });
});
```

(The `as never` cast in the first test is because the local `AgentContext` type doesn't declare `channelId`; if you opt into adding `channelId?: string` to the type, drop the cast.)

## Verification

- Unit: `npm test` (repo's `node --test --experimental-strip-types ...` script already includes `hooks/emotional-state.test.ts`), plus `npm run check-types` and `npm run lint`.
- Live (per the issue): on the same day, have a real voice call and a terse Discord exchange (>3 messages, >100 chars, >3 min apart so the debounce doesn't collapse them into one store), then fetch the stored registers and confirm each carries the correct `channelId` in metadata. Check gateway logs for the `emotional-state: stored <resourceId>` lines to identify the two resources.

## Future work — explicitly NOT in this PR

Someday the injected prose (`buildEmotionalContext`) could reference the medium — e.g. letting the arc distinguish "warm on a voice call" from "clipped on Discord," or weighting registers from the *current* channel more heavily at fetch time. That is deliberately out of scope here: surfacing the channel in the prompt risks turning it into a ritual signal the model performs around ("as we discussed on our call…"). This PR is capture-only; any prose-side use should be its own issue with its own evaluation of that risk. The data captured here makes that future analysis possible.

## Files touched

- `hooks/emotional-state.ts` — import `channelIdFromCtx`; conditionally add `channelId` to `storeEmotionalState` metadata in `buildEmotionalStateStoreHandler` (~4 lines + comment)
- `hooks/emotional-state.test.ts` — widen `makeStoreClient` to capture metadata; 3 new tests (tagged / sessionKey-fallback / absent-no-crash)
- `client.ts` — **no change** (metadata signature already accepts arbitrary string fields)
