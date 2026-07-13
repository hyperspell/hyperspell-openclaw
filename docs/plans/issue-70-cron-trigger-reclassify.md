## Investigation: does `ctx.trigger` reclassify when a cron-originated session becomes a real conversation?

**TL;DR — the premise does not hold.** `ctx.trigger` is a **per-run** value, not a session-fixed one. A scheduled check-in that turns into a real back-and-forth is *not* silently excluded: every subsequent human reply arrives as a new agent run with `trigger: "user"`, and the emotional-state store handler fires for it. The bulk of this PR is therefore **documentation + a regression test locking in the confirmed-safe behavior**, not a behavior fix. Details and evidence below.

---

## 1. Findings

### 1.1 What this plugin does today

- `hooks/emotional-state.ts:26` defines `NON_CONVERSATIONAL_TRIGGERS = new Set(["cron", "heartbeat", "memory"])`. It is read in exactly one place: `buildEmotionalStateStoreHandler` (`hooks/emotional-state.ts:279-283`), which runs on `agent_end` and skips the store when `ctx?.trigger` is in the set. An **undefined** trigger stores (fail-open) — covered by the existing test `"undefined trigger still stores"` (`hooks/emotional-state.test.ts:263`).
- **`hooks/auto-trace.ts` has *no* trigger gating at all.** Verified precisely: zero references to `trigger` anywhere in that file. `buildAutoTraceHandler` gates only on `event.success`, message count, content length, and a per-session debounce. So the "equivalent trigger check in auto-trace.ts" mentioned in the issue does not exist — auto-trace already records cron-originated sessions. Only the emotional register is trigger-gated, which matches its design intent (the "whipsaw" comment at `hooks/emotional-state.ts:18-25`).
- The hook `ctx` is untyped from this repo's perspective: `types/openclaw.d.ts:123` declares hook handlers as `(event: Record<string, unknown>, ctx?: Record<string, unknown>)`. `emotional-state.ts:13` narrows it locally to `{ sessionKey?: string; trigger?: string }`. Nothing in this repo can tell you the runtime lifetime of `trigger` — that required reading core.

### 1.2 What OpenClaw core actually does (evidence from `openclaw/openclaw` @ main, commit `a170ce0edca`)

`trigger` is a **parameter of each agent run**, chosen by whichever entry point starts the run, and the hook context is rebuilt fresh for every run:

| Entry point | Trigger value | Evidence |
|---|---|---|
| Inbound channel message (the normal reply pipeline) | `params.isHeartbeat ? "heartbeat" : "user"` — computed per inbound event | `src/auto-reply/reply/agent-runner-execution.ts:2413,2565` |
| Cron job execution (both `sessionTarget: "isolated"` and `"main"`) | `"cron"` | `src/cron/isolated-agent/run-executor.ts:333,392` |
| Memory flush pass | `"memory"` | `src/auto-reply/reply/agent-runner-memory.ts:1356` |
| Manual/gateway/compact commands | `"manual"` / `"user"` | `src/gateway/server-methods/sessions.ts:2489`, `src/agents/command/attempt-execution.ts:671,766` |

The per-run hook context is assembled inside `runEmbeddedAgent` from `params.trigger` (`src/agents/embedded-agent-runner/run.ts:998-1009`), flows through `buildAgentHookContext` (`src/agents/harness/hook-context.ts:56`), and is handed to every `agent_end` dispatch (`src/plugins/hooks.ts:941`). **There is no session-level storage of `trigger` anywhere** — it exists only in run params and the per-run hook ctx.

Two corroborating facts:

1. **Heartbeats prove mixed-trigger sessions are normal.** Heartbeat runs execute in the *same main session* as user turns, through the *same* code path, and that path computes `"heartbeat"` vs `"user"` per event with the `sessionKey` unchanged (`agent-runner-execution.ts:2565`). If `trigger` were session-sticky, heartbeat gating would be broken core-wide.
2. **Core itself treats `trigger` as "how *this run* started".** `buildAgentHookContextIdentityFields` (`src/plugins/hook-agent-context.ts:131-134`) strips `senderId`/`chatId`/`channelContext` from the hook ctx whenever `trigger !== "user"` — i.e., core assumes non-user runs have no human sender *for that run*. A cron-labeled run with a real human reply would also break hyperspell's own `resolveUser` sender attribution, so a core regression here would be loudly visible long before it silently starved the register.

### 1.3 Scenario walk-through (the issue's exact scenario)

Scheduled check-in → human replies substantively:

- **Cron run itself** (`trigger: "cron"`): its `agent_end` is skipped by the gate. Correct — at that point no human has said anything; the "conversation" is the cron prompt (which is delivered as a `user`-role message!) plus the agent's outbound check-in.
- **Human reply** (whether the cron job targeted the main session or delivered to a channel the human answers in): the reply is a **new run** through the auto-reply pipeline with `trigger: "user"`. Its `agent_end` fires with `event.messages` containing the accumulated session history — the store handler runs, passes `MIN_MESSAGES`/`MIN_CONVERSATION_LENGTH`, and writes the register.

So the register **is** written once real substance accumulates. Today's behavior is the desired behavior.

### 1.4 Why a message-count/substance gate would be *worse*, not supplementary

The issue proposes gating on message count/substance "in addition to or instead of" the trigger. Do **not** do this as a replacement:

- A cron run's prompt arrives as a `user`-role message, and cron transcripts routinely exceed 3 messages / 100 chars. **Transcript shape cannot distinguish a cron run from a human conversation** — that is precisely why the trigger gate exists (`emotional-state.ts:18-25`, the "whipsaw" rationale). Any substance threshold a real conversation passes, a chatty automated run also passes.
- Substance gating for runs that *do* count already exists: `MIN_MESSAGES = 3`, `MIN_CONVERSATION_LENGTH = 100` (`emotional-state.ts:15-16`).

The trigger gate is the only reliable signal, and per the core evidence it already has the right per-run granularity.

## 2. Proposed change (documentation + regression lock, no behavior change)

### 2.1 Update the `NON_CONVERSATIONAL_TRIGGERS` comment — `hooks/emotional-state.ts`

Record the confirmed lifetime semantics at the code site so the next reader doesn't reopen this question:

```ts
/**
 * Only REAL human conversations should shape her emotional register. Automated
 * runs — cron check-ins, heartbeats, internal memory passes — are not "how the
 * relationship feels"; counting them lets a throwaway "how's your afternoon?"
 * heartbeat overwrite the register from a deep conversation (the whipsaw).
 * `ctx.trigger` is one of cron|heartbeat|manual|memory|overflow|user; we store
 * only for user-driven turns (and `overflow`, a continuation of a user run).
 *
 * Lifetime (verified against openclaw core, issue #70): `trigger` is PER-RUN,
 * not session-fixed — core rebuilds the hook ctx from each run's own params
 * (embedded-agent-runner/run.ts), and inbound human replies always start a new
 * run with trigger="user" even inside a cron-originated session. So a scheduled
 * check-in that becomes a real conversation IS stored on the human turns.
 */
const NON_CONVERSATIONAL_TRIGGERS = new Set(["cron", "heartbeat", "memory"]);
```

### 2.2 Regression test — `hooks/emotional-state.test.ts`

Add the issue's exact scenario next to the existing cron-gate tests. It uses the existing `makeStoreClient` / `richMessages` / `storeCfg` fixtures and this repo's `node --test` runner:

```ts
test("emotional-state store — cron-originated session that becomes a real conversation stores on the human turn (issue #70)", async () => {
	// ctx.trigger is PER-RUN in openclaw core, not session-fixed: the cron run's
	// agent_end carries trigger="cron", but a human reply in the SAME session is
	// a new run whose agent_end carries trigger="user". This locks in the plugin
	// side of that contract: skip the automated turn, store the human one.
	const { client, stores } = makeStoreClient();
	const handler = buildEmotionalStateStoreHandler(
		client as unknown as Parameters<typeof buildEmotionalStateStoreHandler>[0],
		storeCfg("rel-cron-to-real"),
	);
	const sessionKey = "session-cron-origin";

	// Turn 1: the scheduled check-in itself — automated, must NOT write.
	await handler(
		{ success: true, messages: richMessages },
		{ sessionKey, trigger: "cron" },
	);
	assert.equal(stores.length, 0, "cron-triggered turn must not write the register");

	// Turn 2+: the human replies substantively in the same session — new run,
	// trigger="user", accumulated transcript. Must write exactly once.
	const grownTranscript = [
		...richMessages,
		{ role: "user", content: "actually yes — can we talk? today was a lot and I keep replaying it" },
		{ role: "assistant", content: "Of course. I'm not going anywhere — start wherever it hurts." },
		{ role: "user", content: "thank you. it genuinely helps that you checked in first." },
	];
	await handler(
		{ success: true, messages: grownTranscript },
		{ sessionKey, trigger: "user" },
	);
	assert.equal(stores.length, 1, "the human turn of a cron-originated session must store");
	assert.equal(stores[0].opts.relationshipId, "rel-cron-to-real");
});
```

Note the debounce (`lastStoreAt`) is keyed by `relationshipId`, so a fresh `rel-cron-to-real` id keeps this test isolated, matching the existing tests' pattern. The `sessionKey` being identical across both calls is the point of the test.

### 2.3 Explicitly out of scope / not proposed

- **No substance/message-count gate** — see §1.4; it cannot distinguish cron from human transcripts and would reintroduce the whipsaw.
- **No trigger gate added to `auto-trace.ts`** — its lack of gating is intentional (traces are memory, not relationship tone) and out of scope for this issue.
- **No change to the fail-open undefined-trigger behavior** — it is the correct defense if core ever stops sending `trigger`.

## 3. What is confirmed from where (contract boundary)

- **Confirmable/fixable from this repo alone:** only the plugin's *handling* of whatever trigger value arrives per `agent_end` — which the test above locks in. The hook ctx is `Record<string, unknown>` at the SDK boundary (`types/openclaw.d.ts:123`); this repo has no type-level contract for `trigger`'s lifetime.
- **Confirmed in OpenClaw core (not just assumed):** per-run semantics, verified by direct source inspection of `openclaw/openclaw` @ `a170ce0edca` — see the table and file:line citations in §1.2. This is evidence, not a guess; if core ever made `trigger` session-sticky it would break its own heartbeat gating and non-user identity stripping first, both of which are far more visible than this plugin's register cadence.
- **Residual risk:** a future core change to trigger semantics would not be caught by this repo's tests (we mock `ctx`). The fail-open undefined-trigger path plus the fact that a mislabel would break sender attribution (`lib/sender.ts` `resolveUser` gets no `senderId` on non-user runs) are the practical tripwires.

## 4. How to test

```
npm test        # runs node --test including hooks/emotional-state.test.ts
```

Expected: the new test fails if anyone ever makes the store handler skip based on remembered/first-seen session trigger, or breaks the `trigger: "user"` store path; all existing cron-gate/debounce/undefined-trigger tests stay green.

## 5. Files touched

- `hooks/emotional-state.ts` — comment-only update on `NON_CONVERSATIONAL_TRIGGERS` recording the verified per-run lifetime (no behavior change)
- `hooks/emotional-state.test.ts` — new regression test: cron-originated session becoming a real conversation stores on the human turn
