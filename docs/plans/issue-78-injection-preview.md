# Implementation guide — `/previewcontext`: preview the next session's injected bundle (issue #78)

## Goal

A read-only slash command that assembles and prints exactly what the plugin's session-start injection hook **would** inject at the start of the next session — the emotional arc block, the mood-weather *configuration* (never an actual roll), and the startup-orientation blocks — using the same underlying `client` calls and the same block-building functions the real hooks use, with **zero** session-lifecycle side effects.

**⚠️ Verify against `origin/main` before implementing, not the local working tree.** This guide (and #76) were drafted with `before_prompt_build` as the injection hook's name throughout; `origin/main` still registers session-start injectors on `before_agent_start` (`index.ts`) — the rename exists only in the maintainer's uncommitted local WIP. Confirm the actual current hook name/registration before wiring anything, and don't assume other WIP-only surfaces have landed either.

**Command name:** `registerCommand` takes a single flat `name`, so there is no `/hyperspell preview` subcommand form. Use `previewcontext` — it pairs naturally with the existing `getcontext`.

**⚠️ Coordination with issue #73 (dynamic unfinished-loops query) — read before implementing either.** #73 resequences `buildStartupOrientationHandler`'s two fetches (recent-interactions first, then a loops query derived from the recent results) instead of running them in one parallel `Promise.allSettled`. This guide's `gatherOrientation` extraction (Step 1 below) should be built **on top of** #73's resequenced version — extract whatever the handler's fetch+format core actually looks like after #73 lands, not the original parallel-fetch shape shown here. **If #73 hasn't landed yet, land it first**; the `gatherOrientation` sketch below assumes the pre-#73 (parallel, static-query) shape purely because that's what exists today; update it to match #73's resequencing before or during this extraction. Also verify #73's actually-landed loops-search call includes issue #71's `filter: excludeFilterFor(cfg)` clause (a separate coordination note on #71/#73) — it's easy for `gatherOrientation`'s extraction to carry #73's query derivation but silently drop #71's filter if only one of them is checked.

**⚠️ Note: issue #76 (`hyperspell_emotional_arc` tool) exports the same two functions** (`fetchRecentOrLatest`, `buildEmotionalContext`) from `hooks/emotional-state.ts` that this guide's own file-touch list calls for below. Convergent, not conflicting — whichever of #76/#78 lands second finds the exports already in place and skips that part of its own change.

## Architecture decision (read this before coding)

Do **not** invoke `buildEmotionalStateFetchHandler(...)` or `buildStartupOrientationHandler(...)` from the preview. Both handlers mutate module-scoped session state:

- `hooks/emotional-state.ts` — `injectedSessions` Set; the fetch handler adds the sessionKey, which would make the *real* injection skip on the next turn if keys ever collided, and the handler also calls `rollMood` for real.
- `hooks/startup-orientation.ts` — `injectedSessions` + `failedAttempts`, mutated throughout the handler.

Instead, the preview calls the same *pure* fetch/format functions those handlers are composed from. Two of them are currently module-private and need exporting; one small extraction removes handler/preview duplication:

1. **`hooks/emotional-state.ts`** — add `export` to two existing functions (no body changes):
   - `fetchRecentOrLatest(client, cfg)` — the recent-arc-with-fallback fetch.
   - `buildEmotionalContext(states)` — builds the exact `<hyperspell-emotional-context>` block.
   - `looksLikeRawTranscript` is already exported.

2. **`hooks/startup-orientation.ts`** — extract the fetch+format core of `buildStartupOrientationHandler` into one exported function, and export `personalUserId`:

```ts
export type OrientationGather = {
	recentOk: boolean;
	loopsOk: boolean;
	recentCount: number;
	loopsCount: number;
	/** Fully formatted <hyperspell-recent-interactions> block, or null. */
	recentBlock: string | null;
	/** Fully formatted <hyperspell-unfinished-loops> block, or null. */
	loopsBlock: string | null;
	/** Which recent-interactions source was used: "hotBuffer" | "autoTrace" | "none". */
	recentSource: "hotBuffer" | "autoTrace" | "none";
};

export async function gatherOrientation(
	client: HyperspellClient,
	cfg: HyperspellConfig,
	userId: string | undefined,
): Promise<OrientationGather> {
	const so = cfg.startupOrientation;
	const recentSource = cfg.hotBuffer.enabled
		? "hotBuffer" as const
		: cfg.autoTrace.enabled
			? "autoTrace" as const
			: "none" as const;
	const recentFetch =
		recentSource === "hotBuffer"
			? fetchRecentConversations(client, so.recentLimit, userId)
			: recentSource === "autoTrace"
				? fetchRecentTraces(client, isoDaysAgo(so.recentDays), so.recentLimit, userId)
				: Promise.resolve([] as SearchResult[]);

	const [recentSettled, loopsSettled] = await Promise.allSettled([
		recentFetch,
		client.search(so.loopsQuery, { limit: so.loopsLimit, userId }),
	]);
	const recentOk = recentSettled.status === "fulfilled";
	const loopsOk = loopsSettled.status === "fulfilled";
	const recent = recentOk ? recentSettled.value : [];
	const loops = loopsOk ? loopsSettled.value : [];

	const recentBody = formatRecentInteractions(recent);
	const loopsBody = formatUnfinishedLoops(loops);
	return {
		recentOk,
		loopsOk,
		recentCount: recent.length,
		loopsCount: loops.length,
		recentSource,
		recentBlock: recentBody
			? [
					"<hyperspell-recent-interactions>",
					`Your last ${so.recentDays} days of conversations with this user, most-recent-first. Use for situational continuity — don't quote verbatim.`,
					"",
					recentBody,
					"</hyperspell-recent-interactions>",
				].join("\n")
			: null,
		loopsBlock: loopsBody
			? [
					"<hyperspell-unfinished-loops>",
					"Possible open threads — promises made, questions pending, work in progress. Low-confidence retrieval; treat as prompts to consider, not facts to act on.",
					"",
					loopsBody,
					"</hyperspell-unfinished-loops>",
				].join("\n")
			: null,
	};
}
```

Then rewrite the body of `buildStartupOrientationHandler` to keep only its session-lifecycle policy (inject-once cache, retry counting, unknown-sender skip, multi-speaker skip) and delegate fetch+format to `gatherOrientation`. This keeps preview output **byte-identical** to real injection because both paths now share one formatter. Net LOC roughly flat.

## New file: `commands/preview.ts`

The report builder is a standalone exported function (so it's unit-testable without the plugin API), plus the registration glue lives in `commands/slash.ts`.

```ts
import type { HyperspellClient } from "../client.ts"
import type { HyperspellConfig } from "../config.ts"
import { isExcludedChannel } from "../lib/exclude-channels.ts"
import { log } from "../logger.ts"
import {
  buildEmotionalContext,
  fetchRecentOrLatest,
  looksLikeRawTranscript,
} from "../hooks/emotional-state.ts"
import { gatherOrientation, personalUserId } from "../hooks/startup-orientation.ts"

/**
 * Assemble a read-only report of what before_prompt_build WOULD inject at the
 * start of the next session. Calls only the pure fetch/format functions the
 * real hooks are composed from — never the hook handlers themselves — so it
 * cannot touch the inject-once session caches, and it never calls rollMood
 * (a debug command must not consume or reveal a mood roll; the roll happens
 * once, in the real injection path, per session).
 */
export async function buildPreviewReport(
  client: HyperspellClient,
  cfg: HyperspellConfig,
  ctx: { senderId?: string; channel?: string },
): Promise<string> {
  // Quarantined channels get no injected memory of any kind (index.ts guards
  // before_prompt_build with the same check) — report that instead of a bundle.
  if (isExcludedChannel({ channelId: ctx.channel }, cfg)) {
    return "This channel is quarantined (excludeChannels): no context would be injected here and no memory would be written."
  }

  const sections: string[] = []

  // ---- 1. Emotional context (registration order in index.ts: first) ----
  if (!cfg.emotionalContext) {
    sections.push("Emotional context: OFF (emotionalContext=false) — no register/arc would be injected.")
  } else {
    try {
      const states = await fetchRecentOrLatest(client, cfg)
      const usable = states.filter((s) => s.summary && !looksLikeRawTranscript(s.summary))
      if (usable.length > 0) {
        const pending = states.length - usable.length
        const pendingNote =
          pending > 0 ? `\n(${pending} more register(s) still extracting — excluded, same as the real hook.)` : ""
        sections.push(`Emotional context: would inject ${usable.length} register(s):\n\n${buildEmotionalContext(usable)}${pendingNote}`)
      } else if (states.length > 0) {
        sections.push("Emotional context: register(s) exist but are still extracting (raw-transcript placeholder) — the real hook would skip this turn and retry next turn.")
      } else {
        sections.push("Emotional context: ON, but no prior emotional state found — nothing to inject yet (first conversation, or register deleted).")
      }
    } catch (err) {
      log.error("/previewcontext: emotional fetch failed", err)
      sections.push("Emotional context: fetch FAILED — the real hook would log this and inject nothing. Check logs.")
    }

    // Mood weather: report configuration only. Deliberately NOT rolled — see
    // function doc comment. Preview must be idempotent and non-revealing.
    sections.push(
      cfg.moodWeatherChance > 0
        ? `Mood weather: configured chance ${Math.round(cfg.moodWeatherChance * 100)}% per session — NOT rolled by this preview. Each real session rolls independently at injection time; the actual mood (if any) is only observable in the live session.`
        : "Mood weather: OFF (moodWeatherChance=0).",
    )
  }

  // ---- 2. Auto-context (second in registration order) ----
  sections.push(
    cfg.autoContext
      ? "Auto-context: ON — will search memories using the text of your next message. Query-dependent, so not previewable here; use /getcontext <your message> to simulate."
      : "Auto-context: OFF.",
  )

  // ---- 3. Startup orientation (third in registration order) ----
  const so = cfg.startupOrientation
  if (!so.enabled) {
    sections.push("Startup orientation: OFF (startupOrientation.enabled=false).")
  } else {
    const { skip, userId } = personalUserId(cfg, ctx as Record<string, unknown>)
    if (skip) {
      sections.push("Startup orientation: ON, but you are an unknown sender in multi-user mode — the real hook would skip injection for you.")
    } else {
      const g = await gatherOrientation(client, cfg, userId)
      const parts: string[] = []
      if (g.recentSource === "none") {
        parts.push("recent-interactions: no source (hotBuffer and autoTrace both off) — block would be empty.")
      } else if (!g.recentOk) {
        parts.push(`recent-interactions: fetch FAILED (source=${g.recentSource}) — real hook would retry next turn.`)
      } else {
        parts.push(g.recentBlock ?? `recent-interactions: source=${g.recentSource}, 0 results — block omitted.`)
      }
      if (!g.loopsOk) {
        parts.push("unfinished-loops: search FAILED — real hook would retry next turn.")
      } else {
        parts.push(g.loopsBlock ?? `unfinished-loops: 0 results for loopsQuery ("${so.loopsQuery}") — block omitted.`)
      }
      sections.push(`Startup orientation: ON.\n\n${parts.join("\n\n")}`)
    }
  }

  return [
    "What the next session would inject (read-only preview — no session state touched, no mood rolled):",
    "",
    sections.join("\n\n---\n\n"),
  ].join("\n")
}
```

Notes on fidelity choices:

- **Order matches reality.** `index.ts` merges `prependContext` in registration order — emotional-state, auto-context, startup-orientation — so the report presents sections in that order.
- **Quarantine check** reuses `isExcludedChannel`; command contexts carry `channel`, which we pass as `channelId` (the key `channelIdFromCtx` reads first). If the command context's channel value ever differs in shape from hook `channelId`, degrade is safe: unresolvable → "not excluded" → normal preview.
- **Multi-speaker skip** is *not* simulated: it depends on live per-session speaker tracking that a command invocation doesn't share. Acceptable — the preview is about the injection bundle, and mentioning it would require faking a session id. Don't add it.
- **No truncation**: this is a debug command; the operator wants the real payload. The blocks are already bounded by `recentLimit`/`loopsLimit`/`EMOTIONAL_ARC_LIMIT`.

## Registration in `commands/slash.ts`

Append inside `registerCommands` (after the `/sync` block):

```ts
  // /previewcontext - Show what would be injected into the next session
  api.registerCommand({
    name: "previewcontext",
    description: "Preview what Hyperspell would inject at the next session start",
    acceptsArgs: false,
    requireAuth: true,
    handler: async (ctx: { args?: string; senderId?: string; channel?: string }) => {
      log.debug("/previewcontext command")
      try {
        return { text: await buildPreviewReport(client, cfg, ctx) }
      } catch (err) {
        log.error("/previewcontext failed", err)
        return { text: "Failed to build preview. Check logs for details." }
      }
    },
  })
```

Import `buildPreviewReport` from `./preview.ts` at the top of `slash.ts`.

## Unconfigured stub in `index.ts`

The unconfigured branch registers stub versions of every slash command so they show up before setup. Add a fourth stub next to the existing three:

```ts
			api.registerCommand({
				name: "previewcontext",
				description: "Preview what Hyperspell would inject at the next session start",
				acceptsArgs: false,
				requireAuth: false,
				handler: async () => {
					return {
						text: "Hyperspell not configured. Run 'openclaw openclaw-hyperspell setup' first.",
					}
				},
			})
```

## Mood weather — hard rule (explicit callout)

**The preview must never call `rollMood`.** `rollMood` consumes RNG and, more importantly, *reveals* whether/what mood would land. The design contract at the top of `mood-weather.ts` says the mood is UNANNOUNCED and rolled once per injected session; a debug command that rolls (or peeks) breaks both idempotence (two previews would disagree) and the product contract. The preview reports **only** `cfg.moodWeatherChance` as a percentage plus the sentence that it is not rolled here. Do not import anything from `mood-weather.ts` in `preview.ts` — that makes the rule structurally checkable in review.

## Tests — new `commands/preview.test.ts`

There is **no existing `commands/slash.test.ts`** — this is the first test file under `commands/`. Follow the repo's `node:test` + `assert/strict` + fake-client pattern from `hooks/emotional-state.test.ts`. Register it in the `test` script list in `package.json` (the script enumerates files explicitly — append `commands/preview.test.ts`).

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildPreviewReport } from "./preview.ts";

type State = {
	resourceId: string; summary: string; extractedAt: string;
	sessionId: string | null; relationshipId: string | null;
};

function makeClient(opts: {
	arc?: State[] | null;          // getRecentEmotionalStates result
	vaultRows?: Array<{ resourceId: string; title: string | null; metadata: Record<string, unknown> }>;
	loops?: Array<{ resourceId: string; title: string | null; source: string; score: number | null; url: null; createdAt: string | null; highlights: Array<{ text: string; score: number }> }>;
}) {
	const calls = { recent: 0, latest: 0, list: 0, search: 0 };
	const client = {
		calls,
		async getRecentEmotionalStates() { calls.recent++; return opts.arc ?? null; },
		async getEmotionalState() { calls.latest++; return null; },
		async *listMemories() {
			calls.list++;
			for (const row of opts.vaultRows ?? []) yield { source: "vault", ...row };
		},
		async search() { calls.search++; return opts.loops ?? []; },
	};
	return client;
}

const baseCfg = {
	emotionalContext: true,
	moodWeatherChance: 0.08,
	autoContext: false,
	excludeChannels: [],
	relationshipId: "rel-x",
	hotBuffer: { enabled: true },
	autoTrace: { enabled: false },
	startupOrientation: {
		enabled: true, recentDays: 7, recentLimit: 5, loopsLimit: 3,
		loopsQuery: "open tasks pending questions unfinished promised need to follow up",
	},
} as unknown as Parameters<typeof buildPreviewReport>[1];

const st = (summary: string): State => ({
	resourceId: "es-1", summary, extractedAt: "2026-07-01T00:00:00Z",
	sessionId: null, relationshipId: "rel-x",
});

test("preview — shows emotional arc block and configured mood chance without rolling", async () => {
	const client = makeClient({
		arc: [st("Warm and steady lately.")],
		vaultRows: [{ resourceId: "8a1b2c3d-0000-4000-8000-1234567890ab", title: "Budget chat", metadata: {} }],
		loops: [{ resourceId: "m1", title: "Follow up", source: "vault", score: 0.7, url: null, createdAt: null, highlights: [{ text: "promised to send the doc", score: 0.7 }] }],
	});
	const out = await buildPreviewReport(client as never, baseCfg, {});
	assert.ok(out.includes("<hyperspell-emotional-context>"));
	assert.ok(out.includes("Warm and steady lately."));
	assert.ok(out.includes("configured chance 8%"));
	assert.ok(out.includes("NOT rolled"));
	// The roll never happens: the mood override block must never appear.
	assert.ok(!out.includes("<hyperspell-mood-weather>"));
	assert.ok(out.includes("<hyperspell-recent-interactions>"));
	assert.ok(out.includes("Budget chat"));
	assert.ok(out.includes("<hyperspell-unfinished-loops>"));
	assert.ok(out.includes("promised to send the doc"));
});

test("preview — is idempotent: repeated calls re-fetch (no inject-once caching)", async () => {
	const client = makeClient({ arc: [st("Warm.")] });
	await buildPreviewReport(client as never, baseCfg, {});
	await buildPreviewReport(client as never, baseCfg, {});
	assert.equal(client.calls.recent, 2, "preview must not consult/populate session caches");
});

test("preview — emotionalContext off says so plainly and makes no emotional fetch", async () => {
	const client = makeClient({ arc: [st("Warm.")] });
	const cfg = { ...baseCfg, emotionalContext: false } as typeof baseCfg;
	const out = await buildPreviewReport(client as never, cfg, {});
	assert.ok(out.includes("Emotional context: OFF"));
	assert.equal(client.calls.recent + client.calls.latest, 0);
	assert.ok(!out.includes("Mood weather:"), "mood weather is gated on emotionalContext, like the real hook");
});

test("preview — no prior registers reports empty state, not an error", async () => {
	const client = makeClient({ arc: [] });
	const out = await buildPreviewReport(client as never, baseCfg, {});
	assert.ok(out.includes("no prior emotional state"));
});

test("preview — pending (raw-transcript) register reported as still extracting", async () => {
	const client = makeClient({ arc: [st("user: hello\nassistant: hi")] });
	const out = await buildPreviewReport(client as never, baseCfg, {});
	assert.ok(out.includes("still extracting"));
	assert.ok(!out.includes("<hyperspell-emotional-context>"));
});

test("preview — quarantined channel short-circuits with zero client calls", async () => {
	const client = makeClient({ arc: [st("Warm.")] });
	const cfg = { ...baseCfg, excludeChannels: ["dnd-123"] } as typeof baseCfg;
	const out = await buildPreviewReport(client as never, cfg, { channel: "dnd-123" });
	assert.ok(out.includes("quarantined"));
	assert.equal(client.calls.recent + client.calls.list + client.calls.search, 0);
});

test("preview — orientation with no source names the gap", async () => {
	const client = makeClient({ arc: [st("Warm.")] });
	const cfg = {
		...baseCfg,
		hotBuffer: { enabled: false },
		autoTrace: { enabled: false },
	} as typeof baseCfg;
	const out = await buildPreviewReport(client as never, cfg, {});
	assert.ok(out.includes("no source (hotBuffer and autoTrace both off)"));
});
```

If `emotionalContext: false` but `moodWeatherChance > 0`: note that the mood line is inside the `emotionalContext` branch — that matches the real hook, where `buildEmotionalStateFetchHandler` (and thus the roll) is only registered when `cfg.emotionalContext` is true.

## Manual verification (matches the issue's test plan)

1. On a configured install, send `/previewcontext` — capture the report.
2. Start a fresh session with OpenClaw's `/trace on` and compare the injected `<hyperspell-emotional-context>` / `<hyperspell-recent-interactions>` / `<hyperspell-unfinished-loops>` blocks against the preview. They should match byte-for-byte **except**: (a) a `<hyperspell-mood-weather>` block may appear in the live session only (the preview declared the chance instead), and (b) relative timestamps ("3h ago") may drift if time passed between the two.
3. Send `/previewcontext` twice in a row — outputs identical (modulo relative-time drift), proving no roll and no cache mutation.
4. Repeat on an unconfigured install — expect the setup-required stub text.

## Docs

Add a `### /previewcontext` section to `README.md` next to the existing command docs, including the sentence that mood weather is shown as a configured chance and never rolled by the preview.

## Files touched

- `commands/preview.ts` — **new**: `buildPreviewReport` (pure, testable report builder).
- `commands/preview.test.ts` — **new**: node:test suite above.
- `commands/slash.ts` — register `/previewcontext` inside `registerCommands`; import `buildPreviewReport`.
- `hooks/emotional-state.ts` — export `fetchRecentOrLatest` and `buildEmotionalContext`; no behavior change.
- `hooks/startup-orientation.ts` — extract exported `gatherOrientation` from the handler body; export `personalUserId`; handler keeps all session-lifecycle policy and delegates fetch+format.
- `index.ts` — add the unconfigured `previewcontext` stub in the `!hasConfig` branch.
- `package.json` — append `commands/preview.test.ts` to the `test` script's file list.
- `README.md` — document the new command in the slash-commands section.
