# Implementation guide — issue #69: `allowConversationAccess` startup warning fires unconditionally

## Background / root cause

The uncommitted WIP in `index.ts` adds a startup reminder (working tree lines 105–119):

```ts
// index.ts:113-119 (current working tree)
if (cfg.emotionalContext || cfg.autoTrace.enabled || cfg.hotBuffer.enabled) {
	api.logger.warn(
		"hyperspell: emotionalContext/autoTrace/hotBuffer write to agent_end, " +
			"which requires plugins.entries.openclaw-hyperspell.hooks.allowConversationAccess=true " +
			"in openclaw.json. If that key is missing, these features will silently do nothing.",
	);
}
```

This fires on **every** gateway start whenever any of the three `agent_end` features is enabled — including on correctly-configured installs (which is the common case, since `commands/setup.ts` writes the key automatically). Verified against OpenClaw core (`src/plugins/registry.ts`, the typed-hook registration gate): when a non-bundled plugin registers a conversation hook without `plugins.entries.<id>.hooks.allowConversationAccess === true`, core `pushDiagnostic`s a warn-level message **and silently returns** — `api.on()` is `void`, no error propagates, and the plugin API exposes no way to read hook-grant state. So from inside the plugin the check genuinely cannot be made conditional today; the WIP comment already says as much.

Conclusion: the reminder is inherently unconditional given today's SDK surface, so it must not read as an alarm. Downgrade to `info` and reword; propose real grant introspection upstream.

**⚠️ Landing-order note: three separate guides touch `index.ts`'s `register()` near the same spot.** This one (#69) edits the *existing* `allowConversationAccess` warn block. #72 (moodWeatherChance discoverability) and #81 (Memory Network discoverability) each *add a new* info-level log block nearby, following this one's pattern as precedent. Suggested order: land **this PR (#69) first** — it touches existing lines, so it has the smallest conflict surface, and the other two can literally copy its finished shape. #72 and #81 can then land in either order relative to each other (both are purely additive new blocks); whichever lands second just needs a trivial rebase past the other's insertion. If you're implementing #72 or #81 and #69 has already landed, use its actual merged wording/level as the template rather than re-deriving the `info`-vs-`warn` decision from scratch.

## Part 1 — What this PR does today: downgrade to `info` + reword

### 1a. `index.ts` — change level and wording

Replace the warning block with:

```ts
if (cfg.emotionalContext || cfg.autoTrace.enabled || cfg.hotBuffer.enabled) {
	api.logger.info(
		"hyperspell: emotionalContext/autoTrace/hotBuffer write via agent_end, which the host " +
			"only delivers when plugins.entries.openclaw-hyperspell.hooks.allowConversationAccess=true " +
			"is set in openclaw.json ('openclaw openclaw-hyperspell setup' writes it automatically). " +
			"This plugin cannot verify the grant from here; if the key is missing these features " +
			"silently do nothing.",
	);
}
```

Wording changes vs. WIP: leads with what the features need rather than an implied failure, mentions that `setup` already writes the key (so a correctly-configured operator can immediately dismiss it), and states explicitly why it's unconditional ("cannot verify the grant from here").

### 1b. `index.ts` — update the comment block

Amend the existing comment's last sentence to record the level decision so a future editor doesn't "helpfully" re-promote it:

```ts
// emotionalContext, autoTrace, and hotBuffer all register on `agent_end`,
// which OpenClaw gates as a "conversation hook": non-bundled plugins must
// have plugins.entries.openclaw-hyperspell.hooks.allowConversationAccess
// set to true in openclaw.json, or the host silently drops the
// registration (host-side diagnostic is warn-level only — there is no
// way for the plugin to detect the drop from in here; see the
// hook-grant-introspection follow-up in issue #69). Because the check
// cannot be conditional, this logs at INFO, not WARN — it fires on every
// start including correctly-configured installs. `setup.ts` writes the
// key automatically for new installs.
```

## Part 2 — Test: assert the log level and gating

There is no `index.test.ts` today, and the reminder lives directly in `register()`, so test it at the `register()` boundary with a mock `api`. This is safe: at register time the only side effects are `initLogger`, `new HyperspellClient(cfg)` (constructor only builds the SDK client and logs — no network), and registrations against the injected `api`. Network/file-watcher work happens only inside the service `start()` callback, which the test never invokes. `knowledgeGraph` defaults to disabled so `registerNetworkTools` is skipped.

Existing convention (matches `hooks/emotional-state.test.ts`, `hooks/auto-trace.test.ts`): `node:test` + `node:assert/strict`, hand-rolled capturing mocks, colocated file.

### 2a. New file `index.test.ts`

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import plugin from "./index.ts";

type LogCall = { level: "info" | "warn" | "error" | "debug"; message: string };

function registerWith(pluginConfig: Record<string, unknown>): LogCall[] {
	const logs: LogCall[] = [];
	const capture =
		(level: LogCall["level"]) =>
		(message: string) => {
			logs.push({ level, message });
		};
	const api = {
		pluginConfig,
		logger: {
			info: capture("info"),
			warn: capture("warn"),
			error: capture("error"),
			debug: capture("debug"),
		},
		registerCli: () => {},
		registerCommand: () => {},
		registerTool: () => {},
		on: () => {},
		registerService: () => {},
	} as unknown as Parameters<typeof plugin.register>[0];
	plugin.register(api);
	return logs;
}

const reminderCalls = (logs: LogCall[]) =>
	logs.filter((c) => c.message.includes("allowConversationAccess"));

test("allowConversationAccess reminder — logs at info, not warn, when an agent_end feature is on", () => {
	const logs = registerWith({
		apiKey: "k",
		userId: "u1",
		hotBuffer: { enabled: true },
	});
	const calls = reminderCalls(logs);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].level, "info");
});

test("allowConversationAccess reminder — silent when no agent_end feature is enabled", () => {
	// emotionalContext / autoTrace / hotBuffer all default to false.
	const logs = registerWith({ apiKey: "k", userId: "u1" });
	assert.equal(reminderCalls(logs).length, 0);
});
```

Notes:
- Filter by `allowConversationAccess` substring rather than counting all calls — `register()` also emits the client-init `log.info` (via `initLogger(api.logger, …)`) and, in other config shapes, the startup-orientation warn.
- `node --test` runs each test file in its own child process, so the `initLogger` module-global set here cannot leak into other test files.

### 2b. `package.json` — register the test file

The `test` script enumerates files explicitly. Append `index.test.ts` to that list.

## Part 3 — Future work: requires OpenClaw core changes (not in this PR)

A real conditional check needs the host to expose hook-grant state. Today, OpenClaw core's typed-hook gate drops the registration with only a host-side warn diagnostic; nothing is returned or thrown to the plugin, and `OpenClawPluginApi` has no introspection surface.

Proposed upstream API (file as a separate issue against `openclaw/openclaw`; local-fork customization is the interim path — do not block this PR on it):

- **Option A (preferred, additive):** `api.hooks.isGranted(hookName: PluginHookName): boolean` — evaluates the same policy the gate uses for the calling plugin's record, without registering anything. Plugin usage would become:

  ```ts
  if (featuresOn && !api.hooks.isGranted("agent_end")) {
  	api.logger.warn("hyperspell: agent_end is NOT granted — set plugins.entries.openclaw-hyperspell.hooks.allowConversationAccess=true or emotionalContext/autoTrace/hotBuffer will do nothing.");
  }
  ```
  i.e., a genuine warn in exactly the misconfigured case, and silence otherwise — the `info` reminder from Part 1 gets deleted.
- **Option B (weaker):** have `api.on()` return a discriminated result (`{ registered: true } | { registered: false; reason: "conversation_access_denied" | ... }`). More invasive (`on` is `void` across the SDK today) and churns every caller; only worth it if core wants registration results generally.

Once either ships, mirror it in this repo's `types/openclaw.d.ts` (the hand-copied SDK surface) and convert the reminder into the real conditional warn. **Do not add the speculative type now** — `types/openclaw.d.ts` exists precisely so calls against non-existent host surface fail to compile; declaring `isGranted` before core ships it would defeat that (this is the same failure mode as the `file_changed` phantom-hook incident documented at the top of that file).

Testing the upstream path (when it lands): extend `index.test.ts`'s mock api with a stubbed `hooks.isGranted` returning `true`/`false` and assert warn-only-when-ungranted in both cases.

## Verification

1. `npm test` — new `index.test.ts` green alongside the existing suite.
2. `npm run check-types` and `npm run lint`.
3. Load `dist/` into a live gateway with `hotBuffer.enabled=true` and the `allowConversationAccess` key present, restart, and confirm the reminder now appears at **info** level (and does not render as a warning) in gateway logs.

## Files touched

- `index.ts` — `api.logger.warn` → `api.logger.info`, reworded message, updated rationale comment
- `index.test.ts` — **new**: register-boundary tests for reminder level and gating
- `package.json` — append `index.test.ts` to the `test` script's file list
