# Implementation guide: configurable debounce windows (fixes #79)

Both debounce windows are hardcoded to 3 minutes:

- `hooks/emotional-state.ts` — `const STORE_DEBOUNCE_MS = 3 * 60 * 1000;`, used once in `buildEmotionalStateStoreHandler` (`if (since < STORE_DEBOUNCE_MS)`)
- `hooks/auto-trace.ts` — `const TRACE_DEBOUNCE_MS = 3 * 60 * 1000;`, used once in `buildAutoTraceHandler` (`if (since < TRACE_DEBOUNCE_MS)`)

This exposes both as config with the 3-minute values kept as defaults. Setting `0` disables debouncing (`since < 0` is never true, so every qualifying turn sends).

**Related to issue #77 (mood-weather cross-session cooldown).** #77 introduces a third hardcoded real-time window, `MOOD_WEATHER_COOLDOWN_MS`, in the same shape (module-scope constant, gates a `Date.now()`-based comparison) but for a different reason — it's a product-design guardrail ("weather, not a gimmick"), not an ops-rhythm tuning knob like these two. #77's guide recommends landing with a fixed constant first and enrolling it in whatever config mechanism this guide settles on, as a follow-up rather than blocking either PR on the other. If this guide lands first, when #77 is implemented afterward, add `moodWeatherCooldownMs` alongside `autoTrace.debounceMs`/`emotionalStateDebounceMs` using the same feature-owned-key pattern (default `6h`, clamped `>= 0`, `0` meaning "no cross-session cooldown") rather than inventing a fourth pattern. If #77 lands first with its own fixed constant, extend this guide's config additions to cover it in the same PR rather than leaving three timing knobs configured two different ways.

## Key shape: feature-owned keys, not a `timing` sub-object

- **Auto-trace:** `autoTrace.debounceMs` — the `autoTrace` sub-object already exists (`enabled`, `extract`, `metadata`), and `syncMemories.debounceMs` is the established precedent for a per-feature `debounceMs`.
- **Emotional state:** top-level `emotionalStateDebounceMs` — emotional state has no sub-object; its existing tunables (`emotionalContext`, `moodWeatherChance`, `relationshipId`) are all flat top-level keys.

Against a generic `timing` sub-object: it would separate each knob from the feature that owns it (`autoTrace.enabled` in one place, its debounce in another) and add a third grouping convention on top of the two that already exist. Re #77: if the mood-weather cooldown lands, it should follow the same feature-owned pattern — a flat `moodWeatherCooldownMs` next to `moodWeatherChance` — not a new `timing` bucket.

## 1. `config.ts`

**Types** — add to `AutoTraceConfig`:

```ts
export type AutoTraceConfig = {
	enabled: boolean;
	extract: Array<"procedure" | "memory" | "mood">;
	metadata?: Record<string, string | number | boolean>;
	/** Min ms between trace sends per session. 0 = send every qualifying turn. Default: 180000 (3 min). */
	debounceMs: number;
};
```

Add to `HyperspellConfig` (next to `moodWeatherChance`):

```ts
	/**
	 * Min ms between emotional-state snapshots per relationship (each store is a
	 * backend LLM call). 0 = snapshot every qualifying turn. Default: 180000 (3 min).
	 */
	emotionalStateDebounceMs: number;
```

**`ALLOWED_KEYS`** — add `"emotionalStateDebounceMs"` (parseConfig hard-rejects unknown top-level keys, so forgetting this makes the new key throw). `autoTrace` sub-keys have no `assertAllowedKeys` gate, so nothing needed there.

**`parseConfig`** — follow the `moodWeatherChance` clamp pattern. Near the top (by the other defaults):

```ts
// Historical hardcoded window both hooks shipped with; kept as the default.
const DEFAULT_DEBOUNCE_MS = 3 * 60 * 1000;
```

In the returned object:

```ts
		autoTrace: {
			enabled: (atRaw.enabled as boolean) ?? false,
			extract: ... /* unchanged */,
			metadata: ... /* unchanged */,
			// Clamped to >=0 so a negative config value can't produce a
			// never-debounce-and-also-never-store comparison.
			debounceMs: Math.max(0, (atRaw.debounceMs as number) ?? DEFAULT_DEBOUNCE_MS),
		},
```

and next to `moodWeatherChance`:

```ts
		emotionalStateDebounceMs: Math.max(
			0,
			(cfg.emotionalStateDebounceMs as number) ?? DEFAULT_DEBOUNCE_MS,
		),
```

## 2. Use sites (one line each + delete the constants)

**`hooks/emotional-state.ts`** — delete `STORE_DEBOUNCE_MS` (keep its doc comment on the config field or at the use site), and update:

```ts
		// Debounce: at most one snapshot per cfg.emotionalStateDebounceMs of active talk.
		if (since < cfg.emotionalStateDebounceMs) {
```

**`hooks/auto-trace.ts`** — delete `TRACE_DEBOUNCE_MS` (fold its "sendTrace re-sends the full transcript" rationale into the comment already at the use site, and update the header comment's `STORE_DEBOUNCE_MS` cross-reference), and update:

```ts
		if (since < cfg.autoTrace.debounceMs) {
```

`cfg` is already in scope in both handlers (`buildEmotionalStateStoreHandler(client, cfg)` / `buildAutoTraceHandler(client, cfg)`), so no signature changes.

## 3. `openclaw.plugin.json`

`configSchema` has top-level `"additionalProperties": false`, so the new top-level key **must** be added or valid configs fail schema validation. Keep it in sync with parseConfig (the repo norm — every parsed key is mirrored in `configSchema`):

- Under `properties.autoTrace.properties`:

```json
					"debounceMs": {
						"type": "number",
						"minimum": 0,
						"description": "Min ms between trace sends per session (default 180000 = 3 min; 0 sends every qualifying turn)"
					}
```

- Top-level, next to `moodWeatherChance`:

```json
			"emotionalStateDebounceMs": {
				"type": "number",
				"minimum": 0,
				"description": "Min ms between emotional-state snapshots per relationship (default 180000 = 3 min; 0 snapshots every qualifying turn)"
			},
```

`uiHints` entries are optional — `moodWeatherChance` and `ranking` have none; skip them here too. No version bump in this PR.

## 4. Tests — prove the configured value changes behavior

The cleanest deterministic proof (no sleeps): with the shipped default, a second immediate call is debounced (already covered by existing tests); with a configured `0`, it is not. That can only pass if the runtime reads config, not the old constant.

**`hooks/emotional-state.test.ts`** — first, fix the `storeCfg` helper: it currently casts `{ relationshipId }` to the config type, so after this change `cfg.emotionalStateDebounceMs` would be `undefined` and `since < undefined` is always false — the existing "debounces repeated stores within the window" test would silently break. Update it to take the window:

```ts
const storeCfg = (relationshipId: string, emotionalStateDebounceMs = 3 * 60 * 1000) =>
	({ relationshipId, emotionalStateDebounceMs }) as unknown as Parameters<
		typeof buildEmotionalStateStoreHandler
	>[1];
```

Then add:

```ts
test("emotional-state store — configured debounceMs=0 replaces the 3-minute default", async () => {
	const { client, stores } = makeStoreClient();
	const handler = buildEmotionalStateStoreHandler(
		client as unknown as Parameters<typeof buildEmotionalStateStoreHandler>[0],
		storeCfg("rel-cfg-debounce", 0),
	);
	await handler({ success: true, messages: richMessages }, { trigger: "user" });
	await handler({ success: true, messages: richMessages }, { trigger: "user" });
	assert.equal(stores.length, 2, "with debounceMs=0 the second store must go through");
});
```

**`hooks/auto-trace.test.ts`** — the shared `cfg` uses `parseConfig`, so defaults flow in automatically and existing tests stay green. Add:

```ts
test("auto-trace — configured debounceMs=0 replaces the 3-minute default", async () => {
	const { client, calls } = makeClient();
	const zeroCfg = parseConfig({
		apiKey: "k",
		userId: "u1",
		autoTrace: { enabled: true, debounceMs: 0 },
	});
	const handler = buildAutoTraceHandler(client, zeroCfg);
	const ctx = { sessionId: "s-cfg-debounce-1" };
	await handler({ success: true, messages: longMessages }, ctx);
	await handler({ success: true, messages: longMessages }, ctx);
	assert.equal(calls.length, 2, "with debounceMs=0 the second send must go through");
	buildAutoTraceSessionCleanupHandler()({ sessionId: "s-cfg-debounce-1" });
});
```

**`config.test.ts`** — one parse test for defaults + clamp:

```ts
test("parseConfig — debounce windows default to 3 min and clamp negatives to 0", () => {
	const def = parseConfig({ apiKey: "k" });
	assert.equal(def.autoTrace.debounceMs, 180000);
	assert.equal(def.emotionalStateDebounceMs, 180000);
	const custom = parseConfig({
		apiKey: "k",
		emotionalStateDebounceMs: -5,
		autoTrace: { debounceMs: 60000 },
	});
	assert.equal(custom.emotionalStateDebounceMs, 0);
	assert.equal(custom.autoTrace.debounceMs, 60000);
});
```

Run: `npm test` (node --test already includes all three files).

Manual verification: set `"autoTrace": { "enabled": true, "debounceMs": 10000 }` and `"emotionalStateDebounceMs": 10000`, run two turns ~30s apart, and confirm the debug log (`auto-trace: skipping — debounced (...)` / `emotional-state: skipping — debounced (...)`) no longer fires where the 3-minute default would have skipped.

## Files touched

- `config.ts` — `AutoTraceConfig.debounceMs`, `HyperspellConfig.emotionalStateDebounceMs`, `ALLOWED_KEYS`, `parseConfig` defaults + clamps
- `hooks/emotional-state.ts` — delete `STORE_DEBOUNCE_MS`, read `cfg.emotionalStateDebounceMs`
- `hooks/auto-trace.ts` — delete `TRACE_DEBOUNCE_MS`, read `cfg.autoTrace.debounceMs`, update header comment
- `openclaw.plugin.json` — `configSchema` additions (required: top-level schema is `additionalProperties: false`)
- `hooks/emotional-state.test.ts` — `storeCfg` helper fix (required) + debounce-override test
- `hooks/auto-trace.test.ts` — debounce-override test
- `config.test.ts` — default/clamp parse test
